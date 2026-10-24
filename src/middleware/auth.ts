import { Request, Response, NextFunction } from "express";
import { auth } from "../lib/auth.js";
import { fromNodeHeaders } from "better-auth/node";

/**
 * requireSession — extracts the Better Auth session from cookies/headers,
 * attaches req.user = { id, role } if authenticated.
 * Returns 401 if no valid session exists.
 */
export const requireSession = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const session = await auth.api.getSession({
            headers: fromNodeHeaders(req.headers),
        });

        if (!session || !session.user) {
            return res.status(401).json({ error: "Unauthorized", message: "You must be logged in." });
        }

        // A suspended account keeps a valid cookie until it expires, so check the flag on every request.
        if ((session.user as unknown as { status?: string }).status === "suspended") {
            return res.status(403).json({
                error: "Forbidden",
                code: "ACCOUNT_SUSPENDED",
                message: "This account has been suspended. Contact an administrator.",
            });
        }

        req.user = {
            id: session.user.id,
            role: (session.user as unknown as { role: "admin" | "teacher" | "student" }).role ?? "student",
        };

        next();
    } catch (error) {
        console.error("requireSession error:", error);
        return res.status(401).json({ error: "Unauthorized", message: "Session validation failed." });
    }
};

/**
 * requireRole — after requireSession, checks that req.user.role is in the allowed list.
 * Returns 403 if the user's role is not permitted.
 */
export const requireRole = (...roles: Array<"admin" | "teacher" | "student">) => {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized", message: "You must be logged in." });
        }

        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                error: "Forbidden",
                message: `This action requires one of the following roles: ${roles.join(", ")}.`,
            });
        }

        next();
    };
};
