/**
 * Demo data for presentations: one admin, three teachers, twelve students, a few departments,
 * subjects, classes, assignments (past + upcoming) and graded / late / missing submissions.
 *
 * It WRITES to whatever database DATABASE_URL points at, so it refuses to run unless you opt in:
 *
 *   SEED_CONFIRM=yes npm run seed        (PowerShell:  $env:SEED_CONFIRM="yes"; npm run seed)
 *
 * Safe to re-run: users are looked up by email and the other tables are only filled when empty.
 * Every demo account uses the password below.
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { auth } from "../src/lib/auth.js";
import { db, pool } from "../src/db/index.js";
import { user } from "../src/db/schema/auth.js";
import {
    assignments,
    classes,
    departments,
    enrollments,
    subjects,
    submissions,
} from "../src/db/schema/app.js";

const PASSWORD = "Demo@1234";
const DAY = 86_400_000;
const daysFromNow = (d: number) => new Date(Date.now() + d * DAY);

type Role = "admin" | "teacher" | "student";

async function ensureUser(name: string, email: string, role: Role): Promise<string> {
    const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (existing) return existing.id;

    // Goes through Better Auth so the password is hashed exactly like a real sign-up.
    const created = await auth.api.signUpEmail({ body: { name, email, password: PASSWORD } });
    // Sign-up always creates a student (admin is blocked by a hook); promote afterwards.
    if (role !== "student") await db.update(user).set({ role }).where(eq(user.id, created.user.id));
    return created.user.id;
}

async function main() {
    if (process.env.SEED_CONFIRM !== "yes") {
        const host = new URL(process.env.DATABASE_URL!).host;
        console.error(`Refusing to seed database at "${host}". Re-run with SEED_CONFIRM=yes to continue.`);
        process.exit(1);
    }

    console.log("Seeding users…");
    const adminId = await ensureUser("Ada Admin", "admin@classflow.demo", "admin");
    const teachers = await Promise.all(
        [
            ["Dr. Meera Iyer", "meera@classflow.demo"],
            ["Prof. Arjun Rao", "arjun@classflow.demo"],
            ["Ms. Sara Thomas", "sara@classflow.demo"],
        ].map(([n, e]) => ensureUser(n!, e!, "teacher"))
    );
    const studentNames = [
        "Aarav Patel", "Diya Sharma", "Kabir Singh", "Ananya Nair", "Rohan Das", "Ishita Verma",
        "Vihaan Reddy", "Meghna Pillai", "Aditya Kumar", "Sneha Joshi", "Karthik Menon", "Priya Desai",
    ];
    const students = await Promise.all(
        studentNames.map((n, i) => ensureUser(n, `student${i + 1}@classflow.demo`, "student"))
    );

    const [{ count: classCount } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(classes);
    if (Number(classCount) > 0) {
        console.log("Classes already exist – skipping academic data. Users are ready.");
        return finish();
    }

    console.log("Seeding departments, subjects, classes…");
    const [cs, math, eng] = await db
        .insert(departments)
        .values([
            { code: "CS", name: "Computer Science", description: "Computing, software and data" },
            { code: "MATH", name: "Mathematics", description: "Pure and applied mathematics" },
            { code: "ENG", name: "English", description: "Language, literature and writing" },
        ])
        .returning();

    const subjectRows = await db
        .insert(subjects)
        .values([
            { departmentId: cs!.id, code: "CS101", name: "Intro to Programming", description: "Fundamentals with Python" },
            { departmentId: cs!.id, code: "CS240", name: "Web Development", description: "HTML, CSS, JavaScript and React" },
            { departmentId: math!.id, code: "MA110", name: "Calculus I", description: "Limits, derivatives, integrals" },
            { departmentId: math!.id, code: "MA220", name: "Statistics", description: "Probability and inference" },
            { departmentId: eng!.id, code: "EN105", name: "Academic Writing", description: "Essays and research writing" },
        ])
        .returning();
    const [prog, web, calc, stats, writing] = subjectRows;

    const classRows = await db
        .insert(classes)
        .values([
            { name: "Python for Beginners – Section A", subjectId: prog!.id, teacherId: teachers[0]!, inviteCode: "PYTHON01", capacity: 30, description: "Start coding with Python: variables, loops, functions." },
            { name: "Full-Stack Web Dev Studio", subjectId: web!.id, teacherId: teachers[0]!, inviteCode: "WEBDEV02", capacity: 25, description: "Build and deploy a React + Express app." },
            { name: "Calculus I – Morning", subjectId: calc!.id, teacherId: teachers[1]!, inviteCode: "CALC1003", capacity: 40, description: "Differentiation and integration with applications." },
            { name: "Practical Statistics", subjectId: stats!.id, teacherId: teachers[1]!, inviteCode: "STATS004", capacity: 35, description: "Data, distributions and hypothesis testing." },
            { name: "Essay Workshop", subjectId: writing!.id, teacherId: teachers[2]!, inviteCode: "WRITE005", capacity: 20, description: "Argument, structure and polish." },
        ])
        .returning();

    // Every student joins 2–3 classes; the first class is the most popular.
    const enrol: { studentId: string; classId: number }[] = [];
    students.forEach((sid, i) => {
        const picks = new Set([0, 1 + (i % 4), i % 3 === 0 ? 4 : 2]);
        picks.forEach((c) => enrol.push({ studentId: sid, classId: classRows[c]!.id }));
    });
    await db.insert(enrollments).values(enrol).onConflictDoNothing();

    console.log("Seeding assignments and submissions…");
    const templates: Array<[number, string, string, number, number]> = [
        // [class index, title, description, due in days (negative = past), max marks]
        [0, "Hello, Python!", "Write five small programs that print and format text.", -21, 20],
        [0, "Loops & Functions", "Solve the practice set on loops and reusable functions.", -7, 50],
        [0, "Mini Project: Quiz Game", "Build a command-line quiz game. Include a README.", 6, 100],
        [1, "Responsive Landing Page", "Recreate the supplied design with semantic HTML + CSS.", -10, 40],
        [1, "React Todo App", "Components, state and props; deploy it and share the link.", 3, 60],
        [2, "Limits Problem Set", "Problems 1–20 from chapter 2, show your working.", -14, 30],
        [3, "Descriptive Statistics Report", "Analyse the provided dataset and write a one-page report.", -3, 50],
        [4, "Persuasive Essay Draft", "800 words on a topic of your choice.", 9, 100],
    ];
    const assignmentRows = await db
        .insert(assignments)
        .values(
            templates.map(([c, title, description, due, maxMarks]) => ({
                classId: classRows[c]!.id,
                title,
                description,
                dueDate: daysFromNow(due),
                maxMarks,
            }))
        )
        .returning();

    const feedbackBank = [
        "Great structure and clear reasoning.",
        "Solid work – check edge cases next time.",
        "Good effort. Please explain your steps more.",
        "Excellent! Really polished.",
        "Needs more depth in the analysis.",
    ];

    const submissionValues: (typeof submissions.$inferInsert)[] = [];
    assignmentRows.forEach((a, ai) => {
        const enrolledIds = enrol.filter((e) => e.classId === a.classId).map((e) => e.studentId);
        const isPast = new Date(a.dueDate).getTime() < Date.now();
        enrolledIds.forEach((sid, si) => {
            const roll = (si * 7 + ai * 3) % 10; // deterministic "randomness"
            if (isPast && roll === 0) return; // missing
            if (!isPast && roll > 3) return; // future: only a few have submitted
            const late = isPast && roll === 1;
            const submittedAt = new Date(new Date(a.dueDate).getTime() + (late ? 1 : -1) * ((roll + 1) * 3_600_000));
            const graded = isPast && roll !== 2; // leave a few ungraded for the grading queue
            const pct = 45 + ((si * 13 + ai * 17) % 55);
            submissionValues.push({
                assignmentId: a.id,
                studentId: sid,
                content: `Submission for “${a.title}” – see the attached work and notes.`,
                submittedAt,
                ...(graded
                    ? { marks: Math.round((pct / 100) * a.maxMarks), feedback: feedbackBank[(si + ai) % feedbackBank.length]! }
                    : {}),
            });
        });
    });
    await db.insert(submissions).values(submissionValues).onConflictDoNothing();

    console.log(`Done: ${students.length} students, ${teachers.length} teachers, ${classRows.length} classes, ${assignmentRows.length} assignments, ${submissionValues.length} submissions.`);
    return finish();
}

async function finish() {
    console.log(`\nDemo logins (password: ${PASSWORD})`);
    console.log("  admin    admin@classflow.demo");
    console.log("  teacher  meera@classflow.demo");
    console.log("  student  student1@classflow.demo");
    await pool.end();
}

main().catch(async (e) => {
    console.error("Seed failed:", e);
    await pool.end();
    process.exit(1);
});
