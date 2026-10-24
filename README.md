# ClassFlow – Backend API

REST API for the ClassFlow classroom management app: departments → subjects → classes, enrollments by invite code, assignments with file attachments, submissions and grading, plus role-aware analytics.

**Stack:** Node.js · Express 5 · TypeScript · PostgreSQL · Drizzle ORM · Better Auth · Arcjet

## Getting started

```bash
cp .env.example .env      # fill in DATABASE_URL, ARCJET_KEY, BETTER_AUTH_SECRET, FRONTEND_URL
npm install
npm run db:migrate        # apply the SQL migrations in /drizzle
npm run dev               # http://localhost:8000
```

| Script | What it does |
|---|---|
| `npm run dev` | Watch mode with `tsx` |
| `npm run build` / `npm start` | Compile to `dist/` and run it (what Render runs) |
| `npm run db:generate` | Create a new migration from schema changes |
| `npm run seed` | Demo data (1 admin, 3 teachers, 12 students, classes, graded work). Needs `SEED_CONFIRM=yes` because it writes to the configured database |

## Architecture

```
src/
  index.ts             app wiring: CORS → Better Auth → JSON → /health → Arcjet → routers
  config/arcjet.ts     shield + bot detection rules
  middleware/
    security.ts        role-based sliding-window rate limit (admin 120, teacher/student 60, guest 30 per minute)
    auth.ts            requireSession, requireRole(...)
  lib/auth.ts          Better Auth (email + password, roles, cross-site cookies in production)
  lib/columns.ts       which user fields are safe to expose publicly
  db/schema/           Drizzle tables: auth (user, session, account, verification) and app (departments … submissions)
  routes/              one router per resource + insights (analytics)
scripts/seed.ts        demo data
```

## Roles

| Role | Can |
|---|---|
| **student** | join classes with an invite code, submit assignments, see own grades and gradebook |
| **teacher** | create/manage own classes and assignments, grade submissions, see class analytics and the grading queue |
| **admin** | everything, plus departments, subjects and the **People** page (approve teachers, change roles, suspend accounts, activity log). Cannot be created through public sign-up |

## API overview (`/api`)

| Area | Endpoints |
|---|---|
| Auth | `/auth/*` handled by Better Auth (sign-up, sign-in, session, password reset) |
| Departments / Subjects | CRUD (admin writes); `/:id/classes`, `/:id/subjects`, `/:id/users` |
| Classes | list/search/filter + pagination, get, create, update, delete, `/:id/users`. Archive via `status: "archived"` |
| Enrollments | `POST /join` (invite code), `POST /`, `GET /my`, `GET /check/:classId` |
| Assignments | CRUD, `/class/:classId`, `/:id/submissions` (submit, list, grade) |
| Users | list, get (access-controlled), `/:id/classes` |
| Stats | `/overview`, `/teacher`, `/student`, `/latest`, `/charts` |
| Insights | `/grading-queue`, `/deadlines`, `/gradebook`, `/class/:id`, `/search` |
| Account | `POST/DELETE /account/teacher-request` (a student asks for, or withdraws, teacher access) |
| Admin | `/admin/summary`, `/admin/users`, `POST /admin/teacher-requests/:id/approve` and `/reject`, `PATCH /admin/users/:id/role` and `/status`, `/admin/audit` (admin only) |
| Health | `GET /health` (not rate limited, for uptime checks) |

## Roles, teacher approval and admins

- **Everyone registers as an active student.** The `role`, `status` and teacher-request fields are `input: false` in `src/lib/auth.ts`, so the client can never write them (not at sign-up and not through Better Auth's `/update-user`). Earlier versions allowed a signed-in user to send `{"role":"admin"}` to `/update-user`; that is fixed.
- **Teacher access is requested, then approved.** Picking "Teacher" at sign-up files a request; the person sees an "awaiting approval" screen (not a student dashboard) until an admin approves or rejects it on **People**. The server still treats the account as a student until then, so no teacher permission is granted early.
- **Creating the first admin (how to log in as admin):** `ADMIN_CONFIRM=yes ADMIN_PASSWORD='StrongPass1' npm run create-admin -- you@example.com "Your Name"` creates the account if needed, sets the password and makes it admin; then sign in normally. With no email argument the script only lists admins. Running it again with a new `ADMIN_PASSWORD` resets a forgotten admin password. Later admins can be promoted from **People**. It is a script rather than an env-var allow-list on purpose: emails are not verified at sign-up, so "this address becomes admin" could be claimed by whoever registers it first.
- **Guard rails:** an admin cannot change their own role or suspend themselves (so there is always at least one active admin), admins must be demoted before they can be suspended, a teacher who still has classes cannot be demoted, and suspending an account deletes its sessions immediately.
- **Audit log:** every approval, rejection, role change, suspension and admin creation is stored in `audit_log` (shown on People, Activity tab).
- **Migration:** `drizzle/0004_account_status_teacher_requests_audit.sql` adds `user.status`, `user.teacher_requested_at`, `user.teacher_request_note` and the `audit_log` table. Run `npm run db:migrate` **before** deploying this code. Existing users keep their roles.

### What each role can do

| | Student | Teacher | Admin |
|---|---|---|---|
| Join classes, submit work, gradebook | yes | no | no |
| Create/edit classes and assignments, grade | no | own classes | all |
| Class analytics, grading queue, clash check | no | own classes | all |
| Departments and subjects (create/edit/delete) | no | no | yes |
| See student emails | no | own classes | yes |
| Approve teachers, change roles, suspend, audit log | no | no | yes |

### Forgot password

ClassFlow has no email service by default, so "Forgot password" cannot deliver anything on its own. Two ways to make it work:

1. **No email provider (default):** the request is recorded. An admin opens **People → Password resets**, sees who asked, creates a one-hour link and sends it to them. Admins can also create a link for anyone from **Everyone → Create password reset link**. Admin accounts are excluded (use `create-admin`).
2. **Real emails:** set `RESEND_API_KEY` (and optionally `MAIL_FROM`) from https://resend.com. The reset link is then emailed automatically. Untested until you add a key.

## Security notes

- Arcjet **shield** + **bot detection** on every request, then a **per-role rate limit**.
- Session cookies are `HttpOnly`; in production `Secure` + `SameSite=None` because the frontend and API live on different domains.
- Invite codes are generated with `crypto.randomBytes` and are only returned to the class's teacher and admins.
- Student emails are hidden from other students; public endpoints never return teacher emails.
- Enrollment capacity is enforced inside a transaction with a row lock, so the last seat can't be double-booked.
- Password-reset links are only logged in development (no email provider is wired up yet).

## Deployment (Render)

Build command `npm install && npm run build`, start command `npm start`. Set `DATABASE_URL`, `ARCJET_KEY`, `BETTER_AUTH_SECRET`, `FRONTEND_URL` (your Vercel origin) and `NODE_ENV=production`. The server listens on `process.env.PORT`.
