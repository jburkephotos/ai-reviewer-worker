/**
 * AI Review — audit engine (Cloudflare Pages Function)
 * Route: POST /api/audit   body: { url: "https://example.com" }
 *
 * Architecture (Option 3 — hybrid):
 *   1. DETERMINISTIC layer (this file, pure JS): fetch + crawl up to N pages,
 *      detect the hard signals exactly (schema, meta, alt text, https, viewport,
 *      page count, store), classify the tier, compute the quote. These MUST be
 *      exact and identical run-to-run because they drive the price.
 *   2. JUDGMENT layer (Claude): hand the parsed facts + page text to Claude to
 *      produce the editorial read — the three-surface analysis, prioritization,
 *      and human-quality narrative — under Jeremy's methodology (truth-first,
 *      no invented facts, anti-slop voice).
 *
 * Secrets (set in Cloudflare Pages → Settings → Environment variables):
 *   ANTHROPIC_API_KEY   — required
 */

const MAX_PAGES = 12;          // crawl budget — keeps cost + time bounded
const FETCH_TIMEOUT_MS = 12000;
const CLAUDE_MODEL = "claude-opus-4-8";   // the report is the product — use the strong model

export async function onRequestPost({ request, env }) {
  try {
    const { url } = await request.json();
    const clean = normalizeUrl(url);
    if (!clean) return json({ error: "Please enter a valid website URL." }, 400);

    // --- 1. CRAWL -------------------------------------------------------
    const crawl = await crawlSite(clean);
    if (!crawl.pages.length) {
      return json({ error: "Couldn't reach that site. Check the URL and try again." }, 422);
    }

    // --- 2. DETERMINISTIC SIGNALS + TIER + QUOTE ------------------------
    const signals = analyzeSignals(crawl);
    const tier = classify(signals.pageCount, signals.hasStore);
    const quote = buildQuote(tier);
    const score = deriveScore(signals);

    // --- 3. CLAUDE JUDGMENT LAYER --------------------------------------
    let report = null;
    try {
      report = await claudeJudgment(env, clean, crawl, signals, tier, score);
    } catch (e) {
      // If Claude fails, still return the deterministic audit — never 500 the user.
      report = { error: "judgment_unavailable", detail: String(e) };
    }

    return json({
      url: clean,
      tier,
      score,
      signals,
      quote,
      report,           // { summary, surfaces:{organic,answer,local}, findings:[...] }
      crawledPages: crawl.pages.map(p => p.url),
    });
  } catch (e) {
    return json({ error: "Something went wrong running the audit.", detail: String(e) }, 500);
  }
}

/* ========================================================================
   CRAWL
   ===================================================================== */
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

    // discover same-origin internal links to keep crawling
    if (pages.length < MAX_PAGES) {
      for (const href of extractLinks(html, u)) {
        try {
          const lu = new URL(href);
          if (lu.origin === root.origin && !seen.has(lu.href) && !isAsset(lu.pathname)) {
            queue.push(lu.href);
          }
        } catch {}
      }
    }
  }
  return { root: rootUrl, origin: root.origin, pages };
}

async function fetchText(u) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(u, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (AI-Review audit; jburkephotos.com)" },
      cf: { cacheTtl: 300 },
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return null;
    return await r.text();
  } catch {
    clearTimeout(t);
    return null;
  }
}

function extractLinks(html, base) {
  const out = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 80) {
    try { out.push(new URL(m[1], base).href); } catch {}
  }
  return out;
}

function isAsset(path) {
  return /\.(png|jpe?g|gif|webp|svg|css|js|pdf|zip|mp4|woff2?|ico)(\?|$)/i.test(path);
}

/* ========================================================================
   DETERMINISTIC SIGNALS  — the numbers that must be exact
   ===================================================================== */
