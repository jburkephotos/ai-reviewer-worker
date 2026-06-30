/**
 * AI Review — DEEP page-by-page report. POST /api/deep  body: { url }
 *
 * This is the gated, expensive pass that runs AFTER someone submits the qualifying
 * form. It crawls the site and runs a Claude analysis PER PAGE, then a short synthesis,
 * producing an OCAq-style report: an overall verdict + a section for each page with its
 * own findings. Costs more (one Claude call per page) — which is exactly why it's gated
 * behind the lead form.
 *
 * Returns: { url, overall, pages: [ { url, title, role, findings:[...] } ], crawledPages }
 */

const MAX_PAGES = 10;           // deep pass: a touch tighter than the summary crawl
const FETCH_TIMEOUT_MS = 12000;
const CLAUDE_MODEL = "claude-opus-4-8";
const PER_PAGE_TOKENS = 1100;

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "Report engine isn't configured yet." }, 500);
    }
    const body = await request.json();
    const { url } = body;
    const ctx = body.ctx || null;   // summary scorecard + quote, passed from the front-end for the email
    const clean = normalizeUrl(url);
    if (!clean) return json({ error: "Invalid URL." }, 400);

    const crawl = await crawlSite(clean);
    if (!crawl.pages.length) {
      return json({ error: "Couldn't reach that site." }, 422);
    }

    // Analyze each page in parallel (bounded by crawl size). One Claude call per page.
    const pagePromises = crawl.pages.map(p => analyzePage(env, clean, p));
    const pages = await Promise.all(pagePromises);
    const ok = pages.filter(Boolean);

    // Short synthesis verdict across the whole site.
    let overall = "";
    try {
      overall = await synthesize(env, clean, ok);
    } catch {
      overall = "";
    }

    const payload = {
      url: clean,
      overall,
      pages: ok,
      crawledPages: crawl.pages.map(p => p.url),
    };

    // Jeremy gets a copy of every deep report that runs (private, best-effort).
    if (env.RESEND_API_KEY && env.LEAD_TO && context.waitUntil) {
      context.waitUntil(emailOwnerDeep(env, payload, ctx).catch(() => {}));
    }

    return json(payload);
  } catch (e) {
    return json({ error: "Couldn't build the deep report.", detail: String(e) }, 500);
  }
}

/* ---- per-page analysis ---- */
async function analyzePage(env, site, page) {
  const title = (page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].trim();
  const text = stripToText(page.html).slice(0, 3500);

  // quick deterministic facts for this page so Claude grounds in truth
  const hasSchema = /application\/ld\+json/i.test(page.html);
  const schemaTypes = [...page.html.matchAll(/"@type"\s*:\s*"([^"]+)"/gi)].map(m => m[1]);
  const hasMeta = /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(page.html);
  const imgs = (page.html.match(/<img\b[^>]*>/gi) || []);
  const imgsAlt = imgs.filter(t => /\balt\s*=\s*["'][^"']+["']/i.test(t)).length;
  const qHeadings = (page.html.match(/<h[2-4][^>]*>\s*[^<]*\?\s*<\/h[2-4]>/gi) || []).length;

  const system = `You are writing one page's section of an in-depth website discoverability report for Jeremy Burke / J. Burke Photos — a 20-year editorial publisher who fixes how Oregon Coast businesses appear in Google and AI search (ChatGPT, Perplexity, Gemini, Google AI Overviews).

Assess THIS ONE PAGE across three surfaces: organic SEO (title, meta, headings, structure), AI/answer search (schema, FAQ markup, question-led citable content, entity signals), and local/map where relevant.

VOICE: editorial, specific, anti-slop. Plain and direct, a little warm. NEVER invent facts — if unknown, say "add/confirm." No "unlock/elevate/leverage." Name the actual things on THIS page, never boilerplate that could apply to any site.

ETHOS: this is a gift of knowledge. Lay out exactly what's critical so the owner could fix it themselves or hand it to anyone. The value is the complete, honest prescription.

Return ONLY valid JSON, no fences:
{
  "role": "what this page is for, 4-7 words (e.g. 'Homepage — first impression & navigation')",
  "findings": [
    { "priority":"high|med|low", "title":"specific finding about THIS page", "rec":"the specific, do-it-yourself fix for THIS page — name the element and the concrete change, citing the measured fact (the actual title, the missing schema @type). Concrete enough to act on with no further research. 1-2 sentences." }
  ]
}
2-5 findings for this page. If the page is genuinely clean, it's fine to return 1 finding or note a strength as a low-priority item. Order most important first.`;

  const user = `SITE: ${site}
THIS PAGE: ${page.url}
TITLE: "${title}"
DETERMINISTIC FACTS (don't contradict): schema=${hasSchema} types=[${schemaTypes.slice(0,6).join(", ")}] meta=${hasMeta} images=${imgs.length} withAlt=${imgsAlt} questionHeadings=${qHeadings}

PAGE TEXT:
${text}`;

  try {
    const data = await callClaude(env, system, user, PER_PAGE_TOKENS);
    const parsed = parseJSON(data);
    if (!parsed) return null;
    return { url: page.url, title, role: parsed.role || "", findings: parsed.findings || [] };
  } catch {
    return { url: page.url, title, role: "", findings: [] };
  }
}

