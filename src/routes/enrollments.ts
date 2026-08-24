import express from "express";
import { and, eq, getTableColumns, ilike, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { classes, departments, enrollments, subjects } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireSession } from "../middleware/auth.js";

const router = express.Router();

const getEnrollmentDetails = async (classId: number, studentId: string) => {
    const [enrollment] = await db
        .select({
            classId: enrollments.classId,
            studentId: enrollments.studentId,
            class: {
                ...getTableColumns(classes),
            },
            subject: {
                ...getTableColumns(subjects),
            },
            department: {
                ...getTableColumns(departments),
            },
            teacher: {
                ...getTableColumns(user),
            },
        })
        .from(enrollments)
        .leftJoin(classes, eq(enrollments.classId, classes.id))
        .leftJoin(subjects, eq(classes.subjectId, subjects.id))
        .leftJoin(departments, eq(subjects.departmentId, departments.id))
        .leftJoin(user, eq(classes.teacherId, user.id))
        .where(
            and(
                eq(enrollments.classId, classId),
                eq(enrollments.studentId, studentId)
            )
        );

    return enrollment;
};

// Check if currently logged in student is enrolled in a class
router.get("/check/:classId", requireSession, async (req, res) => {
    try {
        const classId = Number(req.params.classId);
        const studentId = req.user!.id;

        if (!Number.isFinite(classId)) {
            return res.status(400).json({ error: "Invalid class id" });
        }

        const [existing] = await db
            .select()
            .from(enrollments)
            .where(
                and(
                    eq(enrollments.classId, classId),
                    eq(enrollments.studentId, studentId)
                )
            );

        res.status(200).json({ isEnrolled: !!existing });
    } catch (error) {
        console.error("GET /enrollments/check error:", error);
        res.status(500).json({ error: "Failed to check enrollment status" });
    }
});

// List classes enrolled by current student
router.get("/my", requireSession, async (req, res) => {
    try {
        const studentId = req.user!.id;

        const myEnrollments = await db
            .select({
                classId: enrollments.classId,
                studentId: enrollments.studentId,
                class: {
                    ...getTableColumns(classes),
                },
                subject: {
                    ...getTableColumns(subjects),
                },
                department: {
                    ...getTableColumns(departments),
                },
                teacher: {
                    ...getTableColumns(user),
                },
            })
            .from(enrollments)
            .leftJoin(classes, eq(enrollments.classId, classes.id))
            .leftJoin(subjects, eq(classes.subjectId, subjects.id))
            .leftJoin(departments, eq(subjects.departmentId, departments.id))
            .leftJoin(user, eq(classes.teacherId, user.id))
            .where(eq(enrollments.studentId, studentId));

        res.status(200).json({ data: myEnrollments });
    } catch (error) {
        console.error("GET /enrollments/my error:", error);
        res.status(500).json({ error: "Failed to fetch enrolled classes" });
    }
});

// Join class by invite code (Student only)
router.post("/join", requireSession, async (req, res) => {
    try {
        if (req.user!.role !== "student") {
            return res.status(403).json({
                error: "Forbidden",
                message: "Only students are allowed to join classes.",
            });
        }

        const { inviteCode } = req.body;
        const studentId = req.user!.id;

        if (!inviteCode || typeof inviteCode !== "string" || !inviteCode.trim()) {
            return res.status(400).json({
                error: "Bad Request",
                message: "Invite code is required.",
            });
        }

        const cleanCode = inviteCode.trim();

        // 1. Find class by invite code (case-insensitive)
        const [classRecord] = await db
            .select()
            .from(classes)
            .where(ilike(classes.inviteCode, cleanCode));

        if (!classRecord) {
            return res.status(404).json({
                error: "Not Found",
                message: "Invalid invite code. Class not found.",
            });
        }

        // 2. Verify class status is active
        if (classRecord.status !== "active") {
            return res.status(400).json({
                error: "Inactive Class",
                message: "This class is currently inactive and not accepting new enrollments.",
            });
        }

        // 3. Check if student is already enrolled
        const [existingEnrollment] = await db
            .select()
            .from(enrollments)
            .where(
                and(
                    eq(enrollments.classId, classRecord.id),
                    eq(enrollments.studentId, studentId)
                )
            );

        if (existingEnrollment) {
            return res.status(409).json({
                error: "Already Enrolled",
                message: "You are already enrolled in this class.",
            });
        }

        // 4. Capacity validation: count current enrollments
        const [countResult] = await db
            .select({ count: sql<number>`count(*)` })
            .from(enrollments)
            .where(eq(enrollments.classId, classRecord.id));

        const currentEnrolled = Number(countResult?.count ?? 0);
        if (classRecord.capacity && currentEnrolled >= classRecord.capacity) {
            return res.status(400).json({
                error: "Class Full",
                message: `This class has reached its maximum capacity (${classRecord.capacity} students).`,
            });
        }

        // 5. Create enrollment
        await db.insert(enrollments).values({
            classId: classRecord.id,
            studentId,
        });

        // 6. Return enrollment details
        const enrollment = await getEnrollmentDetails(classRecord.id, studentId);

        res.status(201).json({
            data: enrollment,
            message: "Successfully joined class!",
        });
    } catch (error) {
        console.error("POST /enrollments/join error:", error);
        res.status(500).json({
            error: "Internal Error",
            message: "Failed to join class. Please try again.",
        });
    }
});

// Create enrollment directly (admin or student self-enroll)
router.post("/", requireSession, async (req, res) => {
    try {
        const { classId } = req.body;
        let studentId = req.user!.id;

        if (req.user!.role === "admin" && req.body.studentId) {
            studentId = req.body.studentId;
        } else if (req.user!.role !== "student") {
            return res.status(403).json({
                error: "Forbidden",
                message: "Only students or admins can create enrollments.",
            });
        }

        const cIdNum = Number(classId);
        if (!Number.isFinite(cIdNum) || cIdNum <= 0) {
            return res.status(400).json({ error: "Valid classId is required" });
        }

        const [classRecord] = await db
            .select()
            .from(classes)
            .where(eq(classes.id, cIdNum));

        if (!classRecord) {
            return res.status(404).json({ error: "Class not found" });
        }

        if (classRecord.status !== "active") {
            return res.status(400).json({ error: "Cannot enroll in an inactive class" });
        }

        const [existingEnrollment] = await db
            .select()
            .from(enrollments)
            .where(
                and(
                    eq(enrollments.classId, cIdNum),
                    eq(enrollments.studentId, studentId)
                )
            );

        if (existingEnrollment) {
            return res.status(409).json({ error: "Student is already enrolled in this class" });
        }

        // Capacity check
        const [countResult] = await db
            .select({ count: sql<number>`count(*)` })
            .from(enrollments)
            .where(eq(enrollments.classId, cIdNum));

        const currentEnrolled = Number(countResult?.count ?? 0);
        if (classRecord.capacity && currentEnrolled >= classRecord.capacity) {
            return res.status(400).json({ error: "Class is full. Capacity has been reached." });
        }

        await db.insert(enrollments).values({
            classId: cIdNum,
            studentId,
        });

        const enrollment = await getEnrollmentDetails(cIdNum, studentId);

        res.status(201).json({ data: enrollment });
    } catch (error) {
        console.error("POST /enrollments error:", error);
        res.status(500).json({ error: "Failed to create enrollment" });
    }
});

export default router;
