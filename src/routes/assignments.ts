import express from "express";
import { and, desc, eq, getTableColumns, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { assignments, classes, enrollments, subjects, submissions } from "../db/schema/app.js";
import { user } from "../db/schema/auth.js";
import { requireSession, requireRole } from "../middleware/auth.js";

const router = express.Router();

export type SubmissionStatus = "Pending" | "Submitted" | "Late" | "Missing" | "Graded";

function calculateStatus(
    dueDate: Date | string,
    submission?: { submittedAt: Date | string; marks?: number | null } | null
): SubmissionStatus {
    const now = new Date();
    const due = new Date(dueDate);

    if (!submission) {
        return now > due ? "Missing" : "Pending";
    }

    if (submission.marks !== null && submission.marks !== undefined) {
        return "Graded";
    }

    if (new Date(submission.submittedAt) > due) {
        return "Late";
    }

    return "Submitted";
}

// 1. Get assignments list with role-based filtering, search, and pagination
router.get("/", requireSession, async (req, res) => {
    try {
        const { search, classId, page = 1, limit = 10 } = req.query;

        const currentPage = Math.max(1, parseInt(String(page), 10) || 1);
        const limitPerPage = Math.min(Math.max(1, parseInt(String(limit), 10) || 10), 100);
        const offset = (currentPage - 1) * limitPerPage;

        const userId = req.user!.id;
        const userRole = req.user!.role;

        // Role-based scoping of classes
        let allowedClassIds: number[] = [];

        if (userRole === "admin") {
            // Admin can access all classes
            if (classId) {
                allowedClassIds = [Number(classId)];
            }
        } else if (userRole === "teacher") {
            // Teacher can only access classes they teach
            const teacherClasses = await db
                .select({ id: classes.id })
                .from(classes)
                .where(eq(classes.teacherId, userId));

            allowedClassIds = teacherClasses.map((c) => c.id);

            if (classId) {
                const requestedId = Number(classId);
                if (!allowedClassIds.includes(requestedId)) {
                    return res.status(403).json({ error: "Forbidden", message: "You do not teach this class." });
                }
                allowedClassIds = [requestedId];
            }
        } else if (userRole === "student") {
            // Student can only access classes they are enrolled in
            const studentEnrollments = await db
                .select({ classId: enrollments.classId })
                .from(enrollments)
                .where(eq(enrollments.studentId, userId));

            allowedClassIds = studentEnrollments.map((e) => e.classId);

            if (classId) {
                const requestedId = Number(classId);
                if (!allowedClassIds.includes(requestedId)) {
                    return res.status(403).json({ error: "Forbidden", message: "You are not enrolled in this class." });
                }
                allowedClassIds = [requestedId];
            }
        }

        // If not admin and no classes available
        if (userRole !== "admin" && allowedClassIds.length === 0) {
            return res.status(200).json({
                data: [],
                pagination: {
                    page: currentPage,
                    limit: limitPerPage,
                    total: 0,
                    totalPages: 0,
                },
            });
        }

        const filterConditions = [];

        if (userRole !== "admin" || classId) {
            filterConditions.push(inArray(assignments.classId, allowedClassIds));
        }

        if (search) {
            filterConditions.push(
                or(
                    ilike(assignments.title, `%${search}%`),
                    ilike(assignments.description, `%${search}%`)
                )
            );
        }

        const whereClause =
            filterConditions.length > 0 ? and(...filterConditions) : undefined;

        const countResult = await db
            .select({ count: sql<number>`count(*)` })
            .from(assignments)
            .where(whereClause);

        const totalCount = Number(countResult[0]?.count ?? 0);

        const assignmentsList = await db
            .select({
                ...getTableColumns(assignments),
                class: {
                    id: classes.id,
                    name: classes.name,
                },
                subject: {
                    id: subjects.id,
                    name: subjects.name,
                    code: subjects.code,
                },
                teacher: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                },
                enrolledStudentsCount: sql<number>`(SELECT count(*) FROM ${enrollments} WHERE ${enrollments.classId} = ${assignments.classId})`,
                submissionsCount: sql<number>`(SELECT count(*) FROM ${submissions} WHERE ${submissions.assignmentId} = ${assignments.id})`,
                gradedCount: sql<number>`(SELECT count(*) FROM ${submissions} WHERE ${submissions.assignmentId} = ${assignments.id} AND ${submissions.marks} IS NOT NULL)`,
            })
            .from(assignments)
            .leftJoin(classes, eq(assignments.classId, classes.id))
            .leftJoin(subjects, eq(classes.subjectId, subjects.id))
            .leftJoin(user, eq(classes.teacherId, user.id))
            .where(whereClause)
            .orderBy(desc(assignments.dueDate))
            .limit(limitPerPage)
            .offset(offset);

        // If student, attach their individual submission status
        if (userRole === "student" && assignmentsList.length > 0) {
            const assignmentIds = assignmentsList.map((a) => a.id);
            const studentSubmissions = await db
                .select()
                .from(submissions)
                .where(
                    and(
                        inArray(submissions.assignmentId, assignmentIds),
                        eq(submissions.studentId, userId)
                    )
                );

            const subMap = new Map(studentSubmissions.map((s) => [s.assignmentId, s]));

            const enriched = assignmentsList.map((a) => {
                const mySub = subMap.get(a.id);
                const status = calculateStatus(a.dueDate, mySub);

                return {
                    ...a,
                    mySubmission: mySub ?? null,
                    submissionStatus: status,
                };
            });

            return res.status(200).json({
                data: enriched,
                pagination: {
                    page: currentPage,
                    limit: limitPerPage,
                    total: totalCount,
                    totalPages: Math.ceil(totalCount / limitPerPage),
                },
            });
        }

        // For teachers/admins, calculate overview statistics
        const enriched = assignmentsList.map((a) => {
            const totalEnrolled = Number(a.enrolledStudentsCount ?? 0);
            const totalSubs = Number(a.submissionsCount ?? 0);
            const isPastDue = new Date() > new Date(a.dueDate);
            const missingCount = isPastDue ? Math.max(0, totalEnrolled - totalSubs) : 0;
            const submissionRate = totalEnrolled > 0 ? Math.round((totalSubs / totalEnrolled) * 100) : 0;

            return {
                ...a,
                stats: {
                    totalStudents: totalEnrolled,
                    submissionsCount: totalSubs,
                    gradedCount: Number(a.gradedCount ?? 0),
                    missingCount,
                    submissionRate,
                },
            };
        });

        res.status(200).json({
            data: enriched,
            pagination: {
                page: currentPage,
                limit: limitPerPage,
                total: totalCount,
                totalPages: Math.ceil(totalCount / limitPerPage),
            },
        });
    } catch (error) {
        console.error("GET /assignments error:", error);
        res.status(500).json({ error: "Failed to fetch assignments" });
    }
});

