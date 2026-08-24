import express from "express";
import { and, desc, eq, getTableColumns, ilike, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { classes, departments, enrollments, subjects } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireSession, requireRole } from "../middleware/auth.js";

const router = express.Router();

// GET all subjects — public, with optional search, filtering and pagination
router.get("/", async (req, res) => {
    try {
        const { search, department, page = 1, limit = 10 } = req.query;

        const currentPage = Math.max(1, parseInt(String(page), 10) || 1);
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 10), 100);
        const offset = (currentPage - 1) * limitPerPage;

        const filterConditions = [];

        if (search) {
            filterConditions.push(
                or(
                    ilike(subjects.name, `%${search}%`),
                    ilike(subjects.code, `%${search}%`)
                )
            );
        }

        if (department) {
            const deptPattern = `%${String(department).replace(/[%_]/g, "\\$&")}%`;
            filterConditions.push(ilike(departments.name, deptPattern));
        }

        const whereClause = filterConditions.length > 0 ? and(...filterConditions) : undefined;

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(subjects)
            .leftJoin(departments, eq(subjects.departmentId, departments.id))
            .where(whereClause);

        const totalCount = countResult[0]?.count ?? 0;

        const subjectsList = await db
            .select({
                ...getTableColumns(subjects),
                department: { ...getTableColumns(departments) },
            })
            .from(subjects)
            .leftJoin(departments, eq(subjects.departmentId, departments.id))
            .where(whereClause)
            .orderBy(desc(subjects.createdAt))
            .limit(limitPerPage)
            .offset(offset);

        res.status(200).json({
            data: subjectsList,
            pagination: {
                page: currentPage,
                limit: limitPerPage,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limitPerPage),
            },
        });
    } catch (e) {
        console.error(`GET /subjects error: ${e}`);
        res.status(500).json({ error: "Failed to get subjects" });
    }
});

// POST create subject — admin only
router.post("/", requireSession, requireRole("admin"), async (req, res) => {
    try {
        const { departmentId, name, code, description } = req.body;

        const deptIdNum = Number(departmentId);
        if (!Number.isFinite(deptIdNum) || deptIdNum <= 0) {
            return res.status(400).json({ error: "Valid departmentId is required" });
        }

        if (!name || typeof name !== "string" || name.trim().length < 3) {
            return res.status(400).json({ error: "Subject name must be at least 3 characters" });
        }

        if (!code || typeof code !== "string" || code.trim().length < 3) {
            return res.status(400).json({ error: "Subject code must be at least 3 characters" });
        }

        // Verify department exists
        const [dept] = await db
            .select({ id: departments.id })
            .from(departments)
            .where(eq(departments.id, deptIdNum));

        if (!dept) {
            return res.status(400).json({ error: "Department not found" });
        }

        const [createdSubject] = await db
            .insert(subjects)
            .values({
                departmentId: deptIdNum,
                name: name.trim(),
                code: code.trim(),
                description: description?.trim() || null,
            })
            .returning({ id: subjects.id });

        if (!createdSubject) throw new Error("Insert failed");

        res.status(201).json({ data: createdSubject });
    } catch (e) {
        console.error(`POST /subjects error: ${e}`);
        res.status(500).json({ error: "Failed to create subject" });
    }
});

// GET subject details with counts — public
router.get("/:id", async (req, res) => {
    try {
        const subjectId = Number(req.params.id);

        if (!Number.isFinite(subjectId)) {
            return res.status(400).json({ error: "Invalid subject id" });
        }

        const [subject] = await db
            .select({
                ...getTableColumns(subjects),
                department: { ...getTableColumns(departments) },
            })
            .from(subjects)
            .leftJoin(departments, eq(subjects.departmentId, departments.id))
            .where(eq(subjects.id, subjectId));

        if (!subject) {
            return res.status(404).json({ error: "Subject not found" });
        }

        const classesCount = await db
            .select({ count: sql<number>`count(*)` })
            .from(classes)
            .where(eq(classes.subjectId, subjectId));

        res.status(200).json({
            data: {
                subject,
                totals: {
                    classes: classesCount[0]?.count ?? 0,
                },
            },
        });
    } catch (e) {
        console.error(`GET /subjects/:id error: ${e}`);
        res.status(500).json({ error: "Failed to get subject" });
    }
});

// List classes in a subject with pagination
router.get("/:id/classes", async (req, res) => {
    try {
        const subjectId = Number(req.params.id);
        const { page = 1, limit = 10 } = req.query;

        if (!Number.isFinite(subjectId)) {
            return res.status(400).json({ error: "Invalid subject id" });
        }

        const currentPage = Math.max(1, +page);
        const limitPerPage = Math.max(1, +limit);
        const offset = (currentPage - 1) * limitPerPage;

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(classes)
            .where(eq(classes.subjectId, subjectId));

        const totalCount = countResult[0]?.count ?? 0;

        const classesList = await db
            .select({
                ...getTableColumns(classes),
                teacher: {
                    ...getTableColumns(user),
                },
            })
            .from(classes)
            .leftJoin(user, eq(classes.teacherId, user.id))
            .where(eq(classes.subjectId, subjectId))
            .orderBy(desc(classes.createdAt))
            .limit(limitPerPage)
            .offset(offset);

        res.status(200).json({
            data: classesList,
            pagination: {
                page: currentPage,
                limit: limitPerPage,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limitPerPage),
            },
        });
    } catch (error) {
        console.error("GET /subjects/:id/classes error:", error);
        res.status(500).json({ error: "Failed to fetch subject classes" });
    }
});

