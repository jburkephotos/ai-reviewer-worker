// Emails Jeremy the client's filled intake form. Reuses the same Resend env vars
// as the audit tool (RESEND_API_KEY, LEAD_TO, optional LEAD_FROM). Endpoint: /api/intake
export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const data = await request.json();
    // honeypot: humans never see the hp field — if it's filled, a bot did it. Pretend success.
    if (data && data.hp) return json({ ok: true });
    const biz = String((data && data.business) || "a client").slice(0, 120).trim() || "a client";
    if (!env.RESEND_API_KEY || !env.LEAD_TO) {
      return json({ ok: false, error: "Email isn't configured." });
    }
    await sendEmail(env, `📝 New intake — ${biz}`, emailShell(biz, sectionsHtml((data && data.sections) || [])));
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) });
  }
}

function sectionsHtml(sections) {
  if (!Array.isArray(sections) || !sections.length)
    return `<div style="font:400 14px Georgia,serif;color:#777">(no answers were filled in)</div>`;
  return sections.map(s => {
    const rows = (s.items || []).map(it => `<tr>
      <td valign="top" style="padding:6px 14px 6px 0;font:700 13px Georgia,serif;color:#1a1d1c">${esc(it.q)}</td>
      <td valign="top" style="padding:6px 0;border-bottom:1px solid #ece9e0;font:400 14px Georgia,serif;color:#444">${esc(it.v)}</td></tr>`).join("");
    return `<div style="font:600 11px monospace;letter-spacing:2px;text-transform:uppercase;color:#2f4a3e;margin:22px 0 8px">${esc(s.name)}</div>
      <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4ece0" style="border:1px solid #e2dfd6;border-radius:4px"><tr><td style="padding:12px 16px">
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr></table>`;
  }).join("");
}

function emailShell(biz, inner) {
  return `<div style="background:#e8e6df;padding:24px 0;font-family:Georgia,serif"><table align="center" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto"><tr><td style="padding:0 24px">
    <div style="font:600 11px monospace;letter-spacing:2px;text-transform:uppercase;color:#cf6a28;margin:0 0 4px">J. Burke Photos &middot; New Project Intake</div>
    <div style="font:700 32px Georgia,serif;color:#1a1d1c;border-bottom:2px solid #1a1d1c;padding:0 0 12px">${esc(biz)}</div>
    <div style="font:400 13px Georgia,serif;color:#666;margin:12px 0 14px">A client just submitted the intake form.</div>
    ${inner}
    <div style="border-top:2px solid #1a1d1c;margin:28px 0 0;padding:14px 0 0;font:400 12px Georgia,serif;color:#999">Submitted via the /intake form &middot; reply straight to the client at their email above.</div>
  </td></tr></table></div>`;
}

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

async function sendEmail(env, subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: env.LEAD_FROM || "AI Review <onboarding@resend.dev>", to: [env.LEAD_TO], subject, html }),
  });
  if (!r.ok) throw new Error("resend " + r.status);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
export async function onRequestOptions() {
  return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" } });
}
