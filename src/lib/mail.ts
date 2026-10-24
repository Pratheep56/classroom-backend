/**
 * Minimal transactional email through Resend's HTTP API (plain fetch, no extra package).
 * Enabled only when RESEND_API_KEY is set; otherwise callers fall back to the admin-assisted
 * reset flow (People page), so the app still works with no email provider at all.
 */
export const mailEnabled = () => Boolean(process.env.RESEND_API_KEY);

export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
    if (!mailEnabled()) return false;
    try {
        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                from: process.env.MAIL_FROM || "ClassFlow <onboarding@resend.dev>",
                to,
                subject,
                text,
            }),
        });
        if (!res.ok) console.error(`[mail] Resend rejected the message (${res.status})`);
        return res.ok;
    } catch (error) {
        console.error("[mail] send failed:", error);
        return false;
    }
}