function analyzeSignals(crawl) {
  const all = crawl.pages;
  const home = all[0].html.toLowerCase();
  const homeRaw = all[0].html;

  // schema (JSON-LD) presence + which @types appear
  let schemaTypes = new Set();
  let pagesWithSchema = 0;
  for (const p of all) {
    const blocks = [...p.html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)];
    if (blocks.length) pagesWithSchema++;
    for (const b of blocks) {
      try {
        const data = JSON.parse(b[1].trim());
        collectTypes(data, schemaTypes);
      } catch {}
    }
  }

  // meta descriptions across pages
  let pagesWithMeta = 0;
  for (const p of all) {
    if (/<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(p.html)) pagesWithMeta++;
  }

  // alt text coverage on the home page (cheap proxy for catalog hygiene)
  const imgs = [...homeRaw.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  const imgsWithAlt = imgs.filter(t => /\balt\s*=\s*["'][^"']+["']/i.test(t)).length;

  // hard technical signals
  const isHttps = crawl.origin.startsWith("https");
  const hasViewport = /name=["']viewport["']/i.test(homeRaw);
  const hasOG = /property=["']og:/i.test(homeRaw);
  const hasBreadcrumb = all.some(p => /breadcrumb/i.test(p.html));

  // store detection — overrides tier into Large
  const storeHints = /cdn\.shopify|woocommerce|add-to-cart|"@type"\s*:\s*"product"|\/cart|snipcart|bigcommerce|squarespace-commerce/i;
  const hasStore = all.some(p => storeHints.test(p.html));

  // platform
  const platform =
    /wp-content/i.test(home) ? "WordPress" :
    /cdn\.shopify/i.test(home) ? "Shopify" :
    /wix\.com|_wixcss/i.test(home) ? "Wix" :
    /squarespace/i.test(home) ? "Squarespace" : "unknown";

  // generic/default titles (a real findings signal)
  const titleMatch = homeRaw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const homeTitle = titleMatch ? titleMatch[1].trim() : "";

  return {
    pageCount: all.length,        // note: capped at MAX_PAGES; flagged below if hit cap
    crawlCapped: all.length >= MAX_PAGES,
    hasStore,
    platform,
    isHttps,
    hasViewport,
    hasOG,
    hasBreadcrumb,
    schemaTypes: [...schemaTypes],
    pagesWithSchema,
    pagesWithMeta,
    homeImgCount: imgs.length,
    homeImgWithAlt: imgsWithAlt,
    homeTitle,
  };
}

function collectTypes(node, set) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(n => collectTypes(n, set)); return; }
  if (node["@type"]) {
    const t = node["@type"];
    (Array.isArray(t) ? t : [t]).forEach(x => set.add(x));
  }
  for (const k of Object.keys(node)) collectTypes(node[k], set);
}

/* ========================================================================
   TIER + QUOTE  — mirrors the front-end engine exactly
   ===================================================================== */
function classify(pages, hasStore) {
  if (hasStore) return pages >= 35 ? "enterprise" : "large";
  if (pages <= 6) return "small";
  if (pages <= 19) return "medium";
  if (pages <= 34) return "large";
  return "enterprise";
}

const TIER_DEFS = {
  small: {
    name: "Small site",
    phases: [
      { n: "Phase 1", price: 1000, what: "Critical fixes: structured data, titles, meta descriptions, alt text, breadcrumbs", who: "Agent does the data entry · you approve" },
      { n: "Phase 2", price: 1000, what: "AI-search content + finishing: FAQ schema, key copy reworked, layout & performance tidied", who: "Written by Jeremy · agent-assisted" },
    ],
    typical: ["Phase 1", "Phase 2"],
    photo: "Includes a hero photo shoot — 5 images, a $1,500 value, built into Phase 1.",
  },
  medium: {
    name: "Medium site",
    phases: [
      { n: "Phase 1", price: 1500, what: "Critical fixes across all pages: schema, metadata, alt text, breadcrumbs", who: "Agent does the data entry · you approve" },
      { n: "Phase 2", price: 2000, what: "AI-search content: FAQ schema, page restructuring, copy reworked for citability", who: "Written by Jeremy" },
      { n: "Phase 3", price: 1500, what: "UX, navigation, plugins, performance, ongoing marketing plan", who: "Agent-assisted" },
    ],
    typical: ["Phase 1", "Phase 2", "Phase 3"],
    photo: "Includes a hero photo shoot — 5–10 images, a $1,500 value, built into Phase 1.",
  },
  large: {
    name: "Large / e-commerce site",
    phases: [
      { n: "Phase 1", price: 2500, what: "Critical + catalog fixes: org & product schema, per-product metadata and alt text, breadcrumbs", who: "Agent does the high-volume data entry · you approve" },
      { n: "Phase 2", price: 4500, what: "AI-search content: FAQ schema, category & landing rewrites, citable copy throughout", who: "Written by Jeremy" },
      { n: "Phase 3", price: 2500, what: "Full UX/nav rebuild, plugin stack, performance, conversion + marketing strategy", who: "Agent-assisted" },
    ],
    typical: ["Phase 1", "Phase 2", "Phase 3"],
    photo: "Includes a hero photo shoot — 5–10 images, a $1,500 value, built into Phase 1.",
  },
  enterprise: { name: "Enterprise / institutional", enterprise: true },
};

function buildQuote(tier) {
  const def = TIER_DEFS[tier];
  if (def.enterprise) return { enterprise: true, name: def.name };
  const total = def.phases.filter(p => def.typical.includes(p.n)).reduce((s, p) => s + p.price, 0);
  return { enterprise: false, name: def.name, phases: def.phases, typical: def.typical, total, photo: def.photo };
}

function deriveScore(s) {
  // 0–10, higher = healthier. Built from real signals so it's defensible.
  let pts = 0;
  if (s.pagesWithSchema > 0) pts += 2.5;
  if (s.schemaTypes.some(t => /Organization|LocalBusiness/.test(t))) pts += 1;
  if (s.pagesWithMeta > 0) pts += 1.5;
  if (s.isHttps) pts += 1;
  if (s.hasViewport) pts += 1;
  if (s.hasOG) pts += 1;
  if (s.hasBreadcrumb) pts += 1;
  if (s.homeImgCount === 0 || s.homeImgWithAlt / Math.max(1, s.homeImgCount) > 0.7) pts += 1;
  return Math.max(1, Math.min(10, Math.round(pts)));
}

