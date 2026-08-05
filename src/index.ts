import express from "express"
import subjectRouter from "./routes/subjects";
import cors from "cors";
import securityMiddleware from "./middleware/security";
import {toNodeHandler} from "better-auth/node";
import {auth} from "./lib/auth";
import usersRouter from "./routes/users"
import classesRouter from "./routes/classes"

const app = express()
const PORT = 8000

if(!process.env.FRONTEND_URL) throw new Error("Missing FRONTEND_URL")

app.use(cors({
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}))

app.all('/api/auth/*splat', toNodeHandler(auth));

app.use(express.json());

app.use(securityMiddleware);

app.use("/api/subjects", subjectRouter);
app.use("/api/users", usersRouter);
app.use("/api/classes", classesRouter);

app.get("/", (req, res) => {
    res.send("Hello, welcome to the Classroom API!");
});

app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
})