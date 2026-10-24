import express from "express";
import { and, desc, eq, getTableColumns, ilike, or, sql } from "drizzle-orm";
import { user } from "../db/schema/auth.js";
import { classes, departments, enrollments, subjects } from "../db/schema/app.js";
import { db } from "../db/index.js";
import { requireSession } from "../middleware/auth.js";

const router = express.Router();

// 1. Get all users with optional search, filtering and pagination
router.get("/", requireSession, async (req, res) => {
    try {
        const { search, role, page = 1, limit = 10 } = req.query;

        const currentPage = Math.max(1, parseInt(String(page), 10) || 1);
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 10), 100);
        const offset = (currentPage - 1) * limitPerPage;

        const filterConditions = [];

        if (search) {
            filterConditions.push(
                or(
                    ilike(user.name, `%${String(search)}%`),
                    ilike(user.email, `%${String(search)}%`)
                )
            );
        }

        if (role && (role === "admin" || role === "teacher" || role === "student")) {
            filterConditions.push(eq(user.role, role as "admin" | "teacher" | "student"));
        }

        const whereClause = filterConditions.length > 0 ? and(...filterConditions) : undefined;

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(user)
            .where(whereClause);

        const totalCount = Number(countResult[0]?.count ?? 0);

        const usersList = await db
            .select({
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                image: user.image,
                imageCldPubId: user.imageCldPubId,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
            })
            .from(user)
            .where(whereClause)
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
    } catch (e) {
        console.error(`GET /users error: ${e}`);
        res.status(500).json({ error: "Failed to get users" });
    }
});

// 2. Get user by ID with authorization checks
router.get("/:id", requireSession, async (req, res) => {
    try {
        const targetUserId = String(req.params.id);
        const requesterId = String(req.user!.id);
        const requesterRole = String(req.user!.role);

        const [userRecord] = await db
            .select({
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                image: user.image,
                imageCldPubId: user.imageCldPubId,
                createdAt: user.createdAt,
                updatedAt: user.updatedAt,
            })
            .from(user)
            .where(eq(user.id, targetUserId));

        if (!userRecord) {
            return res.status(404).json({ error: "User not found" });
        }

        // Authorization checks:
        // - Admin: can view any user
        // - Self: can view own profile
        // - Teacher: can view students enrolled in at least one class taught by that teacher
        // - Student: cannot view other students
        if (requesterRole !== "admin" && requesterId !== targetUserId) {
            if (requesterRole === "teacher") {
                const [enrolledInMyClass] = await db
                    .select({ studentId: enrollments.studentId })
                    .from(enrollments)
                    .leftJoin(classes, eq(enrollments.classId, classes.id))
                    .where(
                        and(
                            eq(enrollments.studentId, targetUserId),
                            eq(classes.teacherId, requesterId)
                        )
                    )
                    .limit(1);

                if (!enrolledInMyClass) {
                    return res.status(403).json({
                        error: "Forbidden",
                        message: "You can only view profiles of students enrolled in your classes.",
                    });
                }
            } else {
                return res.status(403).json({
                    error: "Forbidden",
                    message: "You are not authorized to view this user profile.",
                });
            }
        }

        // Fetch enrolled classes relevant to the requester
        const classesQuery =
            requesterRole === "teacher" && requesterId !== targetUserId
                ? db
                      .select({
                          ...getTableColumns(classes),
                          subject: { ...getTableColumns(subjects) },
                          department: { ...getTableColumns(departments) },
                      })
                      .from(enrollments)
                      .leftJoin(classes, eq(enrollments.classId, classes.id))
                      .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                      .leftJoin(departments, eq(subjects.departmentId, departments.id))
                      .where(
                          and(
                              eq(enrollments.studentId, targetUserId),
                              eq(classes.teacherId, requesterId)
                          )
                      )
                : db
                      .select({
                          ...getTableColumns(classes),
                          subject: { ...getTableColumns(subjects) },
                          department: { ...getTableColumns(departments) },
                      })
                      .from(enrollments)
                      .leftJoin(classes, eq(enrollments.classId, classes.id))
                      .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                      .leftJoin(departments, eq(subjects.departmentId, departments.id))
                      .where(eq(enrollments.studentId, targetUserId));

        const userClasses = await classesQuery;

        res.status(200).json({
            data: {
                ...userRecord,
                enrolledClasses: userClasses,
                totalClasses: userClasses.length,
            },
        });
    } catch (e) {
        console.error(`GET /users/:id error: ${e}`);
        res.status(500).json({ error: "Failed to get user" });
    }
});

// 3. Get classes associated with a user
router.get("/:id/classes", requireSession, async (req, res) => {
    try {
        const targetUserId = String(req.params.id);
        const requesterId = String(req.user!.id);
        const requesterRole = String(req.user!.role);
        const { page = 1, limit = 10 } = req.query;

        const [userRecord] = await db
            .select({ id: user.id, role: user.role })
            .from(user)
            .where(eq(user.id, targetUserId));

        if (!userRecord) {
            return res.status(404).json({ error: "User not found" });
        }

        // Authorization checks
        if (requesterRole !== "admin" && requesterId !== targetUserId) {
            if (requesterRole === "teacher") {
                const [enrolledInMyClass] = await db
                    .select({ studentId: enrollments.studentId })
                    .from(enrollments)
                    .leftJoin(classes, eq(enrollments.classId, classes.id))
                    .where(
                        and(
                            eq(enrollments.studentId, targetUserId),
                            eq(classes.teacherId, requesterId)
                        )
                    )
                    .limit(1);

                if (!enrolledInMyClass) {
                    return res.status(403).json({
                        error: "Forbidden",
                        message: "You can only view classes of students enrolled in your classes.",
                    });
                }
            } else {
                return res.status(403).json({
                    error: "Forbidden",
                    message: "You are not authorized to view this user's classes.",
                });
            }
        }

        const currentPage = Math.max(1, parseInt(String(page), 10) || 1);
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 10), 100);
        const offset = (currentPage - 1) * limitPerPage;

        const countResult =
            userRecord.role === "teacher"
                ? await db
                      .select({ count: sql<number>`count(*)` })
                      .from(classes)
                      .where(eq(classes.teacherId, targetUserId))
                : await db
                      .select({ count: sql<number>`count(*)` })
                      .from(enrollments)
                      .where(eq(enrollments.studentId, targetUserId));

        const totalCount = Number(countResult[0]?.count ?? 0);

        const classesList =
            userRecord.role === "teacher"
                ? await db
                      .select({
                          ...getTableColumns(classes),
                          subject: { ...getTableColumns(subjects) },
                          department: { ...getTableColumns(departments) },
                      })
                      .from(classes)
                      .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                      .leftJoin(departments, eq(subjects.departmentId, departments.id))
                      .where(eq(classes.teacherId, targetUserId))
                      .orderBy(desc(classes.createdAt))
                      .limit(limitPerPage)
                      .offset(offset)
                : await db
                      .select({
                          ...getTableColumns(classes),
                          subject: { ...getTableColumns(subjects) },
                          department: { ...getTableColumns(departments) },
                          teacher: { ...getTableColumns(user) },
                      })
                      .from(enrollments)
                      .leftJoin(classes, eq(enrollments.classId, classes.id))
                      .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                      .leftJoin(departments, eq(subjects.departmentId, departments.id))
                      .leftJoin(user, eq(classes.teacherId, user.id))
                      .where(eq(enrollments.studentId, targetUserId))
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
    } catch (e) {
        console.error(`GET /users/:id/classes error: ${e}`);
        res.status(500).json({ error: "Failed to get user classes" });
    }
});

export default router;