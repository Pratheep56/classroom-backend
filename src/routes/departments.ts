import express from "express";
import { and, desc, eq, getTableColumns, ilike, ne, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { classes, departments, enrollments, subjects } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireSession, requireRole } from "../middleware/auth.js";

const router = express.Router();

// 1. Get all departments with optional search and pagination
router.get("/", async (req, res) => {
    try {
        const { search, page = 1, limit = 10 } = req.query;

        const currentPage = Math.max(1, +page);
        const limitPerPage = Math.max(1, +limit);
        const offset = (currentPage - 1) * limitPerPage;

        const filterConditions = [];

        if (search) {
            filterConditions.push(
                or(
                    ilike(departments.name, `%${search}%`),
                    ilike(departments.code, `%${search}%`)
                )
            );
        }

        const whereClause =
            filterConditions.length > 0 ? and(...filterConditions) : undefined;

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(departments)
            .where(whereClause);

        const totalCount = Number(countResult[0]?.count ?? 0);

        const departmentsList = await db
            .select({
                ...getTableColumns(departments),
                totalSubjects: sql<number>`count(${subjects.id})`,
            })
            .from(departments)
            .leftJoin(subjects, eq(departments.id, subjects.departmentId))
            .where(whereClause)
            .groupBy(departments.id)
            .orderBy(desc(departments.createdAt))
            .limit(limitPerPage)
            .offset(offset);

        res.status(200).json({
            data: departmentsList,
            pagination: {
                page: currentPage,
                limit: limitPerPage,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limitPerPage),
            },
        });
    } catch (error) {
        console.error("GET /departments error:", error);
        res.status(500).json({ error: "Failed to fetch departments" });
    }
});

// 2. Create department (admin only)
router.post("/", requireSession, requireRole("admin"), async (req, res) => {
    try {
        const { code, name, description } = req.body;

        const trimmedName = typeof name === "string" ? name.trim() : "";
        const trimmedCode = typeof code === "string" ? code.trim().toUpperCase() : "";
        const trimmedDesc = typeof description === "string" ? description.trim() : null;

        if (!trimmedName) {
            return res.status(400).json({ error: "Department name is required." });
        }

        if (!trimmedCode) {
            return res.status(400).json({ error: "Department code is required." });
        }

        // Check if duplicate code exists
        const [existingCode] = await db
            .select({ id: departments.id })
            .from(departments)
            .where(eq(departments.code, trimmedCode));

        if (existingCode) {
            return res.status(400).json({ error: `A department with code "${trimmedCode}" already exists.` });
        }

        // Check if duplicate name exists
        const [existingName] = await db
            .select({ id: departments.id })
            .from(departments)
            .where(ilike(departments.name, trimmedName));

        if (existingName) {
            return res.status(400).json({ error: `A department with name "${trimmedName}" already exists.` });
        }

        const [createdDepartment] = await db
            .insert(departments)
            .values({
                code: trimmedCode,
                name: trimmedName,
                description: trimmedDesc,
            })
            .returning();

        if (!createdDepartment) {
            return res.status(500).json({ error: "Failed to create department." });
        }

        res.status(201).json({ data: createdDepartment });
    } catch (error) {
        console.error("POST /departments error:", error);
        res.status(500).json({ error: "Failed to create department" });
    }
});