// 2. Get assignments by classId
router.get("/class/:classId", requireSession, async (req, res) => {
    try {
        const classId = Number(req.params.classId);
        if (!Number.isFinite(classId)) {
            return res.status(400).json({ error: "Invalid class id" });
        }

        const userId = req.user!.id;
        const userRole = req.user!.role;

        // Verify class exists and user has authorization
        const [targetClass] = await db
            .select()
            .from(classes)
            .where(eq(classes.id, classId));

        if (!targetClass) {
            return res.status(404).json({ error: "Class not found" });
        }

        if (userRole === "teacher" && targetClass.teacherId !== userId) {
            return res.status(403).json({ error: "Forbidden", message: "You do not teach this class." });
        }

        if (userRole === "student") {
            const [enrollment] = await db
                .select()
                .from(enrollments)
                .where(and(eq(enrollments.classId, classId), eq(enrollments.studentId, userId)));

            if (!enrollment) {
                return res.status(403).json({ error: "Forbidden", message: "You are not enrolled in this class." });
            }
        }

        const classAssignments = await db
            .select({
                ...getTableColumns(assignments),
                enrolledStudentsCount: sql<number>`(SELECT count(*) FROM ${enrollments} WHERE ${enrollments.classId} = ${assignments.classId})`,
                submissionsCount: sql<number>`(SELECT count(*) FROM ${submissions} WHERE ${submissions.assignmentId} = ${assignments.id})`,
                gradedCount: sql<number>`(SELECT count(*) FROM ${submissions} WHERE ${submissions.assignmentId} = ${assignments.id} AND ${submissions.marks} IS NOT NULL)`,
            })
            .from(assignments)
            .where(eq(assignments.classId, classId))
            .orderBy(desc(assignments.dueDate));

        if (userRole === "student" && classAssignments.length > 0) {
            const assignmentIds = classAssignments.map((a) => a.id);
            const studentSubs = await db
                .select()
                .from(submissions)
                .where(
                    and(
                        inArray(submissions.assignmentId, assignmentIds),
                        eq(submissions.studentId, userId)
                    )
                );

            const subMap = new Map(studentSubs.map((s) => [s.assignmentId, s]));

            const enriched = classAssignments.map((a) => {
                const mySub = subMap.get(a.id);
                const status = calculateStatus(a.dueDate, mySub);

                return {
                    ...a,
                    mySubmission: mySub ?? null,
                    submissionStatus: status,
                };
            });

            return res.status(200).json({ data: enriched });
        }

        const enriched = classAssignments.map((a) => {
            const totalEnrolled = Number(a.enrolledStudentsCount ?? 0);
            const totalSubs = Number(a.submissionsCount ?? 0);
            const isPastDue = new Date() > new Date(a.dueDate);
            const missingCount = isPastDue ? Math.max(0, totalEnrolled - totalSubs) : 0;
            const submissionRate = totalEnrolled > 0 ? Math.round((totalSubs / totalEnrolled) * 100) : 0;

            return {
                ...a,
                stats: {
                    totalStudents: totalEnrolled,
                    submissionsCount: totalSubs,
                    gradedCount: Number(a.gradedCount ?? 0),
                    missingCount,
                    submissionRate,
                },
            };
        });

        res.status(200).json({ data: enriched });
    } catch (error) {
        console.error("GET /assignments/class/:classId error:", error);
        res.status(500).json({ error: "Failed to fetch class assignments" });
    }
});

