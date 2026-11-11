// Outgoing email via Resend (env RESEND_API_KEY, EMAIL_FROM).
// Without a key, emails are printed to the server log instead so local testing still works.

const { site: studio } = require("./config");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function wrap(title, paragraphs, button) {
  const ps = paragraphs.filter(Boolean).map((p) => `<p style="margin:0 0 14px;line-height:1.55">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const btn = button
    ? `<p style="margin:22px 0"><a href="${esc(button.url)}" style="background:#c0392b;color:#ffffff;border:1px solid #962d22;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">${esc(button.label)}</a></p>`
    : "";
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a">
<p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c0392b;margin:0 0 8px">${esc(studio.name)}</p>
<h1 style="font-size:22px;margin:0 0 18px">${esc(title)}</h1>${ps}${btn}
<p style="font-size:12px;color:#777;margin-top:28px">${esc(studio.name)} · ${esc(studio.siteUrl)}</p></div>`;
}

const emailReady = () => Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);

async function sendEmail({ to, subject, title, paragraphs, button, replyTo }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { skipped: true };
  const text = [title, "", ...paragraphs.filter(Boolean), button ? `${button.label}: ${button.url}` : ""].join("\n\n");

  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    console.log(`\n[email:dev] to=${recipients.join(", ")} subject="${subject}"\n${text}\n`);
    return { dev: true };
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM, to: recipients, subject, text,
        html: wrap(title, paragraphs, button),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!r.ok) console.error("[email] send failed", r.status, await r.text());
    return { ok: r.ok };
  } catch (e) {
    // Email trouble must never lose a booking request.
    console.error("[email] error", e.message);
    return { ok: false };
  }
}

module.exports = { sendEmail, emailReady };
