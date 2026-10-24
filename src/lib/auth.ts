import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import * as schema from "../db/schema/auth.js";
import { mailEnabled, sendMail } from "./mail.js";

const isProduction = process.env.NODE_ENV === "production";

export const auth = betterAuth({
    secret: process.env.BETTER_AUTH_SECRET!,
    trustedOrigins: [process.env.FRONTEND_URL!],
    // In production the frontend (Vercel) and API (Render) are different sites, so the session
    // cookie must be SameSite=None; Secure or the browser will not send it on API calls.
    advanced: {
        useSecureCookies: isProduction,
        defaultCookieAttributes: isProduction
            ? { sameSite: "none", secure: true, httpOnly: true }
            : { sameSite: "lax", httpOnly: true },
    },
    database: drizzleAdapter(db, {
        provider: "pg",
        schema,
    }),
    emailAndPassword: {
        enabled: true,
        sendResetPassword: async ({ user, url }) => {
            // With RESEND_API_KEY the link is emailed. Without it the request is still recorded
            // (Better Auth stores the token), so an admin can issue the link from the People page.
            // In development the link is also printed; in production it is never logged (it is a credential).
            if (mailEnabled()) {
                await sendMail(
                    user.email,
                    "Reset your ClassFlow password",
                    `Hi ${user.name},\n\nUse this link to choose a new password (valid for 1 hour):\n${url}\n\nIf you did not ask for this, ignore this email.`
                );
            } else if (!isProduction) {
                console.log(`[Better Auth] Password reset for ${user.email}: ${url}`);
            }
        },
    },
    user: {
        // SECURITY: none of these may be written by the client (input: false). Better Auth's
        // /update-user endpoint accepts every field that allows input, so a writable `role`
        // would let any signed-in user make themselves admin. Roles and status change only
        // through the admin routes (routes/admin.ts) or scripts/create-admin.ts.
        additionalFields: {
            role: {
                type: "string",
                required: true,
                defaultValue: "student",
                input: false,
            },
            status: {
                type: "string",
                required: true,
                defaultValue: "active",
                input: false,
            },
            teacherRequestedAt: {
                type: "date",
                required: false,
                input: false,
            },
            teacherRequestNote: {
                type: "string",
                required: false,
                input: false,
            },
            imageCldPubId: {
                type: "string",
                required: false,
                input: true,
            },
        },
    },
    databaseHooks: {
        user: {
            create: {
                before: async (user) => {
                    // Everyone starts as an active student, whatever the request body said.
                    // Teacher access is requested afterwards and approved by an admin.
                    return { data: { ...user, role: "student", status: "active" } };
                },
            },
        },
    },
});
