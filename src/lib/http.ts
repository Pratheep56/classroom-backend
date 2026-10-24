import type { Response } from "express";

/** Postgres error code, whether the driver error is wrapped (Drizzle) or not. */
const pgCode = (error: unknown): string | undefined => {
    const e = error as { code?: string; cause?: { code?: string } } | null;
    return e?.code ?? e?.cause?.code;
};

/**
 * 500 response for a failed route. If Postgres says a column, table or type does not exist
 * (42703 / 42P01 / 42704) the database has not had the latest migration, which is the most common
 * mistake after pulling new code, so say that instead of a generic failure.
 */
export const failWith = (res: Response, error: unknown, fallback: string) => {
    const code = pgCode(error);
    if (code === "42703" || code === "42P01" || code === "42704") {
        return res.status(500).json({
            error: fallback,
            code: "MIGRATION_REQUIRED",
            message: "The database is missing the latest changes. Run `npm run db:migrate` against this database, then restart the API.",
        });
    }
    // Outside production, show the underlying database message so local problems are diagnosable from the page.
    if (process.env.NODE_ENV !== "production") {
        const e = error as { message?: string; cause?: { message?: string } } | null;
        return res.status(500).json({ error: fallback, message: `${fallback}: ${e?.cause?.message ?? e?.message ?? "unknown error"}` });
    }
    return res.status(500).json({ error: fallback });
};
