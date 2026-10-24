/**
 * Create, promote or recover an ADMIN account. This is the only way to get the first admin
 * (later admins can be promoted from the People page).
 *
 *   List current admins (changes nothing):
 *     npm run create-admin
 *
 *   Make an admin (creates the account if it does not exist yet):
 *     ADMIN_CONFIRM=yes ADMIN_PASSWORD='ChooseAStrongOne1' npm run create-admin -- you@example.com "Your Name"
 *     PowerShell:  $env:ADMIN_CONFIRM="yes"; $env:ADMIN_PASSWORD="ChooseAStrongOne1"; npm run create-admin -- you@example.com "Your Name"
 *
 *   Promote someone who already registered in the app (no password change):
 *     ADMIN_CONFIRM=yes npm run create-admin -- person@example.com
 *
 *   Forgot an admin password: run it again for that email with a new ADMIN_PASSWORD.
 *
 * It writes to whatever database DATABASE_URL points at, hence the ADMIN_CONFIRM opt-in.
 *
 * Why a script and not an environment variable such as ADMIN_EMAILS? Emails are not verified at
 * sign-up, so "anyone who registers with this address becomes admin" would let an attacker who
 * registers first take over. Anyone who can run this already has database access, and the change
 * is written to the audit log.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { auth } from "../src/lib/auth.js";
import { db, pool } from "../src/db/index.js";
import { user } from "../src/db/schema/auth.js";
import { recordAudit } from "../src/lib/audit.js";

async function main() {
    const email = process.argv[2]?.trim().toLowerCase();
    const name = process.argv[3]?.trim();
    const password = process.env.ADMIN_PASSWORD;

    if (!email) {
        const admins = await db.select({ name: user.name, email: user.email, status: user.status }).from(user).where(eq(user.role, "admin"));
        console.log(admins.length === 0 ? "No admins yet." : "Current admins:");
        for (const a of admins) console.log(` - ${a.name} <${a.email}> (${a.status})`);
        console.log('\nCreate one: ADMIN_CONFIRM=yes ADMIN_PASSWORD="..." npm run create-admin -- you@example.com "Your Name"');
        return;
    }

    if (process.env.ADMIN_CONFIRM !== "yes") {
        console.error(`Refusing to run: this writes to the database in DATABASE_URL.\nRe-run with ADMIN_CONFIRM=yes to make ${email} an admin.`);
        process.exitCode = 1;
        return;
    }
    if (password !== undefined && password.length < 8) {
        console.error("ADMIN_PASSWORD must be at least 8 characters.");
        process.exitCode = 1;
        return;
    }

    let [target] = await db.select().from(user).where(eq(user.email, email));

    if (!target) {
        if (!password) {
            console.error(`No account with email ${email}.\nEither register it in the app first, or set ADMIN_PASSWORD (and optionally a name) to create it here.`);
            process.exitCode = 1;
            return;
        }
        // Goes through Better Auth so the password is hashed exactly like a normal sign-up.
        await auth.api.signUpEmail({ body: { name: name || email.split("@")[0]!, email, password } });
        [target] = await db.select().from(user).where(eq(user.email, email));
        console.log(`Created account for ${email}.`);
    } else if (password) {
        const ctx = await auth.$context;
        await ctx.internalAdapter.updatePassword(target.id, await ctx.password.hash(password));
        console.log(`Password updated for ${email}.`);
    }

    if (!target) throw new Error("Could not create the account.");
    if (target.role === "admin" && target.status === "active") {
        console.log(`${target.name} <${target.email}> is an admin. You can sign in.`);
        return;
    }

    await db.transaction(async (tx) => {
        await tx.update(user).set({ role: "admin", status: "active", teacherRequestedAt: null, teacherRequestNote: null }).where(eq(user.id, target!.id));
        await recordAudit(tx, {
            actorId: null,
            action: "admin_created",
            targetId: target!.id,
            detail: { name: target!.name, email: target!.email, from: target!.role, via: "create-admin script" },
        });
    });
    console.log(`${target.name} <${target.email}> is now an admin (was ${target.role}). You can sign in.`);
}

main()
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
