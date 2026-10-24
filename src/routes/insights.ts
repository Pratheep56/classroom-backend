import express from "express";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { assignments, classes, enrollments, subjects, submissions } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireRole, requireSession } from "../middleware/auth.js";

/**
 * "Insights" = read-only, role-aware aggregates built from the existing tables
 * (no schema changes): grading queue, upcoming deadlines, gradebook, class analytics, search.
 */
const router = express.Router();

const MAX_LIMIT = 50;
const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
    const n = parseInt(String(value), 10);
    return Math.min(Math.max(Number.isFinite(n) ? n : fallback, min), max);
};

const percent = (earned: number, possible: number) =>
    possible > 0 ? Math.round((earned / possible) * 100) : null;

/** Class ids the caller may see: null means "all classes" (admin). */
const scopedClassIds = async (userId: string, role: "admin" | "teacher" | "student"): Promise<number[] | null> => {
    if (role === "admin") return null;
    if (role === "teacher") {
        const rows = await db.select({ id: classes.id }).from(classes).where(eq(classes.teacherId, userId));
        return rows.map((r) => r.id);
    }
    const rows = await db
        .select({ id: enrollments.classId })
        .from(enrollments)
        .where(eq(enrollments.studentId, userId));
    return rows.map((r) => r.id);
};

// ---------------------------------------------------------------------------
// Grading queue: ungraded submissions, oldest first (teacher: own classes, admin: all)
// ---------------------------------------------------------------------------
router.get("/grading-queue", requireSession, requireRole("teacher", "admin"), async (req, res) => {
    try {
        const limit = clampInt(req.query.limit, 10, 1, MAX_LIMIT);
        const ownerFilter = req.user!.role === "teacher" ? eq(classes.teacherId, req.user!.id) : undefined;
        const where = and(isNull(submissions.marks), ownerFilter);

        const [items, [totalRow]] = await Promise.all([
            db
                .select({
                    submissionId: submissions.id,
                    submittedAt: submissions.submittedAt,
                    hasText: sql<boolean>`${submissions.content} is not null and length(trim(${submissions.content})) > 0`,
                    attachmentFileName: submissions.attachmentFileName,
                    assignment: {
                        id: assignments.id,
                        title: assignments.title,
                        dueDate: assignments.dueDate,
                        maxMarks: assignments.maxMarks,
                    },
                    class: { id: classes.id, name: classes.name },
                    student: { id: user.id, name: user.name, image: user.image },
                })
                .from(submissions)
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .innerJoin(classes, eq(assignments.classId, classes.id))
                .innerJoin(user, eq(submissions.studentId, user.id))
                .where(where)
                .orderBy(asc(submissions.submittedAt))
                .limit(limit),
            db
                .select({ count: sql<number>`count(*)` })
                .from(submissions)
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .innerJoin(classes, eq(assignments.classId, classes.id))
                .where(where),
        ]);

        const now = Date.now();
        res.status(200).json({
            data: {
                total: Number(totalRow?.count ?? 0),
                items: items.map((i) => ({
                    ...i,
                    isLate: new Date(i.submittedAt).getTime() > new Date(i.assignment.dueDate).getTime(),
                    waitingDays: Math.floor((now - new Date(i.submittedAt).getTime()) / 86_400_000),
                })),
            },
        });
    } catch (error) {
        console.error("GET /insights/grading-queue error:", error);
        res.status(500).json({ error: "Failed to fetch grading queue" });
    }
});