// List users in a subject by role with pagination
router.get("/:id/users", async (req, res) => {
    try {
        const subjectId = Number(req.params.id);
        const { role, page = 1, limit = 10 } = req.query;

        if (!Number.isFinite(subjectId)) {
            return res.status(400).json({ error: "Invalid subject id" });
        }

        if (role !== "teacher" && role !== "student") {
            return res.status(400).json({ error: "Invalid role" });
        }

        const currentPage = Math.max(1, +page);
        const limitPerPage = Math.max(1, +limit);
        const offset = (currentPage - 1) * limitPerPage;

        const baseSelect = {
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
            image: user.image,
            role: user.role,
            imageCldPubId: user.imageCldPubId,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
        };

        const groupByFields = [
            user.id,
            user.name,
            user.email,
            user.emailVerified,
            user.image,
            user.role,
            user.imageCldPubId,
            user.createdAt,
            user.updatedAt,
        ];

        const countResult =
            role === "teacher"
                ? await db
                    .select({ count: sql<number>`count(distinct ${user.id})` })
                    .from(user)
                    .leftJoin(classes, eq(user.id, classes.teacherId))
                    .where(and(eq(user.role, role), eq(classes.subjectId, subjectId)))
                : await db
                    .select({ count: sql<number>`count(distinct ${user.id})` })
                    .from(user)
                    .leftJoin(enrollments, eq(user.id, enrollments.studentId))
                    .leftJoin(classes, eq(enrollments.classId, classes.id))
                    .where(and(eq(user.role, role), eq(classes.subjectId, subjectId)));

        const totalCount = countResult[0]?.count ?? 0;

        const usersList =
            role === "teacher"
                ? await db
                    .select(baseSelect)
                    .from(user)
                    .leftJoin(classes, eq(user.id, classes.teacherId))
                    .where(and(eq(user.role, role), eq(classes.subjectId, subjectId)))
                    .groupBy(...groupByFields)
                    .orderBy(desc(user.createdAt))
                    .limit(limitPerPage)
                    .offset(offset)
                : await db
                    .select(baseSelect)
                    .from(user)
                    .leftJoin(enrollments, eq(user.id, enrollments.studentId))
                    .leftJoin(classes, eq(enrollments.classId, classes.id))
                    .where(and(eq(user.role, role), eq(classes.subjectId, subjectId)))
                    .groupBy(...groupByFields)
                    .orderBy(desc(user.createdAt))
                    .limit(limitPerPage)
                    .offset(offset);

        res.status(200).json({
            data: usersList,
            pagination: {
                page: currentPage,
                limit: limitPerPage,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limitPerPage),
            },
        });
    } catch (error) {
        console.error("GET /subjects/:id/users error:", error);
        res.status(500).json({ error: "Failed to fetch subject users" });
    }
});

// PUT update subject — admin only
router.put("/:id", requireSession, requireRole("admin"), async (req, res) => {
    try {
        const subjectId = Number(req.params.id);

        if (!Number.isFinite(subjectId)) {
            return res.status(400).json({ error: "Invalid subject id" });
        }

        const { departmentId, name, code, description } = req.body;

        const updateData: Record<string, unknown> = {};

        if (departmentId !== undefined) {
            const deptIdNum = Number(departmentId);
            if (!Number.isFinite(deptIdNum) || deptIdNum <= 0) {
                return res.status(400).json({ error: "Valid departmentId is required" });
            }
            updateData.departmentId = deptIdNum;
        }

        if (name !== undefined) {
            if (typeof name !== "string" || name.trim().length < 3) {
                return res.status(400).json({ error: "Subject name must be at least 3 characters" });
            }
            updateData.name = name.trim();
        }

        if (code !== undefined) {
            if (typeof code !== "string" || code.trim().length < 3) {
                return res.status(400).json({ error: "Subject code must be at least 3 characters" });
            }
            updateData.code = code.trim();
        }

        if (description !== undefined) {
            updateData.description = typeof description === "string" ? description.trim() : null;
        }

        const [updated] = await db
            .update(subjects)
            .set(updateData)
            .where(eq(subjects.id, subjectId))
            .returning({ id: subjects.id });

        if (!updated) {
            return res.status(404).json({ error: "Subject not found" });
        }

        res.status(200).json({ data: updated });
    } catch (e) {
        console.error(`PUT /subjects/:id error: ${e}`);
        res.status(500).json({ error: "Failed to update subject" });
    }
});

// DELETE subject — admin only
router.delete("/:id", requireSession, requireRole("admin"), async (req, res) => {
    try {
        const subjectId = Number(req.params.id);

        if (!Number.isFinite(subjectId)) {
            return res.status(400).json({ error: "Invalid subject id" });
        }

        const [deleted] = await db
            .delete(subjects)
            .where(eq(subjects.id, subjectId))
            .returning({ id: subjects.id });

        if (!deleted) {
            return res.status(404).json({ error: "Subject not found" });
        }

        res.status(200).json({ data: deleted });
    } catch (e) {
        console.error(`DELETE /subjects/:id error: ${e}`);
        res.status(500).json({ error: "Failed to delete subject" });
    }
});

export default router;