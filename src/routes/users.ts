import express from "express";
import { and, desc, eq, getTableColumns, ilike, or, sql } from "drizzle-orm";
import { user } from "../db/schema/auth.js";
import { classes, departments, enrollments, subjects } from "../db/schema/app.js";
import { db } from "../db/index.js";

const router = express.Router();

// Get all users with optional search, filtering and pagination
router.get("/", async (req, res) => {
    try {
        const { search, role, page = 1, limit = 10 } = req.query;

        const currentPage = Math.max(1, parseInt(String(page), 10) || 1);
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 10), 100);
        const offset = (currentPage - 1) * limitPerPage;

        const filterConditions = [];

        if (search) {
            filterConditions.push(
                or(
                    ilike(user.name, `%${search}%`),
                    ilike(user.email, `%${search}%`)
                )
            );
        }

        if (role && (role === "admin" || role === "teacher" || role === "student")) {
            filterConditions.push(eq(user.role, role));
        }

        const whereClause = filterConditions.length > 0 ? and(...filterConditions) : undefined;

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(user)
            .where(whereClause);

        const totalCount = countResult[0]?.count ?? 0;

        const usersList = await db
            .select({
                ...getTableColumns(user),
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

// Get user by id
router.get("/:id", async (req, res) => {
    try {
        const userId = req.params.id;

        const [userRecord] = await db
            .select()
            .from(user)
            .where(eq(user.id, userId));

        if (!userRecord) {
            return res.status(404).json({ error: "User not found" });
        }

        res.status(200).json({ data: userRecord });
    } catch (e) {
        console.error(`GET /users/:id error: ${e}`);
        res.status(500).json({ error: "Failed to get user" });
    }
});

// Get classes associated with a user
router.get("/:id/classes", async (req, res) => {
    try {
        const userId = req.params.id;
        const { page = 1, limit = 10 } = req.query;

        const [userRecord] = await db
            .select({ id: user.id, role: user.role })
            .from(user)
            .where(eq(user.id, userId));

        if (!userRecord) {
            return res.status(404).json({ error: "User not found" });
        }

        const currentPage = Math.max(1, +page);
        const limitPerPage = Math.max(1, +limit);
        const offset = (currentPage - 1) * limitPerPage;

        const countResult =
            userRecord.role === "teacher"
                ? await db
                      .select({ count: sql<number>`count(*)` })
                      .from(classes)
                      .where(eq(classes.teacherId, userId))
                : await db
                      .select({ count: sql<number>`count(*)` })
                      .from(enrollments)
                      .where(eq(enrollments.studentId, userId));

        const totalCount = countResult[0]?.count ?? 0;

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
                      .where(eq(classes.teacherId, userId))
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
                      .where(eq(enrollments.studentId, userId))
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