// ---------------------------------------------------------------------------
// Upcoming deadlines (all roles, scoped to the caller's classes)
// ---------------------------------------------------------------------------
router.get("/deadlines", requireSession, async (req, res) => {
    try {
        const days = clampInt(req.query.days, 14, 1, 90);
        const limit = clampInt(req.query.limit, 8, 1, MAX_LIMIT);
        const { id: userId, role } = req.user!;

        const classIds = await scopedClassIds(userId, role);
        if (classIds && classIds.length === 0) return res.status(200).json({ data: [] });

        const now = new Date();
        const until = new Date(now.getTime() + days * 86_400_000);

        const rows = await db
            .select({
                id: assignments.id,
                title: assignments.title,
                dueDate: assignments.dueDate,
                maxMarks: assignments.maxMarks,
                class: { id: classes.id, name: classes.name },
                submissionsCount: sql<number>`(select count(*) from ${submissions} where ${submissions.assignmentId} = ${assignments.id})`,
                totalStudents: sql<number>`(select count(*) from ${enrollments} where ${enrollments.classId} = ${assignments.classId})`,
            })
            .from(assignments)
            .innerJoin(classes, eq(assignments.classId, classes.id))
            .where(
                and(
                    gte(assignments.dueDate, now),
                    lte(assignments.dueDate, until),
                    classIds ? inArray(assignments.classId, classIds) : undefined
                )
            )
            .orderBy(asc(assignments.dueDate))
            .limit(limit);

        let submittedIds = new Set<number>();
        if (role === "student" && rows.length > 0) {
            const mine = await db
                .select({ assignmentId: submissions.assignmentId })
                .from(submissions)
                .where(
                    and(
                        eq(submissions.studentId, userId),
                        inArray(submissions.assignmentId, rows.map((r) => r.id))
                    )
                );
            submittedIds = new Set(mine.map((m) => m.assignmentId));
        }

        res.status(200).json({
            data: rows.map((r) => ({
                ...r,
                submissionsCount: Number(r.submissionsCount),
                totalStudents: Number(r.totalStudents),
                hoursLeft: Math.max(0, Math.round((new Date(r.dueDate).getTime() - now.getTime()) / 3_600_000)),
                ...(role === "student" ? { submitted: submittedIds.has(r.id) } : {}),
            })),
        });
    } catch (error) {
        console.error("GET /insights/deadlines error:", error);
        res.status(500).json({ error: "Failed to fetch deadlines" });
    }
});

// ---------------------------------------------------------------------------
// Student gradebook: per-class and overall performance for the logged-in student
// ---------------------------------------------------------------------------
router.get("/gradebook", requireSession, requireRole("student"), async (req, res) => {
    try {
        const studentId = req.user!.id;

        const rows = await db
            .select({
                classId: classes.id,
                className: classes.name,
                subjectName: subjects.name,
                assignmentId: assignments.id,
                title: assignments.title,
                dueDate: assignments.dueDate,
                maxMarks: assignments.maxMarks,
                submittedAt: submissions.submittedAt,
                marks: submissions.marks,
                feedback: submissions.feedback,
            })
            .from(enrollments)
            .innerJoin(classes, eq(enrollments.classId, classes.id))
            .leftJoin(subjects, eq(classes.subjectId, subjects.id))
            .leftJoin(assignments, eq(assignments.classId, classes.id))
            .leftJoin(
                submissions,
                and(eq(submissions.assignmentId, assignments.id), eq(submissions.studentId, studentId))
            )
            .where(eq(enrollments.studentId, studentId));

        const now = Date.now();
        type ClassBook = {
            classId: number;
            className: string;
            subjectName: string | null;
            totalAssignments: number;
            submitted: number;
            graded: number;
            late: number;
            missing: number;
            pending: number;
            earned: number;
            possible: number;
            /** Marks still to be earned: assignments that are upcoming or submitted but not graded yet. */
            remaining: number;
        };
        const books = new Map<number, ClassBook>();
        const recentGrades: Array<{
            assignmentId: number;
            title: string;
            className: string;
            marks: number;
            maxMarks: number;
            feedback: string | null;
            submittedAt: Date;
        }> = [];

        for (const r of rows) {
            let book = books.get(r.classId);
            if (!book) {
                book = {
                    classId: r.classId,
                    className: r.className,
                    subjectName: r.subjectName,
                    totalAssignments: 0,
                    submitted: 0,
                    graded: 0,
                    late: 0,
                    missing: 0,
                    pending: 0,
                    earned: 0,
                    possible: 0,
                    remaining: 0,
                };
                books.set(r.classId, book);
            }
            if (r.assignmentId === null) continue; // enrolled in a class with no assignments yet

            book.totalAssignments++;
            const due = new Date(r.dueDate!).getTime();

            if (!r.submittedAt) {
                if (now > due) book.missing++;
                else {
                    book.pending++;
                    book.remaining += r.maxMarks!;
                }
                continue;
            }
            book.submitted++;
            if (r.marks === null) book.remaining += r.maxMarks!;
            if (new Date(r.submittedAt).getTime() > due) book.late++;
            if (r.marks !== null) {
                book.graded++;
                book.earned += r.marks;
                book.possible += r.maxMarks!;
                recentGrades.push({
                    assignmentId: r.assignmentId,
                    title: r.title!,
                    className: r.className,
                    marks: r.marks,
                    maxMarks: r.maxMarks!,
                    feedback: r.feedback,
                    submittedAt: r.submittedAt,
                });
            }
        }

        const classBooks = [...books.values()].map((b) => ({
            ...b,
            averagePercent: percent(b.earned, b.possible),
        }));
        const totals = classBooks.reduce(
            (t, b) => ({
                earned: t.earned + b.earned,
                possible: t.possible + b.possible,
                remaining: t.remaining + b.remaining,
                graded: t.graded + b.graded,
                submitted: t.submitted + b.submitted,
                missing: t.missing + b.missing,
                pending: t.pending + b.pending,
                late: t.late + b.late,
                totalAssignments: t.totalAssignments + b.totalAssignments,
            }),
            { earned: 0, possible: 0, remaining: 0, graded: 0, submitted: 0, missing: 0, pending: 0, late: 0, totalAssignments: 0 }
        );

        res.status(200).json({
            data: {
                overall: { ...totals, averagePercent: percent(totals.earned, totals.possible) },
                classes: classBooks.sort((a, b) => (b.averagePercent ?? -1) - (a.averagePercent ?? -1)),
                recentGrades: recentGrades
                    .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime())
                    .slice(0, 5),
            },
        });
    } catch (error) {
        console.error("GET /insights/gradebook error:", error);
        res.status(500).json({ error: "Failed to fetch gradebook" });
    }
});

