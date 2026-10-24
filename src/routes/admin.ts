import express from "express";
import { and, desc, eq, gt, ilike, isNotNull, like, or, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/index.js";
import { assignments, auditLog, classes, enrollments, submissions } from "../db/schema/app.js";
import { session, user, verification } from "../db/schema/auth.js";
import { requireRole, requireSession } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { failWith } from "../lib/http.js";

/**
 * Admin-only account management: approve teacher requests, change roles, suspend accounts,
 * read the audit log. This is the ONLY place (besides scripts/create-admin.ts) where a role
 * can change, because the client is not allowed to write `role` at all.
 */
const router = express.Router();
router.use(requireSession, requireRole("admin"));

const ROLES = ["student", "teacher", "admin"] as const;
type Role = (typeof ROLES)[number];

const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
    const n = parseInt(String(value), 10);
    return Math.min(Math.max(Number.isFinite(n) ? n : fallback, min), max);
};

const accountColumns = {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image,
    role: user.role,
    status: user.status,
    teacherRequestedAt: user.teacherRequestedAt,
    teacherRequestNote: user.teacherRequestNote,
    createdAt: user.createdAt,
    // Raw, fully-qualified SQL on purpose: in a single-table select Drizzle drops table prefixes from
    // column references, which would turn this into `"teacher_id" = "id"` and compare against classes.id.
    classesTaught: sql<number>`(select count(*) from "classes" where "classes"."teacher_id" = "user"."id")`,
};

// Headline numbers for the sidebar badge and the admin dashboard
router.get("/summary", async (_req, res) => {
    try {
        const [row] = await db
            .select({
                pendingRequests: sql<number>`count(*) filter (where ${user.teacherRequestedAt} is not null and ${user.role} = 'student')`,
                admins: sql<number>`count(*) filter (where ${user.role} = 'admin')`,
                suspended: sql<number>`count(*) filter (where ${user.status} = 'suspended')`,
            })
            .from(user);
        res.status(200).json({
            data: {
                pendingRequests: Number(row?.pendingRequests ?? 0),
                admins: Number(row?.admins ?? 0),
                suspended: Number(row?.suspended ?? 0),
            },
        });
    } catch (error) {
        console.error("GET /admin/summary error:", error);
        failWith(res, error, "Failed to load summary");
    }
});

// People list. `requests=true` narrows it to pending teacher requests (oldest first).
router.get("/users", async (req, res) => {
    try {
        const page = clampInt(req.query.page, 1, 1, 10_000);
        const limit = clampInt(req.query.limit, 20, 1, 100);
        const search = String(req.query.search ?? "").trim().slice(0, 60);
        const role = ROLES.find((r) => r === req.query.role);
        const status = req.query.status === "suspended" ? "suspended" : req.query.status === "active" ? "active" : undefined;
        const onlyRequests = req.query.requests === "true";

        const pattern = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
        const where = and(
            search ? or(ilike(user.name, pattern), ilike(user.email, pattern)) : undefined,
            role ? eq(user.role, role) : undefined,
            status ? eq(user.status, status) : undefined,
            onlyRequests ? and(isNotNull(user.teacherRequestedAt), eq(user.role, "student")) : undefined
        );

        const [rows, [totalRow]] = await Promise.all([
            db
                .select(accountColumns)
                .from(user)
                .where(where)
                .orderBy(onlyRequests ? user.teacherRequestedAt : desc(user.createdAt))
                .limit(limit)
                .offset((page - 1) * limit),
            db.select({ count: sql<number>`count(*)` }).from(user).where(where),
        ]);

        const total = Number(totalRow?.count ?? 0);
        res.status(200).json({
            data: rows.map((r) => ({ ...r, classesTaught: Number(r.classesTaught) })),
            pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
        });
    } catch (error) {
        console.error("GET /admin/users error:", error);
        failWith(res, error, "Failed to load people");
    }
});

const loadTarget = async (id: string) => {
    const [row] = await db
        .select({ id: user.id, name: user.name, email: user.email, role: user.role, status: user.status, requested: user.teacherRequestedAt })
        .from(user)
        .where(eq(user.id, id));
    return row;
};

