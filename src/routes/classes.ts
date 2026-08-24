import express from "express";
import { and, desc, eq, getTableColumns, ilike, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { classes, departments, enrollments, subjects } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireSession, requireRole } from "../middleware/auth.js";

const router = express.Router();

// GET all classes — public, with optional search, filtering and pagination
router.get("/", async (req, res) => {
    try {
        const { search, subject, teacher, page = 1, limit = 10 } = req.query;

        const currentPage = Math.max(1, parseInt(String(page), 10) || 1);
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 10), 100);
        const offset = (currentPage - 1) * limitPerPage;

        const filterConditions = [];

        if (search) {
            filterConditions.push(
                or(
                    ilike(classes.name, `%${search}%`),
                    ilike(classes.inviteCode, `%${search}%`)
                )
            );
        }

        if (subject) {
            const subjectPattern = `%${String(subject).replace(/[%_]/g, "\\$&")}%`;
            filterConditions.push(ilike(subjects.name, subjectPattern));
        }

        if (teacher) {
            const teacherPattern = `%${String(teacher).replace(/[%_]/g, "\\$&")}%`;
            filterConditions.push(ilike(user.name, teacherPattern));
        }

        const whereClause = filterConditions.length > 0 ? and(...filterConditions) : undefined;

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(classes)
            .leftJoin(subjects, eq(classes.subjectId, subjects.id))
            .leftJoin(user, eq(classes.teacherId, user.id))
            .where(whereClause);

        const totalCount = countResult[0]?.count ?? 0;

        const classesList = await db
            .select({
                ...getTableColumns(classes),
                subject: { ...getTableColumns(subjects) },
                teacher: { ...getTableColumns(user) },
                department: { ...getTableColumns(departments) },
                enrolledCount: sql<number>`(select count(*) from ${enrollments} where ${enrollments.classId} = ${classes.id})`,
            })
            .from(classes)
            .leftJoin(subjects, eq(classes.subjectId, subjects.id))
            .leftJoin(departments, eq(subjects.departmentId, departments.id))
            .leftJoin(user, eq(classes.teacherId, user.id))
            .where(whereClause)
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
        console.error(`GET /classes error: ${e}`);
        res.status(500).json({ error: "Failed to get classes" });
    }
});

// GET class by id — public
router.get("/:id", async (req, res) => {
    try {
        const classId = Number(req.params.id);

        if (!Number.isFinite(classId)) {
            return res.status(400).json({ error: "Invalid class id." });
        }

        const [classDetails] = await db
            .select({
                ...getTableColumns(classes),
                subject: { ...getTableColumns(subjects) },
                department: { ...getTableColumns(departments) },
                teacher: { ...getTableColumns(user) },
                enrolledCount: sql<number>`(select count(*) from ${enrollments} where ${enrollments.classId} = ${classes.id})`,
            })
            .from(classes)
            .leftJoin(subjects, eq(classes.subjectId, subjects.id))
            .leftJoin(user, eq(classes.teacherId, user.id))
            .leftJoin(departments, eq(subjects.departmentId, departments.id))
            .where(eq(classes.id, classId));

        if (!classDetails) {
            return res.status(404).json({ error: "Class not found." });
        }

        res.status(200).json({ data: classDetails });
    } catch (e) {
        console.error(`GET /classes/:id error: ${e}`);
        res.status(500).json({ error: "Failed to get class" });
    }
});

