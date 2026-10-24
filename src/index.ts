import express from "express";
import subjectRouter from "./routes/subjects.js";
import cors from "cors";
import securityMiddleware from "./middleware/security.js";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import usersRouter from "./routes/users.js";
import classesRouter from "./routes/classes.js";
import departmentsRouter from "./routes/departments.js";
import enrollmentsRouter from "./routes/enrollments.js";
import statsRouter from "./routes/stats.js";
import assignmentsRouter from "./routes/assignments.js";
import insightsRouter from "./routes/insights.js";
import adminRouter from "./routes/admin.js";
import accountRouter from "./routes/account.js";

const app = express();
const PORT = Number(process.env.PORT) || 8000;

if (!process.env.FRONTEND_URL) throw new Error("Missing FRONTEND_URL");

// Render/Vercel sit behind a reverse proxy: trust it so req.ip (used by Arcjet rate limits)
// is the real client IP and not the proxy's.
app.set("trust proxy", 1);

app.use(cors({
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true
}));

app.all('/api/auth/*splat', toNodeHandler(auth));

app.use(express.json());

// Registered before Arcjet so uptime monitors / Render health checks are never rate limited.
app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.use(securityMiddleware);

app.use("/api/subjects", subjectRouter);
app.use("/api/users", usersRouter);
app.use("/api/classes", classesRouter);
app.use("/api/departments", departmentsRouter);
app.use("/api/enrollments", enrollmentsRouter);
app.use("/api/stats", statsRouter);
app.use("/api/assignments", assignmentsRouter);
app.use("/api/insights", insightsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/account", accountRouter);

app.get("/", (req, res) => {
    res.send("Hello, welcome to the Classroom API!");
});

app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});