// ---------------------------------------------------------------------------
// Workload radar: everything due in the next N weeks (student/teacher: own classes, admin: all).
// The client buckets by local calendar day so time zones stay correct.
// ---------------------------------------------------------------------------
router.get("/workload", requireSession, async (req, res) => {
    try {
        const weeks = clampInt(req.query.weeks, 4, 1, 12);
        const { id: userId, role } = req.user!;

        const classIds = await scopedClassIds(userId, role);
        if (classIds && classIds.length === 0) return res.status(200).json({ data: { items: [] } });

        const now = new Date();
        const until = new Date(now.getTime() + weeks * 7 * 86_400_000);

        const rows = await db
            .select({
                id: assignments.id,
                title: assignments.title,
                dueDate: assignments.dueDate,
                maxMarks: assignments.maxMarks,
                class: { id: classes.id, name: classes.name },
            })
            .from(assignments)
            .innerJoin(classes, eq(assignments.classId, classes.id))
            .where(
                and(
                    gte(assignments.dueDate, now),
                    lte(assignments.dueDate, until),
                    classIds ? inArray(assignments.classId, classIds) : undefined
                )
            )
            .orderBy(asc(assignments.dueDate))
            .limit(200);

        let submittedIds = new Set<number>();
        if (role === "student" && rows.length > 0) {
            const mine = await db
                .select({ assignmentId: submissions.assignmentId })
                .from(submissions)
                .where(
                    and(
                        eq(submissions.studentId, userId),
                        inArray(submissions.assignmentId, rows.map((r) => r.id))
                    )
                );
            submittedIds = new Set(mine.map((m) => m.assignmentId));
        }

        res.status(200).json({
            data: {
                items: rows.map((r) => ({
                    ...r,
                    ...(role === "student" ? { submitted: submittedIds.has(r.id) } : {}),
                })),
            },
        });
    } catch (error) {
        console.error("GET /insights/workload error:", error);
        res.status(500).json({ error: "Failed to fetch workload" });
    }
});

// ---------------------------------------------------------------------------
// Deadline clash check for the teacher: "if I set this due date, how many of my students
// already have other work due around then, in ANY of their classes?"
// ---------------------------------------------------------------------------
const CLASH_WINDOW_HOURS = 48;
const OVERLOAD_THRESHOLD = 3; // assignments due inside the window, including the one being scheduled