// 3. Get department details with counts and subjects
router.get("/:id", async (req, res) => {
    try {
        const departmentId = Number(req.params.id);

        if (!Number.isFinite(departmentId)) {
            return res.status(400).json({ error: "Invalid department id" });
        }

        const [department] = await db
            .select()
            .from(departments)
            .where(eq(departments.id, departmentId));

        if (!department) {
            return res.status(404).json({ error: "Department not found" });
        }

        const [subjectsCount, classesCount, enrolledStudentsCount, departmentSubjects] =
            await Promise.all([
                db
                    .select({ count: sql<number>`count(*)` })
                    .from(subjects)
                    .where(eq(subjects.departmentId, departmentId)),
                db
                    .select({ count: sql<number>`count(${classes.id})` })
                    .from(classes)
                    .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                    .where(eq(subjects.departmentId, departmentId)),
                db
                    .select({ count: sql<number>`count(distinct ${user.id})` })
                    .from(user)
                    .leftJoin(enrollments, eq(user.id, enrollments.studentId))
                    .leftJoin(classes, eq(enrollments.classId, classes.id))
                    .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                    .where(
                        and(
                            eq(user.role, "student"),
                            eq(subjects.departmentId, departmentId)
                        )
                    ),
                db
                    .select({
                        ...getTableColumns(subjects),
                    })
                    .from(subjects)
                    .where(eq(subjects.departmentId, departmentId))
                    .orderBy(desc(subjects.createdAt)),
            ]);

        res.status(200).json({
            data: {
                ...department,
                totalSubjects: Number(subjectsCount[0]?.count ?? 0),
                totalClasses: Number(classesCount[0]?.count ?? 0),
                totalEnrolledStudents: Number(enrolledStudentsCount[0]?.count ?? 0),
                subjects: departmentSubjects,
                totals: {
                    subjects: Number(subjectsCount[0]?.count ?? 0),
                    classes: Number(classesCount[0]?.count ?? 0),
                    enrolledStudents: Number(enrolledStudentsCount[0]?.count ?? 0),
                },
            },
        });
    } catch (error) {
        console.error("GET /departments/:id error:", error);
        res.status(500).json({ error: "Failed to fetch department details" });
    }
});

// 4. Update department (admin only)
router.put("/:id", requireSession, requireRole("admin"), async (req, res) => {
    try {
        const departmentId = Number(req.params.id);

        if (!Number.isFinite(departmentId)) {
            return res.status(400).json({ error: "Invalid department id" });
        }

        const [existing] = await db
            .select()
            .from(departments)
            .where(eq(departments.id, departmentId));

        if (!existing) {
            return res.status(404).json({ error: "Department not found." });
        }

        const { code, name, description } = req.body;

        const trimmedName = typeof name === "string" ? name.trim() : existing.name;
        const trimmedCode = typeof code === "string" ? code.trim().toUpperCase() : existing.code;
        const trimmedDesc = typeof description === "string" ? description.trim() : existing.description;

        if (!trimmedName) {
            return res.status(400).json({ error: "Department name cannot be empty." });
        }

        if (!trimmedCode) {
            return res.status(400).json({ error: "Department code cannot be empty." });
        }

        // Check for duplicate code on other departments
        const [duplicateCode] = await db
            .select({ id: departments.id })
            .from(departments)
            .where(and(eq(departments.code, trimmedCode), ne(departments.id, departmentId)));

        if (duplicateCode) {
            return res.status(400).json({ error: `Another department with code "${trimmedCode}" already exists.` });
        }

        // Check for duplicate name on other departments
        const [duplicateName] = await db
            .select({ id: departments.id })
            .from(departments)
            .where(and(ilike(departments.name, trimmedName), ne(departments.id, departmentId)));

        if (duplicateName) {
            return res.status(400).json({ error: `Another department with name "${trimmedName}" already exists.` });
        }

        const [updatedDepartment] = await db
            .update(departments)
            .set({
                name: trimmedName,
                code: trimmedCode,
                description: trimmedDesc,
                updatedAt: new Date(),
            })
            .where(eq(departments.id, departmentId))
            .returning();

        res.status(200).json({ data: updatedDepartment });
    } catch (error) {
        console.error("PUT /departments/:id error:", error);
        res.status(500).json({ error: "Failed to update department" });
    }
});

// 5. Delete department (admin only, prevents deletion if subjects exist)
router.delete("/:id", requireSession, requireRole("admin"), async (req, res) => {
    try {
        const departmentId = Number(req.params.id);

        if (!Number.isFinite(departmentId)) {
            return res.status(400).json({ error: "Invalid department id" });
        }

        const [existing] = await db
            .select()
            .from(departments)
            .where(eq(departments.id, departmentId));

        if (!existing) {
            return res.status(404).json({ error: "Department not found." });
        }

        // Check if any subjects belong to this department
        const [subjectsCount] = await db
            .select({ count: sql<number>`count(*)` })
            .from(subjects)
            .where(eq(subjects.departmentId, departmentId));

        const count = Number(subjectsCount?.count ?? 0);

        if (count > 0) {
            return res.status(400).json({
                error: `Cannot delete department because it contains ${count} subject${count === 1 ? "" : "s"}.`,
            });
        }

        await db.delete(departments).where(eq(departments.id, departmentId));

        res.status(200).json({
            data: { id: departmentId },
            message: "Department deleted successfully.",
        });
    } catch (error) {
        console.error("DELETE /departments/:id error:", error);
        res.status(500).json({ error: "Failed to delete department" });
    }
});