/* ========================================================================
   CLAUDE JUDGMENT LAYER
   ===================================================================== */
async function claudeJudgment(env, url, crawl, signals, tier, score) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  // Compact the crawl: send page titles + first chunk of visible text only (cost control)
  const pageDigests = crawl.pages.slice(0, 8).map(p => {
    const title = (p.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].trim();
    const text = stripToText(p.html).slice(0, 1200);
    return `URL: ${p.url}\nTITLE: ${title}\nTEXT: ${text}`;
  }).join("\n\n---\n\n");

  const system = `You are the audit-judgment engine for "AI Review," the discoverability audit tool of Jeremy Burke / J. Burke Photos — a 20-year editorial publisher and Oregon Coast photographer who sells website AEO/GEO/SEO fixes to local businesses.

Apply Jeremy's exact methodology:

THREE SURFACES — assess each separately:
  1. ORGANIC SEO — classic Google ranking: titles, meta, headings, internal linking, crawlability.
  2. ANSWER / GENERATIVE SEARCH (AEO/GEO) — whether ChatGPT, Perplexity, Google AI can read and cite this site: JSON-LD schema, FAQ markup, question-led headings, an entity graph (Organization/Person/LocalBusiness), citable factual copy.
  3. LOCAL / MAP — LocalBusiness schema, NAP consistency, geo signals, map presence.

FIVE HARD GATES (frame fixes so they'd pass these):
  truth (no invented facts), single source per schema type (no duplicate Organization nodes),
  validates clean, entity graph intact (linked Org/Person/sameAs), canonical & indexability sane.

VOICE — editorial, specific, anti-slop. Concrete and true beats adjective-heavy. NEVER invent facts about the business; if you don't know something, frame it as "add/confirm," not as fact. Write the way a sharp editor talks to a business owner: plain, direct, a little warm, never marketer-fluffy. No "unlock," "elevate," "leverage," "supercharge."

ADVERSARIAL PASS (do this internally before you return anything) — draft your findings, then re-read every one as a skeptical business owner who is sure this is generic AI fluff and won't pay a cent for it. For each finding ask: "Could this exact sentence appear on any website's audit? Does it name something specific about THIS site, or is it boilerplate?" Cut or rewrite any finding that doesn't survive — replace vague observations ("improve your SEO," "add more content") with the specific, named gap you actually measured or saw in the page digests ("your homepage <title> is the WordPress default 'Home' — it should name the business and Newport"). The summary especially must point at the single most specific, real thing holding this site back, not a category. Return only findings that survive this read. A sharp local owner should think "this person actually looked at MY site," never "this is a template."

You are given DETERMINISTIC signals already measured (trust these as ground truth — do not contradict the counts) plus page digests. Produce the judgment layer the code can't: prioritization, the editorial read of what's actually holding this site back, and findings phrased for a non-technical owner.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{
  "summary": "2-3 sentence plain-language verdict — what's the single biggest thing costing them visibility right now",
  "surfaces": {
    "organic": "1-2 sentences on classic SEO health",
    "answer":  "1-2 sentences on AI-search readiness — the surface that matters most",
    "local":   "1-2 sentences on local/map readiness"
  },
  "findings": [
    { "priority": "high|med|low", "title": "short plain finding", "rec": "what to do about it, one sentence", "bucket": "agent|editorial|approve" }
  ]
}
bucket meaning: agent = mechanical data entry an agent does (schema, meta, alt text); editorial = needs Jeremy's writing/judgment; approve = a structural/destructive change needing owner sign-off.
Return 6-10 findings, ordered most important first. Do not restate raw counts as findings without an interpretation.`;

  const user = `SITE: ${url}
TIER (already classified by code): ${tier}
HEALTH SCORE (already computed): ${score}/10

DETERMINISTIC SIGNALS (ground truth — do not contradict):
- pages crawled: ${signals.pageCount}${signals.crawlCapped ? " (hit crawl cap; site is larger)" : ""}
- platform: ${signals.platform}
- has online store: ${signals.hasStore}
- HTTPS: ${signals.isHttps}
- mobile viewport: ${signals.hasViewport}
- OpenGraph/social tags: ${signals.hasOG}
- breadcrumbs found: ${signals.hasBreadcrumb}
- pages with JSON-LD schema: ${signals.pagesWithSchema}/${signals.pageCount}
- schema @types present: ${signals.schemaTypes.join(", ") || "NONE"}
- pages with a real meta description: ${signals.pagesWithMeta}/${signals.pageCount}
- home page images: ${signals.homeImgCount}, with alt text: ${signals.homeImgWithAlt}
- home <title>: "${signals.homeTitle}"

PAGE DIGESTS:
${pageDigests}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!resp.ok) throw new Error(`anthropic ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned);
}

/* ========================================================================
   helpers
   ===================================================================== */
function stripToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(u) {
  if (!u || typeof u !== "string") return null;
  u = u.trim();
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { return new URL(u).href; } catch { return null; }
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