router.get("/clash", requireSession, requireRole("teacher", "admin"), async (req, res) => {
    try {
        const classId = Number(req.query.classId);
        const due = new Date(String(req.query.dueDate ?? ""));
        const excludeId = req.query.excludeId === undefined ? null : Number(req.query.excludeId);
        if (!Number.isInteger(classId)) return res.status(400).json({ error: "Invalid class id" });
        if (Number.isNaN(due.getTime())) return res.status(400).json({ error: "Invalid due date" });

        const [cls] = await db
            .select({ id: classes.id, teacherId: classes.teacherId })
            .from(classes)
            .where(eq(classes.id, classId));
        if (!cls) return res.status(404).json({ error: "Class not found." });
        if (req.user!.role === "teacher" && cls.teacherId !== req.user!.id) {
            return res.status(403).json({ error: "Forbidden", message: "You can only check clashes for your own classes." });
        }

        const roster = await db
            .select({ studentId: enrollments.studentId })
            .from(enrollments)
            .where(eq(enrollments.classId, classId));
        const studentIds = roster.map((r) => r.studentId);
        const base = {
            windowHours: CLASH_WINDOW_HOURS,
            studentsInClass: studentIds.length,
            overloadThreshold: OVERLOAD_THRESHOLD,
        };
        if (studentIds.length === 0) {
            return res.status(200).json({ data: { ...base, worstLoad: 1, studentsOverloaded: 0, clashes: [] } });
        }

        const from = new Date(due.getTime() - CLASH_WINDOW_HOURS * 3_600_000);
        const to = new Date(due.getTime() + CLASH_WINDOW_HOURS * 3_600_000);

        // Every (student, assignment) pair due inside the window for students on this roster.
        const rows = await db
            .select({
                studentId: enrollments.studentId,
                id: assignments.id,
                title: assignments.title,
                dueDate: assignments.dueDate,
                className: classes.name,
            })
            .from(enrollments)
            .innerJoin(assignments, eq(assignments.classId, enrollments.classId))
            .innerJoin(classes, eq(classes.id, assignments.classId))
            .where(
                and(
                    inArray(enrollments.studentId, studentIds),
                    gte(assignments.dueDate, from),
                    lte(assignments.dueDate, to),
                    excludeId !== null && Number.isInteger(excludeId) ? ne(assignments.id, excludeId) : undefined
                )
            );

        const perStudent = new Map<string, number>();
        const perAssignment = new Map<
            number,
            { id: number; title: string; className: string; dueDate: Date; studentsAffected: number }
        >();
        for (const r of rows) {
            perStudent.set(r.studentId, (perStudent.get(r.studentId) ?? 0) + 1);
            const entry = perAssignment.get(r.id) ?? {
                id: r.id,
                title: r.title,
                className: r.className,
                dueDate: r.dueDate,
                studentsAffected: 0,
            };
            entry.studentsAffected++;
            perAssignment.set(r.id, entry);
        }

        const loads = [...perStudent.values()].map((n) => n + 1); // +1 = the assignment being scheduled
        res.status(200).json({
            data: {
                ...base,
                worstLoad: loads.length ? Math.max(...loads) : 1,
                studentsOverloaded: loads.filter((n) => n >= OVERLOAD_THRESHOLD).length,
                clashes: [...perAssignment.values()]
                    .sort((a, b) => b.studentsAffected - a.studentsAffected)
                    .slice(0, 6),
            },
        });
    } catch (error) {
        console.error("GET /insights/clash error:", error);
        res.status(500).json({ error: "Failed to check deadline clashes" });
    }
});