// 6. List subjects in a department with pagination
router.get("/:id/subjects", async (req, res) => {
    try {
        const departmentId = Number(req.params.id);
        const { page = 1, limit = 10 } = req.query;

        if (!Number.isFinite(departmentId)) {
            return res.status(400).json({ error: "Invalid department id" });
        }

        const currentPage = Math.max(1, +page);
        const limitPerPage = Math.max(1, +limit);
        const offset = (currentPage - 1) * limitPerPage;

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(subjects)
            .where(eq(subjects.departmentId, departmentId));

        const totalCount = Number(countResult[0]?.count ?? 0);

        const subjectsList = await db
            .select({
                ...getTableColumns(subjects),
            })
            .from(subjects)
            .where(eq(subjects.departmentId, departmentId))
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
    } catch (error) {
        console.error("GET /departments/:id/subjects error:", error);
        res.status(500).json({ error: "Failed to fetch department subjects" });
    }
});

// 7. List classes in a department with pagination
router.get("/:id/classes", async (req, res) => {
    try {
        const departmentId = Number(req.params.id);
        const { page = 1, limit = 10 } = req.query;

        if (!Number.isFinite(departmentId)) {
            return res.status(400).json({ error: "Invalid department id" });
        }

        const currentPage = Math.max(1, +page);
        const limitPerPage = Math.max(1, +limit);
        const offset = (currentPage - 1) * limitPerPage;

        const countResult = await db
            .select({ count: sql<number>`count(${classes.id})` })
            .from(classes)
            .leftJoin(subjects, eq(classes.subjectId, subjects.id))
            .where(eq(subjects.departmentId, departmentId));

        const totalCount = Number(countResult[0]?.count ?? 0);

        const classesList = await db
            .select({
                ...getTableColumns(classes),
                subject: {
                    ...getTableColumns(subjects),
                },
                teacher: {
                    ...getTableColumns(user),
                },
            })
            .from(classes)
            .leftJoin(subjects, eq(classes.subjectId, subjects.id))
            .leftJoin(user, eq(classes.teacherId, user.id))
            .where(eq(subjects.departmentId, departmentId))
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
        console.error("GET /departments/:id/classes error:", error);
        res.status(500).json({ error: "Failed to fetch department classes" });
    }
});

// 8. List users in a department by role with pagination
router.get("/:id/users", async (req, res) => {
    try {
        const departmentId = Number(req.params.id);
        const { role, page = 1, limit = 10 } = req.query;

        if (!Number.isFinite(departmentId)) {
            return res.status(400).json({ error: "Invalid department id" });
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
                    .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                    .where(
                        and(eq(user.role, role), eq(subjects.departmentId, departmentId))
                    )
                : await db
                    .select({ count: sql<number>`count(distinct ${user.id})` })
                    .from(user)
                    .leftJoin(enrollments, eq(user.id, enrollments.studentId))
                    .leftJoin(classes, eq(enrollments.classId, classes.id))
                    .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                    .where(
                        and(eq(user.role, role), eq(subjects.departmentId, departmentId))
                    );

        const totalCount = Number(countResult[0]?.count ?? 0);

        const usersList =
            role === "teacher"
                ? await db
                    .select(baseSelect)
                    .from(user)
                    .leftJoin(classes, eq(user.id, classes.teacherId))
                    .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                    .where(
                        and(eq(user.role, role), eq(subjects.departmentId, departmentId))
                    )
                    .groupBy(...groupByFields)
                    .orderBy(desc(user.createdAt))
                    .limit(limitPerPage)
                    .offset(offset)
                : await db
                    .select(baseSelect)
                    .from(user)
                    .leftJoin(enrollments, eq(user.id, enrollments.studentId))
                    .leftJoin(classes, eq(enrollments.classId, classes.id))
                    .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                    .where(
                        and(eq(user.role, role), eq(subjects.departmentId, departmentId))
                    )
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
        console.error("GET /departments/:id/users error:", error);
        res.status(500).json({ error: "Failed to fetch department users" });
    }
});

export default router;
