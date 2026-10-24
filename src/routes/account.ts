import express from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/schema/auth.js";
import { requireSession } from "../middleware/auth.js";
import { failWith } from "../lib/http.js";

/** Self-service account actions for the signed-in user. */
const router = express.Router();

// A student asks for teacher access; an admin approves it in routes/admin.ts.
router.post("/teacher-request", requireSession, async (req, res) => {
    try {
        const [me] = await db
            .select({ role: user.role, requested: user.teacherRequestedAt })
            .from(user)
            .where(eq(user.id, req.user!.id));
        if (!me) return res.status(404).json({ error: "User not found." });

        if (me.role !== "student") {
            return res.status(409).json({ error: "Conflict", message: "Only student accounts can request teacher access." });
        }
        if (me.requested) {
            return res.status(409).json({ error: "Conflict", message: "You have already requested teacher access." });
        }

        const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 300) : "";
        const requestedAt = new Date();
        await db.update(user).set({ teacherRequestedAt: requestedAt, teacherRequestNote: note || null }).where(eq(user.id, req.user!.id));

        res.status(201).json({ data: { teacherRequestedAt: requestedAt, teacherRequestNote: note || null } });
    } catch (error) {
        console.error("POST /account/teacher-request error:", error);
        failWith(res, error, "Failed to submit request");
    }
});

router.delete("/teacher-request", requireSession, async (req, res) => {
    try {
        await db
            .update(user)
            .set({ teacherRequestedAt: null, teacherRequestNote: null })
            .where(eq(user.id, req.user!.id));
        res.status(200).json({ data: { teacherRequestedAt: null } });
    } catch (error) {
        console.error("DELETE /account/teacher-request error:", error);
        failWith(res, error, "Failed to withdraw request");
    }
});

export default router;