// 3. Get assignment details by ID
router.get("/:id", requireSession, async (req, res) => {
    try {
        const assignmentId = Number(req.params.id);
        if (!Number.isFinite(assignmentId)) {
            return res.status(400).json({ error: "Invalid assignment id" });
        }

        const userId = req.user!.id;
        const userRole = req.user!.role;

        const [assignmentData] = await db
            .select({
                ...getTableColumns(assignments),
                class: {
                    id: classes.id,
                    name: classes.name,
                    teacherId: classes.teacherId,
                },
                subject: {
                    id: subjects.id,
                    name: subjects.name,
                    code: subjects.code,
                },
                teacher: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                },
                enrolledStudentsCount: sql<number>`(SELECT count(*) FROM ${enrollments} WHERE ${enrollments.classId} = ${assignments.classId})`,
                submissionsCount: sql<number>`(SELECT count(*) FROM ${submissions} WHERE ${submissions.assignmentId} = ${assignments.id})`,
            })
            .from(assignments)
            .leftJoin(classes, eq(assignments.classId, classes.id))
            .leftJoin(subjects, eq(classes.subjectId, subjects.id))
            .leftJoin(user, eq(classes.teacherId, user.id))
            .where(eq(assignments.id, assignmentId));

        if (!assignmentData) {
            return res.status(404).json({ error: "Assignment not found" });
        }

        // Authorization check
        if (userRole === "teacher" && assignmentData.class?.teacherId !== userId) {
            return res.status(403).json({ error: "Forbidden", message: "You do not teach the class for this assignment." });
        }

        if (userRole === "student") {
            const [enrollment] = await db
                .select()
                .from(enrollments)
                .where(
                    and(
                        eq(enrollments.classId, assignmentData.classId),
                        eq(enrollments.studentId, userId)
                    )
                );

            if (!enrollment) {
                return res.status(403).json({ error: "Forbidden", message: "You are not enrolled in the class for this assignment." });
            }

            // Get student's own submission
            const [mySub] = await db
                .select()
                .from(submissions)
                .where(
                    and(
                        eq(submissions.assignmentId, assignmentId),
                        eq(submissions.studentId, userId)
                    )
                );

            const status = calculateStatus(assignmentData.dueDate, mySub);

            return res.status(200).json({
                data: {
                    ...assignmentData,
                    mySubmission: mySub ?? null,
                    submissionStatus: status,
                },
            });
        }

        // For Teacher / Admin: calculate comprehensive assignment statistics
        const allSubs = await db
            .select({
                id: submissions.id,
                submittedAt: submissions.submittedAt,
                marks: submissions.marks,
            })
            .from(submissions)
            .where(eq(submissions.assignmentId, assignmentId));

        const totalStudents = Number(assignmentData.enrolledStudentsCount ?? 0);
        const due = new Date(assignmentData.dueDate);
        const now = new Date();

        let submittedCount = 0;
        let lateCount = 0;
        let gradedCount = 0;

        for (const s of allSubs) {
            if (new Date(s.submittedAt) > due) {
                lateCount++;
            } else {
                submittedCount++;
            }
            if (s.marks !== null && s.marks !== undefined) {
                gradedCount++;
            }
        }

        const totalSubmitted = submittedCount + lateCount;
        const isPastDue = now > due;
        const missingCount = isPastDue ? Math.max(0, totalStudents - totalSubmitted) : 0;
        const pendingCount = !isPastDue ? Math.max(0, totalStudents - totalSubmitted) : 0;
        const submissionRate = totalStudents > 0 ? Math.round((totalSubmitted / totalStudents) * 100) : 0;

        res.status(200).json({
            data: {
                ...assignmentData,
                stats: {
                    totalStudents,
                    submittedCount,
                    lateCount,
                    missingCount,
                    pendingCount,
                    gradedCount,
                    submissionRate,
                },
            },
        });
    } catch (error) {
        console.error("GET /assignments/:id error:", error);
        res.status(500).json({ error: "Failed to fetch assignment details" });
    }
});

