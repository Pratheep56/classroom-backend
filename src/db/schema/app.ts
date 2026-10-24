import {
    integer, jsonb, pgEnum, pgTable, text,
    timestamp, unique, varchar, index, primaryKey
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { user } from "./auth.js";

export const classStatusEnum = pgEnum('class_status', ['active', 'inactive', 'archived']);

const timestamps = {
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().$onUpdate(() => new Date()).notNull()
};

export const departments = pgTable('departments', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    code: varchar('code', { length: 50 }).notNull().unique(),
    name: varchar('name', { length: 255 }).notNull(),
    description: varchar('description', { length: 255 }),
    ...timestamps
});

export const subjects = pgTable('subjects', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    departmentId: integer('department_id').notNull().references(() => departments.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 255 }).notNull(),
    code: varchar('code', { length: 50 }).notNull().unique(),
    description: varchar('description', { length: 255 }),
    ...timestamps
});

export const classes = pgTable('classes', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    subjectId: integer('subject_id').notNull().references(() => subjects.id, { onDelete: 'cascade' }),
    teacherId: text('teacher_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
    inviteCode: text('invite_code').notNull().unique(),
    name: varchar('name', { length: 255 }).notNull(),
    bannerCldPubId: text('banner_cld_pub_id'),
    bannerUrl: text('banner_url'),
    description: text('description'),
    capacity: integer('capacity').default(50).notNull(),
    status: classStatusEnum('status').default('active').notNull(),
    schedules: jsonb('schedules').$type<any[]>().default([]).notNull(),
    ...timestamps
}, (table) => [
    index('classes_subject_id_idx').on(table.subjectId),
    index('classes_teacher_id_idx').on(table.teacherId),
]);

export const enrollments = pgTable('enrollments', {
    studentId: text('student_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    classId: integer('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
}, (table) => [
    primaryKey({ columns: [table.studentId, table.classId] }),
    unique('enrollments_student_id_class_id_unique').on(table.studentId, table.classId),
    index('enrollments_student_id_idx').on(table.studentId),
    index('enrollments_class_id_idx').on(table.classId),
]);

export const assignments = pgTable('assignments', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    classId: integer('class_id').notNull().references(() => classes.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    dueDate: timestamp('due_date').notNull(),
    maxMarks: integer('max_marks').notNull().default(100),
    attachmentUrl: text('attachment_url'),
    attachmentCldPubId: text('attachment_cld_pub_id'),
    attachmentFileName: varchar('attachment_file_name', { length: 255 }),
    attachmentFileType: varchar('attachment_file_type', { length: 50 }),
    attachmentFileSize: integer('attachment_file_size'),
    ...timestamps
}, (table) => [
    index('assignments_class_id_idx').on(table.classId),
]);

export const submissions = pgTable('submissions', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    assignmentId: integer('assignment_id').notNull().references(() => assignments.id, { onDelete: 'cascade' }),
    studentId: text('student_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    content: text('content'),
    submittedAt: timestamp('submitted_at').defaultNow().notNull(),
    marks: integer('marks'),
    feedback: text('feedback'),
    attachmentUrl: text('attachment_url'),
    attachmentCldPubId: text('attachment_cld_pub_id'),
    attachmentFileName: varchar('attachment_file_name', { length: 255 }),
    attachmentFileType: varchar('attachment_file_type', { length: 50 }),
    attachmentFileSize: integer('attachment_file_size'),
    ...timestamps
}, (table) => [
    unique('submissions_assignment_id_student_id_unique').on(table.assignmentId, table.studentId),
    index('submissions_assignment_id_idx').on(table.assignmentId),
    index('submissions_student_id_idx').on(table.studentId),
]);

// Who did what to whom: every role, status and teacher-request change made by an admin.
export const auditLog = pgTable('audit_log', {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    // Null when the change came from the create-admin script rather than a signed-in admin.
    actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 50 }).notNull(),
    targetId: text('target_id').references(() => user.id, { onDelete: 'set null' }),
    // Names/emails are copied in so the log still reads correctly after an account is deleted.
    detail: jsonb('detail').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
    index('audit_log_created_at_idx').on(table.createdAt),
]);

// Relationships
export const departmentRelations = relations(departments, ({ many }) => ({ subjects: many(subjects) }));

export const subjectsRelations = relations(subjects, ({ one, many }) => ({
    department: one(departments, {
        fields: [subjects.departmentId],
        references: [departments.id],
    }),
    classes: many(classes)
}));

export const classesRelations = relations(classes, ({ one, many }) => ({
    subject: one(subjects, {
        fields: [classes.subjectId],
        references: [subjects.id],
    }),
    teacher: one(user, {
        fields: [classes.teacherId],
        references: [user.id],
    }),
    enrollments: many(enrollments),
    assignments: many(assignments),
}));

export const enrollmentsRelations = relations(enrollments, ({ one }) => ({
    student: one(user, {
        fields: [enrollments.studentId],
        references: [user.id],
    }),
    class: one(classes, {
        fields: [enrollments.classId],
        references: [classes.id],
    }),
}));

export const assignmentsRelations = relations(assignments, ({ one, many }) => ({
    class: one(classes, {
        fields: [assignments.classId],
        references: [classes.id],
    }),
    submissions: many(submissions),
}));

export const submissionsRelations = relations(submissions, ({ one }) => ({
    assignment: one(assignments, {
        fields: [submissions.assignmentId],
        references: [assignments.id],
    }),
    student: one(user, {
        fields: [submissions.studentId],
        references: [user.id],
    }),
}));

export type Department = typeof departments.$inferSelect;
export type NewDepartment = typeof departments.$inferInsert;

export type Subject = typeof subjects.$inferSelect;
export type NewSubject = typeof subjects.$inferInsert;

export type Class = typeof classes.$inferSelect;
export type NewClass = typeof classes.$inferInsert;

export type Enrollment = typeof enrollments.$inferSelect;
export type NewEnrollment = typeof enrollments.$inferInsert;

export type Assignment = typeof assignments.$inferSelect;
export type NewAssignment = typeof assignments.$inferInsert;

export type AuditLogEntry = typeof auditLog.$inferSelect;

export type Submission = typeof submissions.$inferSelect;
export type NewSubmission = typeof submissions.$inferInsert;