// ---------------------------------------------------------------------------
// Class analytics for the teacher/admin: submission rate, grade spread, at-risk students
// ---------------------------------------------------------------------------
router.get("/class/:id", requireSession, requireRole("teacher", "admin"), async (req, res) => {
    try {
        const classId = Number(req.params.id);
        if (!Number.isInteger(classId)) return res.status(400).json({ error: "Invalid class id" });

        const [cls] = await db.select().from(classes).where(eq(classes.id, classId));
        if (!cls) return res.status(404).json({ error: "Class not found." });
        if (req.user!.role === "teacher" && cls.teacherId !== req.user!.id) {
            return res.status(403).json({ error: "Forbidden", message: "You can only view analytics for your own classes." });
        }

        const [students, classAssignments, subs] = await Promise.all([
            db
                .select({ id: user.id, name: user.name, image: user.image })
                .from(enrollments)
                .innerJoin(user, eq(enrollments.studentId, user.id))
                .where(eq(enrollments.classId, classId)),
            db.select().from(assignments).where(eq(assignments.classId, classId)).orderBy(asc(assignments.dueDate)),
            db
                .select({
                    assignmentId: submissions.assignmentId,
                    studentId: submissions.studentId,
                    marks: submissions.marks,
                    submittedAt: submissions.submittedAt,
                })
                .from(submissions)
                .innerJoin(assignments, eq(submissions.assignmentId, assignments.id))
                .where(eq(assignments.classId, classId)),
        ]);

        const now = Date.now();
        const maxById = new Map(classAssignments.map((a) => [a.id, a.maxMarks]));
        const dueById = new Map(classAssignments.map((a) => [a.id, new Date(a.dueDate).getTime()]));

        const perAssignment = classAssignments.map((a) => {
            const its = subs.filter((s) => s.assignmentId === a.id);
            const graded = its.filter((s) => s.marks !== null);
            const earned = graded.reduce((sum, s) => sum + (s.marks ?? 0), 0);
            return {
                id: a.id,
                title: a.title,
                dueDate: a.dueDate,
                maxMarks: a.maxMarks,
                submissions: its.length,
                graded: graded.length,
                submissionRate: percent(its.length, students.length) ?? 0,
                averagePercent: percent(earned, graded.length * a.maxMarks),
            };
        });

        const buckets = [
            { label: "0–39%", min: 0, max: 39, count: 0 },
            { label: "40–59%", min: 40, max: 59, count: 0 },
            { label: "60–79%", min: 60, max: 79, count: 0 },
            { label: "80–100%", min: 80, max: 1000, count: 0 },
        ];
        let earnedAll = 0;
        let possibleAll = 0;
        for (const s of subs) {
            if (s.marks === null) continue;
            const max = maxById.get(s.assignmentId) ?? 0;
            earnedAll += s.marks;
            possibleAll += max;
            const pct = max > 0 ? (s.marks / max) * 100 : 0;
            const bucket = buckets.find((b) => pct >= b.min && pct <= b.max + 0.999);
            if (bucket) bucket.count++;
        }

        // A student is "at risk" with 2+ missed deadlines or a graded average below 40%.
        const atRisk = students
            .map((st) => {
                const mine = subs.filter((s) => s.studentId === st.id);
                const submittedIds = new Set(mine.map((s) => s.assignmentId));
                const missing = classAssignments.filter((a) => !submittedIds.has(a.id) && (dueById.get(a.id) ?? 0) < now).length;
                const graded = mine.filter((s) => s.marks !== null);
                const earned = graded.reduce((sum, s) => sum + (s.marks ?? 0), 0);
                const possible = graded.reduce((sum, s) => sum + (maxById.get(s.assignmentId) ?? 0), 0);
                return { ...st, missing, averagePercent: percent(earned, possible) };
            })
            .filter((s) => s.missing >= 2 || (s.averagePercent !== null && s.averagePercent < 40))
            .sort((a, b) => b.missing - a.missing || (a.averagePercent ?? 100) - (b.averagePercent ?? 100))
            .slice(0, 8);

        res.status(200).json({
            data: {
                enrolled: students.length,
                capacity: cls.capacity,
                totalAssignments: classAssignments.length,
                totalSubmissions: subs.length,
                ungraded: subs.filter((s) => s.marks === null).length,
                averagePercent: percent(earnedAll, possibleAll),
                perAssignment,
                gradeDistribution: buckets.map(({ label, count }) => ({ label, count })),
                atRisk,
            },
        });
    } catch (error) {
        console.error("GET /insights/class/:id error:", error);
        res.status(500).json({ error: "Failed to fetch class analytics" });
    }
});

// ---------------------------------------------------------------------------
// Global search powering the Ctrl+K command palette (role-scoped)
// ---------------------------------------------------------------------------
router.get("/search", requireSession, async (req, res) => {
    try {
        const q = String(req.query.q ?? "").trim().slice(0, 60);
        if (q.length < 2) return res.status(200).json({ data: { classes: [], assignments: [], people: [] } });

        const pattern = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
        const { id: userId, role } = req.user!;
        const classIds = await scopedClassIds(userId, role);
        const none = classIds !== null && classIds.length === 0;

        const [classResults, assignmentResults, peopleResults] = await Promise.all([
            // Class directory is public to signed-in users (students need it to find classes to join)
            db
                .select({ id: classes.id, name: classes.name, status: classes.status, subject: subjects.name })
                .from(classes)
                .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                .where(or(ilike(classes.name, pattern), ilike(subjects.name, pattern)))
                .limit(5),
            none
                ? Promise.resolve([])
                : db
                    .select({
                        id: assignments.id,
                        title: assignments.title,
                        dueDate: assignments.dueDate,
                        className: classes.name,
                    })
                    .from(assignments)
                    .innerJoin(classes, eq(assignments.classId, classes.id))
                    .where(
                        and(
                            ilike(assignments.title, pattern),
                            classIds ? inArray(assignments.classId, classIds) : undefined
                        )
                    )
                    .orderBy(desc(assignments.dueDate))
                    .limit(5),
            // Students cannot search people; teachers only find students in their own classes
            role === "student" || (role === "teacher" && none)
                ? Promise.resolve([])
                : db
                    .selectDistinct({ id: user.id, name: user.name, role: user.role, image: user.image })
                    .from(user)
                    .leftJoin(enrollments, eq(enrollments.studentId, user.id))
                    .where(
                        and(
                            or(ilike(user.name, pattern), ilike(user.email, pattern)),
                            role === "teacher" && classIds ? inArray(enrollments.classId, classIds) : undefined
                        )
                    )
                    .limit(5),
        ]);

        res.status(200).json({ data: { classes: classResults, assignments: assignmentResults, people: peopleResults } });
    } catch (error) {
        console.error("GET /insights/search error:", error);
        res.status(500).json({ error: "Search failed" });
    }
});

export default router;