// 4. Create assignment (teacher/admin only, teacher must own class)
router.post("/", requireSession, requireRole("admin", "teacher"), async (req, res) => {
    try {
        const {
            classId,
            title,
            description,
            dueDate,
            maxMarks,
            attachmentUrl,
            attachmentCldPubId,
            attachmentFileName,
            attachmentFileType,
            attachmentFileSize,
        } = req.body;

        const numClassId = Number(classId);
        const trimmedTitle = typeof title === "string" ? title.trim() : "";
        const trimmedDesc = typeof description === "string" ? description.trim() : null;
        const parsedDueDate = dueDate ? new Date(dueDate) : null;
        const numMaxMarks = maxMarks !== undefined ? Number(maxMarks) : 100;

        if (!Number.isFinite(numClassId)) {
            return res.status(400).json({ error: "Valid Class ID is required." });
        }

        if (!trimmedTitle) {
            return res.status(400).json({ error: "Assignment title is required." });
        }

        if (!parsedDueDate || isNaN(parsedDueDate.getTime())) {
            return res.status(400).json({ error: "A valid due date is required." });
        }

        if (!Number.isFinite(numMaxMarks) || numMaxMarks <= 0) {
            return res.status(400).json({ error: "Maximum marks must be greater than 0." });
        }

        // Verify class exists and check teacher ownership
        const [targetClass] = await db
            .select()
            .from(classes)
            .where(eq(classes.id, numClassId));

        if (!targetClass) {
            return res.status(404).json({ error: "Class not found." });
        }

        const userId = req.user!.id;
        const userRole = req.user!.role;

        if (userRole === "teacher" && targetClass.teacherId !== userId) {
            return res.status(403).json({
                error: "Forbidden",
                message: "You can only create assignments for classes you teach.",
            });
        }

        const [createdAssignment] = await db
            .insert(assignments)
            .values({
                classId: numClassId,
                title: trimmedTitle,
                description: trimmedDesc,
                dueDate: parsedDueDate,
                maxMarks: numMaxMarks,
                attachmentUrl: attachmentUrl || null,
                attachmentCldPubId: attachmentCldPubId || null,
                attachmentFileName: attachmentFileName || null,
                attachmentFileType: attachmentFileType || null,
                attachmentFileSize: attachmentFileSize ? Number(attachmentFileSize) : null,
            })
            .returning();

        res.status(201).json({
            data: createdAssignment,
            message: "Assignment created successfully.",
        });
    } catch (error) {
        console.error("POST /assignments error:", error);
        res.status(500).json({ error: "Failed to create assignment" });
    }
});