// List users in a class by role with pagination
router.get("/:id/users", async (req, res) => {
    try {
        const classId = Number(req.params.id);
        const { role, page = 1, limit = 10 } = req.query;

        if (!Number.isFinite(classId)) {
            return res.status(400).json({ error: "Invalid class id" });
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
                      .where(and(eq(user.role, role), eq(classes.id, classId)))
                : await db
                      .select({ count: sql<number>`count(distinct ${user.id})` })
                      .from(user)
                      .leftJoin(enrollments, eq(user.id, enrollments.studentId))
                      .where(and(eq(user.role, role), eq(enrollments.classId, classId)));

        const totalCount = countResult[0]?.count ?? 0;

        const usersList =
            role === "teacher"
                ? await db
                      .select(baseSelect)
                      .from(user)
                      .leftJoin(classes, eq(user.id, classes.teacherId))
                      .where(and(eq(user.role, role), eq(classes.id, classId)))
                      .groupBy(...groupByFields)
                      .orderBy(desc(user.createdAt))
                      .limit(limitPerPage)
                      .offset(offset)
                : await db
                      .select(baseSelect)
                      .from(user)
                      .leftJoin(enrollments, eq(user.id, enrollments.studentId))
                      .where(and(eq(user.role, role), eq(enrollments.classId, classId)))
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
        console.error("GET /classes/:id/users error:", error);
        res.status(500).json({ error: "Failed to fetch class users" });
    }
});

// POST create class — teacher or admin only
router.post("/", requireSession, requireRole("teacher", "admin"), async (req, res) => {
    try {
        const {
            name,
            subjectId,
            teacherId,
            capacity,
            description,
            status,
            bannerUrl,
            bannerCldPubId,
            schedules,
        } = req.body;

        if (!name || typeof name !== "string" || name.trim().length < 2) {
            return res.status(400).json({ error: "Class name must be at least 2 characters" });
        }

        const subjIdNum = Number(subjectId);
        if (!Number.isFinite(subjIdNum) || subjIdNum <= 0) {
            return res.status(400).json({ error: "Valid subjectId is required" });
        }

        // Verify subject exists
        const [subjectRecord] = await db
            .select({ id: subjects.id })
            .from(subjects)
            .where(eq(subjects.id, subjIdNum));

        if (!subjectRecord) {
            return res.status(400).json({ error: "Subject not found" });
        }

        // Determine effective teacher ID
        let effectiveTeacherId = teacherId;
        if (req.user!.role === "teacher") {
            // Teachers can only assign themselves
            effectiveTeacherId = req.user!.id;
        }

        if (!effectiveTeacherId) {
            return res.status(400).json({ error: "teacherId is required" });
        }

        // Verify teacher exists and has role=teacher (or admin)
        const [teacherRecord] = await db
            .select({ id: user.id, role: user.role })
            .from(user)
            .where(eq(user.id, effectiveTeacherId));

        if (!teacherRecord) {
            return res.status(400).json({ error: "Teacher user not found" });
        }

        if (teacherRecord.role !== "teacher" && teacherRecord.role !== "admin") {
            return res.status(400).json({ error: "Selected user must have teacher role" });
        }

        const capNum = Number(capacity);
        if (Number.isFinite(capNum) && capNum < 1) {
            return res.status(400).json({ error: "Capacity must be at least 1" });
        }

        const validStatus = status === "inactive" ? "inactive" : "active";

        const generatedInviteCode = Math.random().toString(36).substring(2, 9).toUpperCase();

        const [createdClass] = await db
            .insert(classes)
            .values({
                name: name.trim(),
                subjectId: subjIdNum,
                teacherId: effectiveTeacherId,
                capacity: Number.isFinite(capNum) && capNum > 0 ? capNum : 50,
                description: description?.trim() || "",
                status: validStatus,
                bannerUrl: bannerUrl || "",
                bannerCldPubId: bannerCldPubId || "",
                inviteCode: generatedInviteCode,
                schedules: Array.isArray(schedules) ? schedules : [],
            })
            .returning({ id: classes.id });

        if (!createdClass) throw new Error("Insert failed");

        res.status(201).json({ data: createdClass });
    } catch (e) {
        console.error(`POST /classes error ${e}`);
        res.status(500).json({ error: "Failed to create class" });
    }
});

// PUT update class — admin or the class's own teacher
router.put("/:id", requireSession, requireRole("teacher", "admin"), async (req, res) => {
    try {
        const classId = Number(req.params.id);

        if (!Number.isFinite(classId)) {
            return res.status(400).json({ error: "Invalid class id." });
        }

        const [existing] = await db
            .select()
            .from(classes)
            .where(eq(classes.id, classId));

        if (!existing) {
            return res.status(404).json({ error: "Class not found." });
        }

        // Teachers can only update their own classes
        if (req.user!.role === "teacher" && existing.teacherId !== req.user!.id) {
            return res.status(403).json({ error: "Forbidden: you can only update your own classes." });
        }

        const {
            name,
            subjectId,
            teacherId,
            capacity,
            description,
            status,
            bannerUrl,
            bannerCldPubId,
            schedules,
        } = req.body;

        const updateData: Record<string, unknown> = {};

        if (name !== undefined) {
            if (typeof name !== "string" || name.trim().length < 2) {
                return res.status(400).json({ error: "Class name must be at least 2 characters" });
            }
            updateData.name = name.trim();
        }

        if (subjectId !== undefined) {
            const subjIdNum = Number(subjectId);
            if (!Number.isFinite(subjIdNum) || subjIdNum <= 0) {
                return res.status(400).json({ error: "Valid subjectId is required" });
            }
            const [subj] = await db.select({ id: subjects.id }).from(subjects).where(eq(subjects.id, subjIdNum));
            if (!subj) return res.status(400).json({ error: "Subject not found" });
            updateData.subjectId = subjIdNum;
        }

        if (teacherId !== undefined && req.user!.role === "admin") {
            const [tRecord] = await db.select({ id: user.id, role: user.role }).from(user).where(eq(user.id, teacherId));
            if (!tRecord || (tRecord.role !== "teacher" && tRecord.role !== "admin")) {
                return res.status(400).json({ error: "Selected teacher is invalid" });
            }
            updateData.teacherId = teacherId;
        }

        if (capacity !== undefined) {
            const capNum = Number(capacity);
            if (!Number.isFinite(capNum) || capNum < 1) {
                return res.status(400).json({ error: "Capacity must be at least 1" });
            }
            updateData.capacity = capNum;
        }

        if (description !== undefined) {
            updateData.description = typeof description === "string" ? description.trim() : "";
        }

        if (status !== undefined) {
            updateData.status = status === "inactive" ? "inactive" : "active";
        }

        if (bannerUrl !== undefined) updateData.bannerUrl = bannerUrl;
        if (bannerCldPubId !== undefined) updateData.bannerCldPubId = bannerCldPubId;
        if (schedules !== undefined && Array.isArray(schedules)) updateData.schedules = schedules;

        const [updated] = await db
            .update(classes)
            .set(updateData)
            .where(eq(classes.id, classId))
            .returning({ id: classes.id });

        if (!updated) {
            return res.status(404).json({ error: "Class not found." });
        }

        res.status(200).json({ data: updated });
    } catch (e) {
        console.error(`PUT /classes/:id error: ${e}`);
        res.status(500).json({ error: "Failed to update class" });
    }
});

// DELETE class — admin or the class's own teacher
router.delete("/:id", requireSession, requireRole("teacher", "admin"), async (req, res) => {
    try {
        const classId = Number(req.params.id);

        if (!Number.isFinite(classId)) {
            return res.status(400).json({ error: "Invalid class id." });
        }

        const [existing] = await db
            .select({ teacherId: classes.teacherId })
            .from(classes)
            .where(eq(classes.id, classId));

        if (!existing) {
            return res.status(404).json({ error: "Class not found." });
        }

        if (req.user!.role === "teacher" && existing.teacherId !== req.user!.id) {
            return res.status(403).json({ error: "Forbidden: you can only delete your own classes." });
        }

        const [deleted] = await db
            .delete(classes)
            .where(eq(classes.id, classId))
            .returning({ id: classes.id });

        if (!deleted) {
            return res.status(404).json({ error: "Class not found." });
        }

        res.status(200).json({ data: deleted });
    } catch (e) {
        console.error(`DELETE /classes/:id error: ${e}`);
        res.status(500).json({ error: "Failed to delete class" });
    }
});

export default router;