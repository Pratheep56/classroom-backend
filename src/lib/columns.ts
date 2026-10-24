import type { Request } from "express";
import { user } from "../db/schema/auth.js";

/** Teacher fields safe to show to anyone (no email, no verification flags). */
export const publicUserColumns = {
    id: user.id,
    name: user.name,
    image: user.image,
    imageCldPubId: user.imageCldPubId,
    role: user.role,
};

/** Adds email for requests that carry a valid session. */
export const memberUserColumns = {
    ...publicUserColumns,
    email: user.email,
};

/** Public endpoints call this so anonymous visitors never receive teacher emails. */
export const userColumnsFor = (req: Request) =>
    req.user ? memberUserColumns : publicUserColumns;

/** Students may see classmates/teachers by name, but never other people's email addresses. */
export const stripEmailForStudents =
    (viewerRole?: "admin" | "teacher" | "student") =>
    <T extends { email?: string | null; emailVerified?: boolean }>(row: T): T =>
        viewerRole === "student" ? { ...row, email: undefined, emailVerified: undefined } : row;