// 5. Update assignment (teacher/admin only, teacher must own class)
router.put("/:id", requireSession, requireRole("admin", "teacher"), async (req, res) => {
    try {
        const assignmentId = Number(req.params.id);
        if (!Number.isFinite(assignmentId)) {
            return res.status(400).json({ error: "Invalid assignment id" });
        }

        const [existing] = await db
            .select({
                assignment: assignments,
                class: classes,
            })
            .from(assignments)
            .leftJoin(classes, eq(assignments.classId, classes.id))
            .where(eq(assignments.id, assignmentId));

        if (!existing || !existing.assignment) {
            return res.status(404).json({ error: "Assignment not found." });
        }

        const userId = req.user!.id;
        const userRole = req.user!.role;

        if (userRole === "teacher" && existing.class?.teacherId !== userId) {
            return res.status(403).json({
                error: "Forbidden",
                message: "You can only edit assignments for classes you teach.",
            });
        }

        const {
            title,
            description,
            dueDate,
            maxMarks,
            attachmentUrl,
            attachmentCldPubId,
            attachmentFileName,
            attachmentFileType,
            attachmentFileSize,
        } = req.body;

        const updateData: Partial<typeof assignments.$inferInsert> = {
            updatedAt: new Date(),
        };

        if (title !== undefined) {
            const trimmedTitle = typeof title === "string" ? title.trim() : "";
            if (!trimmedTitle) {
                return res.status(400).json({ error: "Assignment title cannot be empty." });
            }
            updateData.title = trimmedTitle;
        }

        if (description !== undefined) {
            updateData.description = typeof description === "string" ? description.trim() : null;
        }

        if (dueDate !== undefined) {
            const parsedDueDate = new Date(dueDate);
            if (isNaN(parsedDueDate.getTime())) {
                return res.status(400).json({ error: "Invalid due date." });
            }
            updateData.dueDate = parsedDueDate;
        }

        if (maxMarks !== undefined) {
            const numMaxMarks = Number(maxMarks);
            if (!Number.isFinite(numMaxMarks) || numMaxMarks <= 0) {
                return res.status(400).json({ error: "Maximum marks must be greater than 0." });
            }
            updateData.maxMarks = numMaxMarks;
        }

        if (attachmentUrl !== undefined) {
            updateData.attachmentUrl = attachmentUrl || null;
            updateData.attachmentCldPubId = attachmentCldPubId || null;
            updateData.attachmentFileName = attachmentFileName || null;
            updateData.attachmentFileType = attachmentFileType || null;
            updateData.attachmentFileSize = attachmentFileSize ? Number(attachmentFileSize) : null;
        }

        const [updatedAssignment] = await db
            .update(assignments)
            .set(updateData)
            .where(eq(assignments.id, assignmentId))
            .returning();

        res.status(200).json({
            data: updatedAssignment,
            message: "Assignment updated successfully.",
        });
    } catch (error) {
        console.error("PUT /assignments/:id error:", error);
        res.status(500).json({ error: "Failed to update assignment" });
    }
});

