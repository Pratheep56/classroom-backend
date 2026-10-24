import express from "express";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { classes, departments, enrollments, subjects } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireSession } from "../middleware/auth.js";
import { publicUserColumns, userColumnsFor } from "../lib/columns.js";

const router = express.Router();

// Overview counts for core entities (Admin and general metrics)
router.get("/overview", async (req, res) => {
    try {
        const [
            usersCount,
            teachersCount,
            studentsCount,
            adminsCount,
            subjectsCount,
            departmentsCount,
            classesCount,
            enrollmentsCount,
        ] = await Promise.all([
            db.select({ count: sql<number>`count(*)` }).from(user),
            db.select({ count: sql<number>`count(*)` }).from(user).where(eq(user.role, "teacher")),
            db.select({ count: sql<number>`count(*)` }).from(user).where(eq(user.role, "student")),
            db.select({ count: sql<number>`count(*)` }).from(user).where(eq(user.role, "admin")),
            db.select({ count: sql<number>`count(*)` }).from(subjects),
            db.select({ count: sql<number>`count(*)` }).from(departments),
            db.select({ count: sql<number>`count(*)` }).from(classes),
            db.select({ count: sql<number>`count(*)` }).from(enrollments),
        ]);

        res.status(200).json({
            data: {
                users: Number(usersCount[0]?.count ?? 0),
                teachers: Number(teachersCount[0]?.count ?? 0),
                students: Number(studentsCount[0]?.count ?? 0),
                admins: Number(adminsCount[0]?.count ?? 0),
                subjects: Number(subjectsCount[0]?.count ?? 0),
                departments: Number(departmentsCount[0]?.count ?? 0),
                classes: Number(classesCount[0]?.count ?? 0),
                enrollments: Number(enrollmentsCount[0]?.count ?? 0),
            },
        });
    } catch (error) {
        console.error("GET /stats/overview error:", error);
        res.status(500).json({ error: "Failed to fetch overview stats" });
    }
});

// Teacher-specific stats
router.get("/teacher", requireSession, async (req, res) => {
    try {
        const teacherId = req.user!.id;

        const [
            totalClassesResult,
            activeClassesResult,
            totalStudentsResult,
        ] = await Promise.all([
            db
                .select({ count: sql<number>`count(*)` })
                .from(classes)
                .where(eq(classes.teacherId, teacherId)),
            db
                .select({ count: sql<number>`count(*)` })
                .from(classes)
                .where(and(eq(classes.teacherId, teacherId), eq(classes.status, "active"))),
            db
                .select({ count: sql<number>`count(distinct ${enrollments.studentId})` })
                .from(enrollments)
                .leftJoin(classes, eq(enrollments.classId, classes.id))
                .where(eq(classes.teacherId, teacherId)),
        ]);

        res.status(200).json({
            data: {
                totalClasses: Number(totalClassesResult[0]?.count ?? 0),
                activeClasses: Number(activeClassesResult[0]?.count ?? 0),
                totalStudents: Number(totalStudentsResult[0]?.count ?? 0),
            },
        });
    } catch (error) {
        console.error("GET /stats/teacher error:", error);
        res.status(500).json({ error: "Failed to fetch teacher stats" });
    }
});

// Student-specific stats
router.get("/student", requireSession, async (req, res) => {
    try {
        const studentId = req.user!.id;

        const [
            enrolledClassesResult,
            totalSubjectsResult,
        ] = await Promise.all([
            db
                .select({ count: sql<number>`count(*)` })
                .from(enrollments)
                .where(eq(enrollments.studentId, studentId)),
            db
                .select({ count: sql<number>`count(distinct ${classes.subjectId})` })
                .from(enrollments)
                .leftJoin(classes, eq(enrollments.classId, classes.id))
                .where(eq(enrollments.studentId, studentId)),
        ]);

        res.status(200).json({
            data: {
                enrolledClasses: Number(enrolledClassesResult[0]?.count ?? 0),
                totalSubjects: Number(totalSubjectsResult[0]?.count ?? 0),
            },
        });
    } catch (error) {
        console.error("GET /stats/student error:", error);
        res.status(500).json({ error: "Failed to fetch student stats" });
    }
});

// Latest activity summaries
router.get("/latest", async (req, res) => {
    try {
        const { limit = 5 } = req.query;
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 5), 50);

        const [latestClasses, latestTeachers] = await Promise.all([
            db
                .select({
                    ...getTableColumns(classes),
                    subject: {
                        ...getTableColumns(subjects),
                    },
                    teacher: userColumnsFor(req),
                })
                .from(classes)
                .leftJoin(subjects, eq(classes.subjectId, subjects.id))
                .leftJoin(user, eq(classes.teacherId, user.id))
                .orderBy(desc(classes.createdAt))
                .limit(limitPerPage),
            db
                .select({ ...publicUserColumns, createdAt: user.createdAt })
                .from(user)
                .where(eq(user.role, "teacher"))
                .orderBy(desc(user.createdAt))
                .limit(limitPerPage),
        ]);

        res.status(200).json({
            data: {
                latestClasses,
                latestTeachers,
            },
        });
    } catch (error) {
        console.error("GET /stats/latest error:", error);
        res.status(500).json({ error: "Failed to fetch latest stats" });
    }
});

// Aggregates for charts
router.get("/charts", async (req, res) => {
    try {
        const [usersByRole, subjectsByDepartment, classesBySubject] =
            await Promise.all([
                db
                    .select({
                        role: user.role,
                        total: sql<number>`count(*)`,
                    })
                    .from(user)
                    .groupBy(user.role),
                db
                    .select({
                        departmentId: departments.id,
                        departmentName: departments.name,
                        totalSubjects: sql<number>`count(${subjects.id})`,
                    })
                    .from(departments)
                    .leftJoin(subjects, eq(subjects.departmentId, departments.id))
                    .groupBy(departments.id),
                db
                    .select({
                        subjectId: subjects.id,
                        subjectName: subjects.name,
                        totalClasses: sql<number>`count(${classes.id})`,
                    })
                    .from(subjects)
                    .leftJoin(classes, eq(classes.subjectId, subjects.id))
                    .groupBy(subjects.id),
            ]);

        res.status(200).json({
            data: {
                usersByRole,
                subjectsByDepartment,
                classesBySubject,
            },
        });
    } catch (error) {
        console.error("GET /stats/charts error:", error);
        res.status(500).json({ error: "Failed to fetch chart stats" });
    }
});

export default router;