/* ---- whole-site synthesis ---- */
async function synthesize(env, site, pages) {
  const digest = pages.map(p =>
    `${p.url} (${p.role}): ${p.findings.map(f => f.title).join("; ")}`).join("\n");
  const system = `You are writing the 3-4 sentence opening verdict for an in-depth website report by Jeremy Burke (Oregon Coast publisher who fixes AI-search visibility). Plain, specific, warm, anti-slop, no invented facts. Name the single biggest pattern across the whole site and the highest-leverage thing to fix first. Return plain text only, no JSON, no fences.`;
  const user = `SITE: ${site}\nPER-PAGE FINDINGS:\n${digest}`;
  const data = await callClaude(env, system, user, 400);
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
}

/* ---- shared ---- */
async function callClaude(env, system, user, maxTokens) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!resp.ok) throw new Error(`anthropic ${resp.status}`);
  return await resp.json();
}

function parseJSON(data) {
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

// Canonical key for dedup — collapses www/non-www and trailing slashes so the
// homepage (root vs the www sitemap URL) isn't crawled and analyzed twice.
function pageKey(u){ try{ const x=new URL(u); return x.hostname.replace(/^www\./,"") + (x.pathname.replace(/\/+$/,"").toLowerCase()||"/"); }catch{ return u; } }
async function crawlSite(rootUrl) {
  const root = new URL(rootUrl);
  const seen = new Set();
  const queue = [rootUrl];
  const pages = [];

  // Seed from the sitemap too — JS-rendered navs expose no links in raw HTML, so
  // link-following alone stops at the homepage. The sitemap gives us the real pages.
  try {
    for (const u of await sitemapUrls(root.origin)) {
      try { const lu = new URL(u); if (lu.hostname.replace(/^www\./, "") === root.hostname.replace(/^www\./, "") && !isAsset(lu.pathname) && !queue.includes(lu.href)) queue.push(lu.href); } catch {}
    }
  } catch {}

  while (queue.length && pages.length < MAX_PAGES) {
    const u = queue.shift();
    const k = pageKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    const html = await fetchText(u);
    if (!html) continue;
    pages.push({ url: u, html });
    if (pages.length < MAX_PAGES) {
      const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi;
      let m;
      while ((m = re.exec(html))) {
        try {
          const lu = new URL(m[1], u);
          if (lu.origin === root.origin && !seen.has(pageKey(lu.href)) && !isAsset(lu.pathname)) queue.push(lu.href);
        } catch {}
      }
    }
  }
  return { origin: root.origin, pages };
}

async function fetchText(u) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(u, { signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
      cf: { cacheTtl: 30 } });
    clearTimeout(t);
    if (!r.ok) return null;
    if (!(r.headers.get("content-type") || "").includes("text/html")) return null;
    return await r.text();
  } catch { clearTimeout(t); return null; }
}