// 6. Delete assignment (teacher/admin only, teacher must own class)
router.delete("/:id", requireSession, requireRole("admin", "teacher"), async (req, res) => {
    try {
        const assignmentId = Number(req.params.id);
        if (!Number.isFinite(assignmentId)) {
            return res.status(400).json({ error: "Invalid assignment id" });
        }

        const [existing] = await db
            .select({
                assignment: assignments,
                class: classes,
            })
            .from(assignments)
            .leftJoin(classes, eq(assignments.classId, classes.id))
            .where(eq(assignments.id, assignmentId));

        if (!existing || !existing.assignment) {
            return res.status(404).json({ error: "Assignment not found." });
        }

        const userId = req.user!.id;
        const userRole = req.user!.role;

        if (userRole === "teacher" && existing.class?.teacherId !== userId) {
            return res.status(403).json({
                error: "Forbidden",
                message: "You can only delete assignments for classes you teach.",
            });
        }

        await db.delete(assignments).where(eq(assignments.id, assignmentId));

        res.status(200).json({
            data: { id: assignmentId },
            message: "Assignment deleted successfully.",
        });
    } catch (error) {
        console.error("DELETE /assignments/:id error:", error);
        res.status(500).json({ error: "Failed to delete assignment" });
    }
});

// 7. Get submissions for an assignment (with all enrolled students and calculated statuses)
router.get("/:id/submissions", requireSession, async (req, res) => {
    try {
        const assignmentId = Number(req.params.id);
        if (!Number.isFinite(assignmentId)) {
            return res.status(400).json({ error: "Invalid assignment id" });
        }

        const userId = req.user!.id;
        const userRole = req.user!.role;

        const [assignmentData] = await db
            .select({
                assignment: assignments,
                class: classes,
            })
            .from(assignments)
            .leftJoin(classes, eq(assignments.classId, classes.id))
            .where(eq(assignments.id, assignmentId));

        if (!assignmentData || !assignmentData.assignment) {
            return res.status(404).json({ error: "Assignment not found." });
        }

        if (userRole === "teacher" && assignmentData.class?.teacherId !== userId) {
            return res.status(403).json({
                error: "Forbidden",
                message: "You can only view submissions for classes you teach.",
            });
        }

        if (userRole === "student") {
            // Student can only see their own submission
            const [mySub] = await db
                .select({
                    ...getTableColumns(submissions),
                    student: {
                        id: user.id,
                        name: user.name,
                        email: user.email,
                        image: user.image,
                    },
                })
                .from(submissions)
                .leftJoin(user, eq(submissions.studentId, user.id))
                .where(
                    and(
                        eq(submissions.assignmentId, assignmentId),
                        eq(submissions.studentId, userId)
                    )
                );

            const status = calculateStatus(assignmentData.assignment.dueDate, mySub);

            return res.status(200).json({
                data: mySub
                    ? [{ ...mySub, status }]
                    : [
                          {
                              id: null,
                              assignmentId,
                              studentId: userId,
                              content: null,
                              submittedAt: null,
                              marks: null,
                              feedback: null,
                              status,
                          },
                      ],
            });
        }

        // Teacher / Admin: Fetch all enrolled students in the class
        const enrolledStudents = await db
            .select({
                studentId: enrollments.studentId,
                name: user.name,
                email: user.email,
                image: user.image,
            })
            .from(enrollments)
            .leftJoin(user, eq(enrollments.studentId, user.id))
            .where(eq(enrollments.classId, assignmentData.assignment.classId));

        // Fetch existing submissions
        const existingSubmissions = await db
            .select({
                ...getTableColumns(submissions),
                student: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    image: user.image,
                },
            })
            .from(submissions)
            .leftJoin(user, eq(submissions.studentId, user.id))
            .where(eq(submissions.assignmentId, assignmentId));

        const subMap = new Map(existingSubmissions.map((s) => [s.studentId, s]));

        // Combine all enrolled students with their submission status
        const fullRoster = enrolledStudents.map((st) => {
            const sub = subMap.get(st.studentId);
            const status = calculateStatus(assignmentData.assignment.dueDate, sub);

            if (sub) {
                return {
                    ...sub,
                    status,
                };
            }

            return {
                id: null,
                assignmentId,
                studentId: st.studentId,
                content: null,
                submittedAt: null,
                marks: null,
                feedback: null,
                attachmentUrl: null,
                attachmentCldPubId: null,
                attachmentFileName: null,
                attachmentFileType: null,
                attachmentFileSize: null,
                student: {
                    id: st.studentId,
                    name: st.name,
                    email: st.email,
                    image: st.image,
                },
                status,
            };
        });

        // Sort: Submitted/Late/Graded first, then Missing, then Pending
        const statusOrder: Record<SubmissionStatus, number> = {
            Graded: 1,
            Submitted: 2,
            Late: 3,
            Missing: 4,
            Pending: 5,
        };

        fullRoster.sort((a, b) => {
            const orderDiff = (statusOrder[a.status] || 99) - (statusOrder[b.status] || 99);
            if (orderDiff !== 0) return orderDiff;
            return (a.student?.name || "").localeCompare(b.student?.name || "");
        });

        res.status(200).json({ data: fullRoster });
    } catch (error) {
        console.error("GET /assignments/:id/submissions error:", error);
        res.status(500).json({ error: "Failed to fetch submissions" });
    }
});

