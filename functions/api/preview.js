/**
 * AI Review — personalized homepage PREVIEW. POST /api/preview  body: { url }
 *
 * The "desire" layer: generate a first-look REBUILT homepage hero from the visitor's
 * OWN site — their real name, tagline and brand color, dropped into a clean template.
 * Gated (runs after the lead form, like the deep report) because it spends a Claude call.
 *
 * TRUTH-FIRST: uses ONLY facts found on their site. Never invents awards, years or claims.
 * The point is to show THEIR business looking great — a starting point, not a fiction.
 *
 * Falls back to a clean hero built from the extracted facts if Claude is unavailable, so
 * the visitor always sees something. This hero template is the seed of the Starter Kit skin.
 *
 * Returns: { url, name, eyebrow, headline, subhead, ctas:[..], badges:[..],
 *            palette:{bg,accent,ink,paper}, theme }
 */

const FETCH_TIMEOUT_MS = 12000;
const CLAUDE_MODEL = "claude-opus-4-8";

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { url } = await request.json();
    const clean = normalizeUrl(url);
    if (!clean) return json({ error: "Invalid URL." }, 400);

    const html = await fetchText(clean);
    if (!html) return json({ error: "Couldn't reach that site." }, 422);

    const facts = extractBrand(html, clean);

    let hero = null;
    try { hero = await claudeHero(env, clean, html, facts); }
    catch { hero = null; }

    const out = hero || fallbackHero(facts);
    out.url = clean;
    out.name = out.name || facts.name;
    out.ctas = Array.isArray(out.ctas) && out.ctas.length ? out.ctas.slice(0, 2) : ["View the menu", "Find us"];
    out.badges = Array.isArray(out.badges) ? out.badges.slice(0, 3) : [];
    out.palette = sanePalette(out.palette, facts.accent);
    out.theme = out.theme || "Coastal modern";
    return json(out);
  } catch (e) {
    return json({ error: "Couldn't build the preview.", detail: String(e) }, 500);
  }
}

/* ---- deterministic brand extraction (truth-first inputs) ---- */
function extractBrand(html, url) {
  return {
    name: brandName(html, url),
    tagline: metaDesc(html) || firstH1(html) || "",
    accent: themeColor(html),
  };
}

function brandName(html, url) {
  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    try { const n = findOrgName(JSON.parse(b[1].trim())); if (n) return clean(n); } catch {}
  }
  const og = html.match(/property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
  if (og) return clean(og[1]);
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) { const seg = clean(t[1].split(/[|–—·]| - /)[0]); if (seg && !/^home$/i.test(seg)) return seg; }
  try { return clean(new URL(url).host.replace(/^www\./, "")); } catch { return "Your business"; }
}
function findOrgName(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findOrgName(n); if (r) return r; } return null; }
  const ty = node["@type"] ? JSON.stringify(node["@type"]) : "";
  if (/Organization|LocalBusiness|Restaurant|Store|Place/i.test(ty) && typeof node.name === "string") return node.name;
  for (const k of Object.keys(node)) { const r = findOrgName(node[k]); if (r) return r; }
  return null;
}
function metaDesc(html) {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{20,200})["']/i);
  return m ? clean(m[1]) : "";
}
function firstH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? clean(m[1].replace(/<[^>]+>/g, " ")) : "";
}
function themeColor(html) {
  const m = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i);
  const v = m ? m[1].trim() : "";
  return /^#?[0-9a-f]{3,8}$/i.test(v) ? (v.startsWith("#") ? v : "#" + v) : "";
}
function clean(s) { return String(s || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 120); }

/* ---- Claude: write the hero from real facts ---- */
async function claudeHero(env, url, html, facts) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("no key");
  const text = stripToText(html).slice(0, 2500);
  const system = `You write the hero section for a REBUILT homepage preview — a first look that makes a local business owner want their site rebuilt. You're given their real site's text + extracted facts.

TRUTH-FIRST: use ONLY facts present in their content. NEVER invent awards, founding years, ratings, or claims. If a fact isn't in their content, leave it out. The point is to show THEIR real business looking great, not a fictional one.

VOICE: warm, concrete, specific to this business. The headline names what they actually are or do. No "unlock / elevate / leverage / welcome to / your one-stop".

Return ONLY valid JSON, no fences:
{
  "name": "the business name",
  "eyebrow": "a short locator/credibility line ONLY if its facts (place, since-year) are in their content; else a short true descriptor of what they are",
  "headline": "a 6-9 word hero headline, specific and true to this business",
  "subhead": "12-22 words, plain and true, no fluff",
  "ctas": ["primary button label", "secondary button label"],
  "badges": ["up to 3 short trust chips drawn from REAL facts only — hours, location, what they're known for; omit any you can't ground"],
  "palette": { "bg": "#hex dark brand background", "accent": "#hex action color", "ink": "#hex dark text", "paper": "#hex light text/surface" },
  "theme": "Coastal modern"
}
If their site shows a brand color (themeColor), use it as the accent. Otherwise pick a tasteful palette that fits the business.`;
  const user = `SITE: ${url}
EXTRACTED: name="${facts.name}"  tagline="${facts.tagline}"  themeColor="${facts.accent || "none"}"

HOMEPAGE TEXT:
${text}`;
  const data = await callClaude(env, system, user, 700);
  const t = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  return JSON.parse(t.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
}

function fallbackHero(facts) {
  return {
    name: facts.name,
    eyebrow: "",
    headline: facts.name,
    subhead: facts.tagline || "A clean, fast homepage that loads instantly and that AI search can actually read.",
    ctas: ["View the menu", "Find us"],
    badges: [],
    palette: null,
    theme: "Coastal modern",
  };
}

function sanePalette(p, accent) {
  const def = { bg: "#15333a", accent: accent || "#c2562b", ink: "#1a1d1c", paper: "#f4f2ec" };
  if (!p || typeof p !== "object") return def;
  const ok = h => typeof h === "string" && /^#[0-9a-f]{3,8}$/i.test(h);
  return {
    bg: ok(p.bg) ? p.bg : def.bg,
    accent: ok(p.accent) ? p.accent : def.accent,
    ink: ok(p.ink) ? p.ink : def.ink,
    paper: ok(p.paper) ? p.paper : def.paper,
  };
}

/* ---- shared helpers ---- */
async function callClaude(env, system, user, maxTokens) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!resp.ok) throw new Error(`anthropic ${resp.status}`);
  return await resp.json();
}
async function fetchText(u) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(u, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (AI-Review preview; jburkephotos.com)" }, cf: { cacheTtl: 300 } });
    clearTimeout(t);
    if (!r.ok) return null;
    if (!(r.headers.get("content-type") || "").includes("text/html")) return null;
    return await r.text();
  } catch { clearTimeout(t); return null; }
}
function stripToText(html) { return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function normalizeUrl(u) { if (!u || typeof u !== "string") return null; u = u.trim(); if (!/^https?:\/\//i.test(u)) u = "https://" + u; try { return new URL(u).href; } catch { return null; } }
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }); }
export async function onRequestOptions() { return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" } }); }