// One person in detail: everything an admin needs before changing their access.
router.get("/users/:id", async (req, res) => {
    try {
        const id = String(req.params.id);
        const [person] = await db.select(accountColumns).from(user).where(eq(user.id, id));
        if (!person) return res.status(404).json({ error: "User not found." });

        const count = (q: Promise<{ n: number }[]>) => q.then((r) => Number(r[0]?.n ?? 0));
        const [enrolled, submitted, graded, sessionRow, history] = await Promise.all([
            count(db.select({ n: sql<number>`count(*)` }).from(enrollments).where(eq(enrollments.studentId, id))),
            count(db.select({ n: sql<number>`count(*)` }).from(submissions).where(eq(submissions.studentId, id))),
            count(db.select({ n: sql<number>`count(*)` }).from(submissions).where(and(eq(submissions.studentId, id), isNotNull(submissions.marks)))),
            db
                .select({
                    lastActive: sql<Date | null>`max(${session.updatedAt})`,
                    activeSessions: sql<number>`count(*) filter (where ${session.expiresAt} > now())`,
                })
                .from(session)
                .where(eq(session.userId, id)),
            db
                .select({ id: auditLog.id, action: auditLog.action, detail: auditLog.detail, createdAt: auditLog.createdAt })
                .from(auditLog)
                .where(eq(auditLog.targetId, id))
                .orderBy(desc(auditLog.createdAt))
                .limit(8),
        ]);

        // Teachers: assignments across their classes
        const [assignmentRow] = person.role === "teacher"
            ? await db
                .select({ n: sql<number>`count(*)` })
                .from(assignments)
                .innerJoin(classes, eq(assignments.classId, classes.id))
                .where(eq(classes.teacherId, id))
            : [{ n: 0 }];

        res.status(200).json({
            data: {
                ...person,
                classesTaught: Number(person.classesTaught),
                enrolledClasses: enrolled,
                submissions: submitted,
                gradedSubmissions: graded,
                assignmentsCreated: Number(assignmentRow?.n ?? 0),
                lastActive: sessionRow[0]?.lastActive ?? null,
                activeSessions: Number(sessionRow[0]?.activeSessions ?? 0),
                history,
            },
        });
    } catch (error) {
        console.error("GET /admin/users/:id error:", error);
        failWith(res, error, "Failed to load user");
    }
});

// ---------------------------------------------------------------------------
// Password resets without email
// Better Auth stores each reset request as a `verification` row (identifier
// "reset-password:<token>", value = user id). Admins can see who asked and hand over a link.
// ---------------------------------------------------------------------------
router.get("/reset-requests", async (_req, res) => {
    try {
        const rows = await db
            .select({
                userId: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                requestedAt: verification.createdAt,
                expiresAt: verification.expiresAt,
            })
            .from(verification)
            .innerJoin(user, eq(verification.value, user.id))
            .where(and(like(verification.identifier, "reset-password:%"), gt(verification.expiresAt, new Date())))
            .orderBy(desc(verification.createdAt))
            .limit(50);
        res.status(200).json({ data: rows });
    } catch (error) {
        console.error("GET /admin/reset-requests error:", error);
        failWith(res, error, "Failed to load reset requests");
    }
});

// Issue a one-hour reset link for a student or teacher. Admin accounts are excluded on purpose:
// letting one admin mint a login link for another would be an account-takeover path.
// (Admin passwords are reset with `npm run create-admin`, which needs database access.)
router.post("/users/:id/reset-link", async (req, res) => {
    try {
        const target = await loadTarget(String(req.params.id));
        if (!target) return res.status(404).json({ error: "User not found." });
        if (target.role === "admin") {
            return res.status(409).json({
                error: "Conflict",
                message: "Admin passwords can not be reset from the app. Run `npm run create-admin` with ADMIN_PASSWORD on the server.",
            });
        }

        const token = randomBytes(18).toString("base64url");
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
        await db.transaction(async (tx) => {
            await tx.insert(verification).values({ id: randomBytes(12).toString("hex"), identifier: `reset-password:${token}`, value: target.id, expiresAt });
            await recordAudit(tx, {
                actorId: req.user!.id,
                action: "password_reset_link_issued",
                targetId: target.id,
                detail: { name: target.name, email: target.email },
            });
        });

        const base = (process.env.FRONTEND_URL ?? "").replace(/\/$/, "");
        res.status(201).json({ data: { url: `${base}/reset-password?token=${token}`, expiresAt } });
    } catch (error) {
        console.error("POST /admin/users/:id/reset-link error:", error);
        failWith(res, error, "Failed to create reset link");
    }
});

// ---------------------------------------------------------------------------
// Teacher requests
// ---------------------------------------------------------------------------
router.post("/teacher-requests/:id/approve", async (req, res) => {
    try {
        const target = await loadTarget(String(req.params.id));
        if (!target) return res.status(404).json({ error: "User not found." });
        if (target.role !== "student" || !target.requested) {
            return res.status(409).json({ error: "Conflict", message: "This user has no pending teacher request." });
        }

        await db.transaction(async (tx) => {
            await tx.update(user).set({ role: "teacher", teacherRequestedAt: null, teacherRequestNote: null }).where(eq(user.id, target.id));
            await recordAudit(tx, {
                actorId: req.user!.id,
                action: "teacher_request_approved",
                targetId: target.id,
                detail: { name: target.name, email: target.email },
            });
        });
        res.status(200).json({ data: { id: target.id, role: "teacher" } });
    } catch (error) {
        console.error("POST /admin/teacher-requests/:id/approve error:", error);
        failWith(res, error, "Failed to approve request");
    }
});