// 8. Submit an answer/attachment to an assignment (student only, must be enrolled)
router.post("/:id/submissions", requireSession, requireRole("student"), async (req, res) => {
    try {
        const assignmentId = Number(req.params.id);
        if (!Number.isFinite(assignmentId)) {
            return res.status(400).json({ error: "Invalid assignment id" });
        }

        const studentId = req.user!.id;
        const {
            content,
            attachmentUrl,
            attachmentCldPubId,
            attachmentFileName,
            attachmentFileType,
            attachmentFileSize,
        } = req.body;

        const trimmedContent = typeof content === "string" ? content.trim() : null;
        const hasText = !!trimmedContent;
        const hasFile = !!attachmentUrl;

        // Must have at least text or file attachment
        if (!hasText && !hasFile) {
            return res.status(400).json({
                error: "Submission cannot be empty. Please provide a text answer or attach a file.",
            });
        }

        const [assignmentData] = await db
            .select()
            .from(assignments)
            .where(eq(assignments.id, assignmentId));

        if (!assignmentData) {
            return res.status(404).json({ error: "Assignment not found." });
        }

        // Verify student is enrolled in the class
        const [enrollment] = await db
            .select()
            .from(enrollments)
            .where(
                and(
                    eq(enrollments.classId, assignmentData.classId),
                    eq(enrollments.studentId, studentId)
                )
            );

        if (!enrollment) {
            return res.status(403).json({
                error: "Forbidden",
                message: "You must be enrolled in this class to submit an assignment.",
            });
        }

        // Check if student already submitted (prevent duplicate row, allow update)
        const [existing] = await db
            .select()
            .from(submissions)
            .where(
                and(
                    eq(submissions.assignmentId, assignmentId),
                    eq(submissions.studentId, studentId)
                )
            );

        if (existing) {
            const [updated] = await db
                .update(submissions)
                .set({
                    content: trimmedContent,
                    attachmentUrl: attachmentUrl !== undefined ? attachmentUrl || null : existing.attachmentUrl,
                    attachmentCldPubId: attachmentCldPubId !== undefined ? attachmentCldPubId || null : existing.attachmentCldPubId,
                    attachmentFileName: attachmentFileName !== undefined ? attachmentFileName || null : existing.attachmentFileName,
                    attachmentFileType: attachmentFileType !== undefined ? attachmentFileType || null : existing.attachmentFileType,
                    attachmentFileSize: attachmentFileSize !== undefined ? (attachmentFileSize ? Number(attachmentFileSize) : null) : existing.attachmentFileSize,
                    submittedAt: new Date(),
                    updatedAt: new Date(),
                })
                .where(eq(submissions.id, existing.id))
                .returning();

            return res.status(200).json({
                data: updated,
                message: "Submission updated successfully.",
            });
        }

        const [created] = await db
            .insert(submissions)
            .values({
                assignmentId,
                studentId,
                content: trimmedContent,
                submittedAt: new Date(),
                attachmentUrl: attachmentUrl || null,
                attachmentCldPubId: attachmentCldPubId || null,
                attachmentFileName: attachmentFileName || null,
                attachmentFileType: attachmentFileType || null,
                attachmentFileSize: attachmentFileSize ? Number(attachmentFileSize) : null,
            })
            .returning();

        res.status(201).json({
            data: created,
            message: "Assignment submitted successfully.",
        });
    } catch (error) {
        console.error("POST /assignments/:id/submissions error:", error);
        res.status(500).json({ error: "Failed to submit assignment" });
    }
});