// like fetchText but without the text/html filter — sitemaps are XML
async function fetchAny(u) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(u, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" }, cf: { cacheTtl: 30 } });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.text();
  } catch { clearTimeout(t); return null; }
}
// Enumerate page URLs from the site's sitemap — covers JS-nav sites that expose no links in HTML.
async function sitemapUrls(origin) {
  let xml = null;
  for (const p of ["/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap.xml"]) {
    const x = await fetchAny(origin + p);
    if (x && /<(urlset|sitemapindex)/i.test(x)) { xml = x; break; }
  }
  if (!xml) return [];
  const locs = s => [...s.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
  if (/<sitemapindex/i.test(xml)) {
    const rank = u => { u = u.toLowerCase(); return u.includes("page") ? 0 : u.includes("post") ? 1 : u.includes("product") ? 2 : 5; };
    const subs = locs(xml).filter(u => /\.xml/i.test(u)).sort((a, b) => rank(a) - rank(b)).slice(0, 4);
    const out = [];
    for (const s of subs) { const sx = await fetchAny(s); if (sx) out.push(...locs(sx)); if (out.length > 50) break; }
    return out;
  }
  return locs(xml);
}

/* ---- owner notification: Jeremy gets every deep report, branded (private, best-effort) ----
   ctx = the summary {url,tier,score,signals,quote,report:{summary,surfaces}} passed from the
   front-end so the deep email can lead with the same scorecard + Phase 1 quote as the tool. */
async function emailOwnerDeep(env, d, ctx) {
  const pagesHtml = (d.pages || []).filter(p => p.findings && p.findings.length).map(p => {
    let path; try { path = new URL(p.url).pathname || "/"; } catch { path = p.url; }
    const rows = p.findings.map(f => `<tr>
      <td valign="top" style="padding:7px 12px 7px 0;white-space:nowrap;font:700 10px monospace;letter-spacing:1px;text-transform:uppercase;color:${priColor(f.priority)}">${priLabel(f.priority)}</td>
      <td valign="top" style="padding:7px 0;border-bottom:1px solid #ece9e0"><div style="font:600 14px Georgia,serif;color:#1a1d1c">${escHtml(f.title)}</div><div style="font:400 13px Georgia,serif;color:#555;margin:2px 0 0">${escHtml(f.rec)}</div></td></tr>`).join("");
    return `<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f2ec" style="border:1px solid #e2dfd6;border-radius:3px;margin:0 0 12px"><tr><td style="padding:14px 18px">
      <div style="margin:0 0 8px;padding:0 0 8px;border-bottom:1px solid #d6d3c9"><span style="font:700 14px monospace;color:#d4622a">${escHtml(path)}</span> <span style="font:italic 13px Georgia,serif;color:#888">${escHtml(p.role || "")}</span></div>
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr></table>`;
  }).join("");

  const top = ctx ? (emailScorecard(ctx) + emailPhase1(ctx)) : "";
  const overall = d.overall ? `<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f2ec" style="border-radius:3px;margin:24px 0 16px"><tr><td style="padding:16px 20px;border-left:4px solid #2f4a3e;font:400 15px/1.5 Georgia,serif;color:#1a1d1c">${escHtml(d.overall)}</td></tr></table>` : "";
  const head = `<div style="font:600 11px monospace;letter-spacing:2px;text-transform:uppercase;color:#2f4a3e;border-bottom:1px solid #d6d3c9;padding:0 0 8px;margin:26px 0 12px">The full page-by-page report</div>`;
  await sendEmail(env, `AI Review DEEP — ${safeHost(d.url)}`, emailShell(d.url, top + overall + head + pagesHtml));
}

/* ---- branded email builders (mirror of audit.js; email-safe tables + inline styles) ---- */
const EMAIL_TIER_DESC = {
  small: "A brochure site — a few pages, no online store. Fast to fix, big visible lift.",
  medium: "A real multi-page site — services or content, not yet selling online.",
  large: "A substantial site or online store — catalog, many pages, transactions to protect.",
  enterprise: "35+ pages, deep navigation, multiple audiences — a destination or institution.",
};
function gradeColorEmail(pct) {
  if (pct == null) return "#e8a07a";
  if (pct < 60) return "#e2735a";
  if (pct < 70) return "#e0935a";
  if (pct < 80) return "#e0c05a";
  if (pct < 90) return "#8fb89a";
  return "#7fd0a8";
}
function meterColorEmail(v) { return v < 40 ? "#c0492a" : v < 70 ? "#c9952f" : "#2f4a3e"; }
function emailBar(name, val, read) {
  const v = Math.max(0, Math.min(100, Math.round(val || 0)));
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr><td>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font:600 11px monospace;letter-spacing:1px;text-transform:uppercase;color:#d4622a">${escHtml(name)}</td>
      <td align="right" style="font:700 15px Georgia,serif;color:${v < 40 ? "#c0492a" : "#1a1d1c"}">${v}<span style="font:400 11px Georgia,serif;color:#aaa">/100</span></td>
    </tr></table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:5px 0 0"><tr>
      <td bgcolor="#d6d3c9" style="border-radius:5px;font-size:0;line-height:0">
        <table width="${v}%" cellpadding="0" cellspacing="0"><tr><td bgcolor="${meterColorEmail(v)}" height="9" style="height:9px;border-radius:5px;font-size:0;line-height:0">&nbsp;</td></tr></table>
      </td>
    </tr></table>
    ${read ? `<div style="font:400 13px Georgia,serif;color:#555;margin:5px 0 0">${escHtml(read)}</div>` : ""}
  </td></tr></table>`;
}
function emailScorecard(d) {
  const sc = d.score || {}, surf = sc.surfaces || {}, sig = d.signals || {}, r = d.report || {}, reads = r.surfaces || {};
  const ent = d.quote && d.quote.enterprise;
  const gcol = ent ? "#9fc3d4" : gradeColorEmail(sc.pct);
  const band = `<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#1a1d1c" style="border-radius:4px;margin:0 0 16px"><tr>
    <td width="118" align="center" valign="middle" style="padding:22px 16px 22px 24px">
      <div style="font:700 52px Georgia,serif;color:${gcol};line-height:1">${ent ? "&mdash;" : escHtml(sc.grade || "")}</div>
      ${ent ? "" : `<div style="font:400 15px Georgia,serif;color:rgba(244,242,236,.5);margin:4px 0 0">${escHtml(String(sc.pct == null ? "" : sc.pct))}%</div>`}
    </td>
    <td valign="middle" style="padding:22px 24px 22px 0">
      <div style="font:600 11px monospace;letter-spacing:2px;text-transform:uppercase;color:#e8a07a;margin:0 0 6px">${escHtml(d.tier)} tier &middot; ${escHtml(String(sig.pageCount || "?"))} pages</div>
      <div style="font:700 21px Georgia,serif;color:#f4f2ec;margin:0 0 5px">${escHtml((d.quote && d.quote.name) || "")}</div>
      <div style="font:400 13px Georgia,serif;color:rgba(244,242,236,.72)">${escHtml(EMAIL_TIER_DESC[d.tier] || "")}</div>
    </td></tr></table>`;
  const verdict = r.summary ? `<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f2ec" style="border-radius:3px;margin:0 0 18px"><tr><td style="padding:16px 20px;border-left:4px solid #2f4a3e;font:400 15px/1.5 Georgia,serif;color:#1a1d1c">${escHtml(r.summary)}</td></tr></table>` : "";
  const bars = `<div style="font:600 11px monospace;letter-spacing:2px;text-transform:uppercase;color:#2f4a3e;margin:0 0 14px">Where you show up &middot; 3 surfaces</div>` +
    emailBar("Google / SEO", surf.organic, reads.organic) +
    emailBar("AI Search · Google AI Overviews, ChatGPT, Gemini & Perplexity", surf.answer, reads.answer) +
    emailBar("Local / Map pack", surf.local, reads.local);
  return band + verdict + bars;
}
function emailPhase1(d) {
  const q = d.quote || {};
  const cta = `mailto:jlburkephotos@gmail.com?subject=AI%20Review%20%E2%80%94%20${encodeURIComponent(d.url || "")}`;
  if (q.enterprise) {
    return `<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f2ec" style="border:1px solid #d6d3c9;border-radius:3px;margin:24px 0 0"><tr><td style="padding:20px 24px;border-left:4px solid #3a5a6b">
      <div style="font:600 11px monospace;letter-spacing:2px;text-transform:uppercase;color:#3a5a6b;margin:0 0 8px">Let's scope it together</div>
      <div style="font:700 20px Georgia,serif;color:#1a1d1c;margin:0 0 6px">This site's substantial enough to plan personally.</div>
      <div style="font:400 14px/1.5 Georgia,serif;color:#555;margin:0 0 16px">A site at this scale gets a written strategy and phased implementation — the way I did the Oregon Coast Aquarium.</div>
      <a href="${cta}" style="background:#3a5a6b;color:#fff;text-decoration:none;font:600 12px monospace;letter-spacing:1px;text-transform:uppercase;padding:11px 22px;border-radius:2px">Book a 20-minute call</a>
    </td></tr></table>`;
  }
  const p1 = (q.phases && q.phases[0]) || {};
  return `<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4f2ec" style="border:1px solid #d6d3c9;border-radius:3px;margin:24px 0 0"><tr><td style="padding:22px 24px;border-left:4px solid #d4622a">
    <div style="font:600 11px monospace;letter-spacing:2px;text-transform:uppercase;color:#d4622a;margin:0 0 8px">Where to start</div>
    <div style="font:700 21px Georgia,serif;color:#1a1d1c;margin:0 0 8px">Phase 1 — a redesigned, AI-ready site</div>
    <div style="font:400 14px/1.5 Georgia,serif;color:#444;margin:0 0 16px">${escHtml(p1.what || "")}</div>
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td valign="middle" style="font:700 26px Georgia,serif;color:#1a1d1c">$${(p1.price || 0).toLocaleString()}</td>
      <td valign="middle" align="right"><a href="${cta}" style="background:#1a1d1c;color:#f4f2ec;text-decoration:none;font:600 12px monospace;letter-spacing:1px;text-transform:uppercase;padding:12px 24px;border-radius:2px">Let's talk &rarr;</a></td>
    </tr></table>
    ${q.photo ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 0"><tr><td bgcolor="#eef1ec" style="border-radius:2px;padding:10px 13px;font:400 13px Georgia,serif;color:#2f4a3e">&#128247; ${escHtml(q.photo)}</td></tr></table>` : ""}
    <div style="font:italic 13px Georgia,serif;color:#777;margin:14px 0 0">Then we re-run your audit, show the jump, and scope the rest — the deeper AEO content and growth work — only if you want it.</div>
  </td></tr></table>`;
}
function emailShell(url, inner) {
  return `<div style="background:#e8e6df;padding:24px 0;font-family:Georgia,serif"><table align="center" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto"><tr><td style="padding:0 24px">
    <div style="font:600 11px monospace;letter-spacing:2px;text-transform:uppercase;color:#d4622a;margin:0 0 4px">J. Burke Photos &middot; Discoverability</div>
    <div style="font:700 34px Georgia,serif;color:#1a1d1c;border-bottom:2px solid #1a1d1c;padding:0 0 14px">AI Review</div>
    <div style="font:400 13px Georgia,serif;color:#666;margin:12px 0 22px">${escHtml(url)}</div>
    ${inner}
    <div style="border-top:2px solid #1a1d1c;margin:30px 0 0;padding:18px 0 0;font:400 12px/1.5 Georgia,serif;color:#777">A plain-language read of how your site shows up in Google, the map pack, and AI answers like Google AI Overviews, ChatGPT, and Gemini — and exactly what it takes to fix it. Yours to keep.</div>
  </td></tr></table></div>`;
}
async function sendEmail(env, subject, html) {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: env.LEAD_FROM || "AI Review <onboarding@resend.dev>", to: [env.LEAD_TO], subject, html }),
  });
}
function safeHost(u){ try { return new URL(u).host; } catch { return u; } }
function escHtml(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function priColor(p){ return p === "high" ? "#c0492a" : p === "med" ? "#c9952f" : "#4a6b5b"; }
function priLabel(p){ return p === "high" ? "Critical" : p === "med" ? "Important" : "Polish"; }

function isAsset(p){return /\.(png|jpe?g|gif|webp|svg|css|js|pdf|zip|mp4|woff2?|ico)(\?|$)/i.test(p);}
function stripToText(html){return html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();}
function normalizeUrl(u){if(!u||typeof u!=="string")return null;u=u.trim();if(!/^https?:\/\//i.test(u))u="https://"+u;try{return new URL(u).href;}catch{return null;}}
function json(obj,status=200){return new Response(JSON.stringify(obj),{status,headers:{"content-type":"application/json","access-control-allow-origin":"*"}});}
export async function onRequestOptions(){return new Response(null,{headers:{"access-control-allow-origin":"*","access-control-allow-methods":"POST, OPTIONS","access-control-allow-headers":"content-type"}});}