router.post("/teacher-requests/:id/reject", async (req, res) => {
    try {
        const target = await loadTarget(String(req.params.id));
        if (!target) return res.status(404).json({ error: "User not found." });
        if (target.role !== "student" || !target.requested) {
            return res.status(409).json({ error: "Conflict", message: "This user has no pending teacher request." });
        }
        const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 200) : "";

        await db.transaction(async (tx) => {
            await tx.update(user).set({ teacherRequestedAt: null, teacherRequestNote: null }).where(eq(user.id, target.id));
            await recordAudit(tx, {
                actorId: req.user!.id,
                action: "teacher_request_rejected",
                targetId: target.id,
                detail: { name: target.name, email: target.email, ...(reason ? { reason } : {}) },
            });
        });
        res.status(200).json({ data: { id: target.id, role: "student" } });
    } catch (error) {
        console.error("POST /admin/teacher-requests/:id/reject error:", error);
        failWith(res, error, "Failed to reject request");
    }
});

// ---------------------------------------------------------------------------
// Role and status changes
// Self-changes are refused, so the acting admin always remains an active admin:
// the system can never be left without one through this API.
// ---------------------------------------------------------------------------
router.patch("/users/:id/role", async (req, res) => {
    try {
        const nextRole = ROLES.find((r) => r === req.body?.role) as Role | undefined;
        if (!nextRole) return res.status(400).json({ error: "Invalid role", message: "Role must be student, teacher or admin." });

        const target = await loadTarget(String(req.params.id));
        if (!target) return res.status(404).json({ error: "User not found." });
        if (target.id === req.user!.id) {
            return res.status(400).json({ error: "Not allowed", message: "You cannot change your own role." });
        }
        if (target.role === nextRole) return res.status(200).json({ data: { id: target.id, role: nextRole } });

        if (target.role === "teacher") {
            const [owned] = await db.select({ count: sql<number>`count(*)` }).from(classes).where(eq(classes.teacherId, target.id));
            const count = Number(owned?.count ?? 0);
            if (count > 0) {
                return res.status(409).json({
                    error: "Conflict",
                    message: `${target.name} teaches ${count} class${count === 1 ? "" : "es"}. Reassign or delete them before changing this role.`,
                });
            }
        }

        await db.transaction(async (tx) => {
            await tx.update(user).set({ role: nextRole, teacherRequestedAt: null, teacherRequestNote: null }).where(eq(user.id, target.id));
            await recordAudit(tx, {
                actorId: req.user!.id,
                action: "role_changed",
                targetId: target.id,
                detail: { name: target.name, email: target.email, from: target.role, to: nextRole },
            });
        });
        res.status(200).json({ data: { id: target.id, role: nextRole } });
    } catch (error) {
        console.error("PATCH /admin/users/:id/role error:", error);
        failWith(res, error, "Failed to change role");
    }
});

router.patch("/users/:id/status", async (req, res) => {
    try {
        const nextStatus = req.body?.status === "suspended" ? "suspended" : req.body?.status === "active" ? "active" : null;
        if (!nextStatus) return res.status(400).json({ error: "Invalid status", message: "Status must be active or suspended." });

        const target = await loadTarget(String(req.params.id));
        if (!target) return res.status(404).json({ error: "User not found." });
        if (target.id === req.user!.id) {
            return res.status(400).json({ error: "Not allowed", message: "You cannot suspend your own account." });
        }
        if (nextStatus === "suspended" && target.role === "admin") {
            return res.status(409).json({ error: "Conflict", message: "Change this admin to another role before suspending the account." });
        }
        if (target.status === nextStatus) return res.status(200).json({ data: { id: target.id, status: nextStatus } });

        await db.transaction(async (tx) => {
            await tx.update(user).set({ status: nextStatus }).where(eq(user.id, target.id));
            // Sign them out everywhere right now rather than waiting for the cookie to expire.
            if (nextStatus === "suspended") await tx.delete(session).where(eq(session.userId, target.id));
            await recordAudit(tx, {
                actorId: req.user!.id,
                action: nextStatus === "suspended" ? "account_suspended" : "account_reactivated",
                targetId: target.id,
                detail: { name: target.name, email: target.email },
            });
        });
        res.status(200).json({ data: { id: target.id, status: nextStatus } });
    } catch (error) {
        console.error("PATCH /admin/users/:id/status error:", error);
        failWith(res, error, "Failed to change account status");
    }
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
router.get("/audit", async (req, res) => {
    try {
        const limit = clampInt(req.query.limit, 30, 1, 100);
        const actor = alias(user, "actor");
        const target = alias(user, "target");

        const rows = await db
            .select({
                id: auditLog.id,
                action: auditLog.action,
                detail: auditLog.detail,
                createdAt: auditLog.createdAt,
                actor: { id: actor.id, name: actor.name },
                target: { id: target.id, name: target.name },
            })
            .from(auditLog)
            .leftJoin(actor, eq(auditLog.actorId, actor.id))
            .leftJoin(target, eq(auditLog.targetId, target.id))
            .orderBy(desc(auditLog.createdAt))
            .limit(limit);

        res.status(200).json({ data: rows });
    } catch (error) {
        console.error("GET /admin/audit error:", error);
        failWith(res, error, "Failed to load audit log");
    }
});

export default router;