// 9. Grade a submission (teacher/admin only, teacher must own class)
router.put("/:id/submissions", requireSession, requireRole("admin", "teacher"), async (req, res) => {
    try {
        const assignmentId = Number(req.params.id);
        if (!Number.isFinite(assignmentId)) {
            return res.status(400).json({ error: "Invalid assignment id" });
        }

        const { submissionId, marks, feedback } = req.body;
        const numSubId = Number(submissionId);
        const numMarks = marks !== undefined && marks !== null && marks !== "" ? Number(marks) : null;
        const trimmedFeedback = typeof feedback === "string" ? feedback.trim() : null;

        if (!Number.isFinite(numSubId)) {
            return res.status(400).json({ error: "Valid submissionId is required." });
        }

        const [assignmentData] = await db
            .select({
                assignment: assignments,
                class: classes,
            })
            .from(assignments)
            .leftJoin(classes, eq(assignments.classId, classes.id))
            .where(eq(assignments.id, assignmentId));

        if (!assignmentData || !assignmentData.assignment) {
            return res.status(404).json({ error: "Assignment not found." });
        }

        const userId = req.user!.id;
        const userRole = req.user!.role;

        if (userRole === "teacher" && assignmentData.class?.teacherId !== userId) {
            return res.status(403).json({
                error: "Forbidden",
                message: "You can only grade submissions for classes you teach.",
            });
        }

        if (numMarks !== null) {
            if (!Number.isFinite(numMarks) || numMarks < 0 || numMarks > assignmentData.assignment.maxMarks) {
                return res.status(400).json({
                    error: `Marks must be between 0 and ${assignmentData.assignment.maxMarks}.`,
                });
            }
        }

        const [existingSubmission] = await db
            .select()
            .from(submissions)
            .where(
                and(
                    eq(submissions.id, numSubId),
                    eq(submissions.assignmentId, assignmentId)
                )
            );

        if (!existingSubmission) {
            return res.status(404).json({ error: "Submission not found." });
        }

        const [updatedSubmission] = await db
            .update(submissions)
            .set({
                marks: numMarks,
                feedback: trimmedFeedback,
                updatedAt: new Date(),
            })
            .where(eq(submissions.id, numSubId))
            .returning();

        res.status(200).json({
            data: updatedSubmission,
            message: "Submission graded successfully.",
        });
    } catch (error) {
        console.error("PUT /assignments/:id/submissions error:", error);
        res.status(500).json({ error: "Failed to grade submission" });
    }
});

export default router;
