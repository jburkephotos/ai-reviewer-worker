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

export async function onRequestPost({ request, env }) {
  try {
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "Report engine isn't configured yet." }, 500);
    }
    const { url } = await request.json();
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

    return json({
      url: clean,
      overall,
      pages: ok,
      crawledPages: crawl.pages.map(p => p.url),
    });
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

  const system = `You are writing one page's section of an in-depth website discoverability report for Jeremy Burke / J. Burke Photos — a 20-year editorial publisher who fixes how Oregon Coast businesses appear in Google and AI search (ChatGPT, Perplexity, Google AI).

Assess THIS ONE PAGE across three surfaces: organic SEO (title, meta, headings, structure), AI/answer search (schema, FAQ markup, question-led citable content, entity signals), and local/map where relevant.

VOICE: editorial, specific, anti-slop. Plain and direct, a little warm. NEVER invent facts — if unknown, say "add/confirm." No "unlock/elevate/leverage." Name the actual things on THIS page, never boilerplate that could apply to any site.

ETHOS: this is a gift of knowledge. Lay out exactly what's critical so the owner could fix it themselves or hand it to anyone. The value is the complete, honest prescription.

Return ONLY valid JSON, no fences:
{
  "role": "what this page is for, 4-7 words (e.g. 'Homepage — first impression & navigation')",
  "findings": [
    { "priority":"high|med|low", "title":"specific finding about THIS page", "rec":"the fix, one sentence", "bucket":"agent|editorial|approve" }
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

async function crawlSite(rootUrl) {
  const root = new URL(rootUrl);
  const seen = new Set();
  const queue = [rootUrl];
  const pages = [];
  while (queue.length && pages.length < MAX_PAGES) {
    const u = queue.shift();
    if (seen.has(u)) continue;
    seen.add(u);
    const html = await fetchText(u);
    if (!html) continue;
    pages.push({ url: u, html });
    if (pages.length < MAX_PAGES) {
      const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi;
      let m;
      while ((m = re.exec(html))) {
        try {
          const lu = new URL(m[1], u);
          if (lu.origin === root.origin && !seen.has(lu.href) && !isAsset(lu.pathname)) queue.push(lu.href);
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
      headers: { "User-Agent": "Mozilla/5.0 (AI-Review deep; jburkephotos.com)" },
      cf: { cacheTtl: 300 } });
    clearTimeout(t);
    if (!r.ok) return null;
    if (!(r.headers.get("content-type") || "").includes("text/html")) return null;
    return await r.text();
  } catch { clearTimeout(t); return null; }
}

function isAsset(p){return /\.(png|jpe?g|gif|webp|svg|css|js|pdf|zip|mp4|woff2?|ico)(\?|$)/i.test(p);}
function stripToText(html){return html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();}
function normalizeUrl(u){if(!u||typeof u!=="string")return null;u=u.trim();if(!/^https?:\/\//i.test(u))u="https://"+u;try{return new URL(u).href;}catch{return null;}}
function json(obj,status=200){return new Response(JSON.stringify(obj),{status,headers:{"content-type":"application/json","access-control-allow-origin":"*"}});}
export async function onRequestOptions(){return new Response(null,{headers:{"access-control-allow-origin":"*","access-control-allow-methods":"POST, OPTIONS","access-control-allow-headers":"content-type"}});}
