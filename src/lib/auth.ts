import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "../db/index.js";
import * as schema from "../db/schema/auth.js";

export const auth = betterAuth({
    secret: process.env.BETTER_AUTH_SECRET!,
    trustedOrigins: [process.env.FRONTEND_URL!],
    database: drizzleAdapter(db, {
        provider: "pg",
        schema,
    }),
    emailAndPassword: {
        enabled: true,
        sendResetPassword: async ({ user, url, token }, request) => {
            console.log(`====================================================`);
            console.log(`[Better Auth] Password Reset requested for: ${user.email}`);
            console.log(`[Better Auth] Reset Password URL: ${url}`);
            console.log(`[Better Auth] Token: ${token}`);
            console.log(`====================================================`);
            // When SMTP / Resend / Email provider is configured, email delivery occurs here
        },
    },
    user: {
        additionalFields: {
            role: {
                type: "string",
                required: true,
                defaultValue: "student",
                input: true,
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
                    // Block admin role from public registration — downgrade to student
                    const role = (user as unknown as Record<string, unknown>).role;
                    if (role === "admin") {
                        return {
                            data: {
                                ...user,
                                role: "student",
                            },
                        };
                    }
                    return { data: user };
                },
            },
        },
    },
});