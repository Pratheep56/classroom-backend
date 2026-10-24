import { auditLog } from "../db/schema/app.js";

/** Anything with `.insert`, i.e. the db itself or a transaction handle. */
type Writer = { insert: (typeof import("../db/index.js"))["db"]["insert"] };

export type AuditAction =
    | "teacher_request_approved"
    | "teacher_request_rejected"
    | "role_changed"
    | "account_suspended"
    | "account_reactivated"
    | "admin_created"
    | "password_reset_link_issued";

/**
 * Append one row to the audit log. Pass the transaction handle so the log entry commits or
 * rolls back together with the change it describes.
 */
export const recordAudit = async (
    tx: Writer,
    entry: { actorId: string | null; action: AuditAction; targetId: string; detail: Record<string, unknown> }
) => {
    await tx.insert(auditLog).values(entry);
};
