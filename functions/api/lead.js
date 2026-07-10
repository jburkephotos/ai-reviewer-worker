/**
 * Lead capture — POST /api/lead
 * Receives the qualifying-form submission, stores it, and notifies Jeremy.
 *
 * WHERE LEADS LAND (pick what you wire up — it works without any of them, see below):
 *   Option A (simplest, recommended): set a RESEND_API_KEY secret + LEAD_TO email var,
 *     and each lead is emailed to you instantly. Get a free key at resend.com.
 *   Option B: bind a KV namespace named LEADS in Pages settings, and every lead is
 *     also written there so you have a durable list even if email fails.
 *
 * If NEITHER is set, the endpoint still returns success to the visitor and logs the
 * lead to the Cloudflare function logs (Deployments → your deploy → Functions logs),
 * so you never lose a submission — you just have to read it from the logs until you
 * wire up email or KV. Nothing breaks; the visitor always gets a clean confirmation.
 */

export async function onRequestPost({ request, env }) {
  let lead;
  try {
    lead = await request.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }

  // minimal validation — name + email are the only required fields
  if (!lead || !lead.name || !lead.email) {
    return json({ error: "name and email required" }, 422);
  }

  const record = {
    receivedAt: new Date().toISOString(),
    url: lead.url || "",
    tier: lead.tier || "",
    score: lead.score || "",
    name: String(lead.name).slice(0, 120),
    email: String(lead.email).slice(0, 200),
    business: String(lead.business || "").slice(0, 200),
    works: String(lead.works || "").slice(0, 1000),
    broken: String(lead.broken || "").slice(0, 1000),
    budget: String(lead.budget || "").slice(0, 60),
    mockup: !!lead.mockup,
  };

  // Always log — guarantees the lead is never silently lost.
  console.log("NEW LEAD:", JSON.stringify(record));

  // Option B: durable store in KV if bound
  if (env.LEADS && typeof env.LEADS.put === "function") {
    try {
      await env.LEADS.put(`lead:${record.receivedAt}:${record.email}`, JSON.stringify(record));
    } catch (e) {
      console.log("KV store failed:", String(e));
    }
  }

  // Option A: email via Resend if configured
  if (env.RESEND_API_KEY && env.LEAD_TO) {
    try {
      const scoreStr = record.score && record.score.grade
        ? `${record.score.grade} (${record.score.pct}%)` : String(record.score);
      const body = [
        `New AI Search Audit lead`,
        ``,
        `Name:     ${record.name}`,
        `Email:    ${record.email}`,
        `Business: ${record.business}`,
        `Site:     ${record.url}`,
        `Tier:     ${record.tier}    Score: ${scoreStr}`,
        `Budget:   ${record.budget}`,
        `Mockup:   ${record.mockup ? "YES — wants a free homepage mockup" : "no"}`,
        ``,
        `What's working:`,
        record.works || "(blank)",
        ``,
        `What's not working:`,
        record.broken || "(blank)",
      ].join("\n");

      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: env.LEAD_FROM || "AI Search Audit <onboarding@resend.dev>",
          to: [env.LEAD_TO],
          reply_to: record.email,
          subject: `${record.mockup ? "🎨 MOCKUP — " : ""}AI Search Audit lead — ${record.business || record.name} (${record.tier})`,
          text: body,
        }),
      });
    } catch (e) {
      console.log("email send failed:", String(e));
      // don't fail the request — the lead is already logged + maybe in KV
    }
  }

  return json({ ok: true });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}
