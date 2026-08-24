import { Request, Response, NextFunction } from "express";
import aj from "../config/arcjet.js";
import { ArcjetNodeRequest, slidingWindow } from "@arcjet/node";
import { auth } from "../lib/auth.js";
import { fromNodeHeaders } from "better-auth/node";

const securityMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NODE_ENV === "test") return next();
    try {
        // Resolve Better Auth session BEFORE determining rate limit role
        if (!req.user) {
            try {
                const session = await auth.api.getSession({
                    headers: fromNodeHeaders(req.headers),
                });
                if (session?.user) {
                    req.user = {
                        id: session.user.id,
                        role: (session.user as unknown as { role: "admin" | "teacher" | "student" }).role ?? "student",
                    };
                }
            } catch (err) {
                // Session lookup failed or unauthenticated request - continue as guest
            }
        }

        const role = req.user?.role ?? "guest";

        let limit: number;
        let message: string;

        switch (role) {
            case "admin":
                limit = 120;
                message = "Admin request limit exceeded (120 per minute). Slow down.";
                break;
            case "teacher":
                limit = 60;
                message = "Teacher request limit exceeded (60 per minute). Please wait.";
                break;
            case "student":
                limit = 60;
                message = "Student request limit exceeded (60 per minute). Please wait.";
                break;
            default:
                limit = 30;
                message = "Guest request limit exceeded (30 per minute). Please sign in for higher limits.";
        }

        const client = aj.withRule(
            slidingWindow({
                mode: "LIVE",
                interval: "1m",
                max: limit,
            })
        );

        const arcjetResponse: ArcjetNodeRequest = {
            headers: req.headers,
            method: req.method,
            url: req.originalUrl ?? req.url,
            socket: { remoteAddress: req.socket.remoteAddress ?? req.ip ?? "0.0.0.0" },
        };

        const decision = await client.protect(arcjetResponse);

        if (decision.isDenied() && decision.reason.isBot()) {
            return res.status(403).json({
                error: "Forbidden",
                message: "Automated requests are not allowed.",
            });
        }

        if (decision.isDenied() && decision.reason.isShield()) {
            return res.status(403).json({
                error: "Forbidden",
                message: "Requests blocked by security policy.",
            });
        }

        if (decision.isDenied() && decision.reason.isRateLimit()) {
            return res.status(429).json({
                error: "Too many requests.",
                message,
            });
        }

        next();
    } catch (e) {
        console.error("Arcjet middleware error:", e);
        res.status(500).json({ error: "Internal error", message: "Something went wrong with security middleware" });
    }
};

export default securityMiddleware;