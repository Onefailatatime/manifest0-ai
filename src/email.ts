// Short emails from EMAIL_FROM through Resend: sign-in links (src/auth.ts) and the beta application confirmation (src/landing.ts).
// Report emails with attachments are sent by the agent (src/visit-agent.ts).

type MailEnv = { RESEND_API_KEY?: string; EMAIL_FROM: string };

/** One short email with a single button. Without RESEND_API_KEY (local dev, tests) it is logged instead of sent. */
export async function sendEmail(env: MailEnv, to: string, mail: { subject: string; lines: string[]; button?: { label: string; url: string }; footer?: string }) {
  if (!env.RESEND_API_KEY) {
    console.log(`Email to ${to}: ${mail.subject}${mail.button ? ` ${mail.button.url}` : ""}`);
    return;
  }
  const font = "font-family:system-ui,sans-serif";
  const html = mail.lines.map((l) => `<p style="${font}">${esc(l)}</p>`).join("") +
    (mail.button ? `<p><a href="${esc(mail.button.url)}" style="display:inline-block;background:#0b1f3a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;${font}">${esc(mail.button.label)}</a></p>` : "") +
    (mail.footer ? `<p style="${font};font-size:12px;color:#5a6372">${esc(mail.footer)}</p>` : "");
  const text = [...mail.lines, mail.button ? `${mail.button.label}: ${mail.button.url}` : "", mail.footer ?? ""].filter(Boolean).join("\n\n");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: mail.subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
