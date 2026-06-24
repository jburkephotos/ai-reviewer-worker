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

export async function onRequestPost(context) {
  const { request, env } = context;
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
    score.surfaces = surfaceScores(signals);   // per-surface 0–100 for the visual scorecard

    // --- 3. CLAUDE JUDGMENT LAYER --------------------------------------
    let report = null;
    try {
      report = await claudeJudgment(env, clean, crawl, signals, tier, score);
    } catch (e) {
      // If Claude fails, still return the deterministic audit — never 500 the user.
      report = { error: "judgment_unavailable", detail: String(e) };
    }

    const payload = {
      url: clean,
      tier,
      score,
      signals,
      quote,
      report,           // { summary, surfaces:{organic,answer,local}, findings:[...] }
      crawledPages: crawl.pages.map(p => p.url),
    };

    // Notify Jeremy of EVERY audit run (private — reuses the lead Resend setup).
    // Fire-and-forget via waitUntil so the visitor's response is never delayed.
    if (env.RESEND_API_KEY && env.LEAD_TO && context.waitUntil) {
      context.waitUntil(emailOwnerSummary(env, payload).catch(() => {}));
    }

    return json(payload);
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

  // --- COMMERCE: three states, not two ---------------------------------
  // The old logic treated "WooCommerce installed" as "has a store" and forced Large.
  // Reality has three states:
  //   none           — no commerce plumbing at all (brochure)
  //   installed_empty — commerce platform live but no real products listed (the shelves
  //                     are built but empty — a HOT opportunity, NOT a Large-tier catalog)
  //   store          — a real working store with actual products (this is Large)
  const platformCommerce = all.some(p =>
    /woocommerce|cdn\.shopify|snipcart|bigcommerce|squarespace-commerce|ecwid/i.test(p.html));

  // count real product evidence — needs actual products, not just the platform being capable
  let productEvidence = 0;
  for (const p of all) {
    const productSchema = (p.html.match(/"@type"\s*:\s*"product"/gi) || []).length;
    const addToCart = (p.html.match(/add[-_ ]to[-_ ]cart/gi) || []).length;
    const productLinks = (p.html.match(/\/product\/|\/products\/|\/shop\/[a-z0-9-]+/gi) || []).length;
    productEvidence += productSchema + addToCart + Math.min(productLinks, 5);
  }
  // require clear evidence of a populated catalog to count as a real store.
  // a couple of stray matches (a /cart link, one button) is NOT a store.
  const REAL_STORE_THRESHOLD = 4;
  const hasRealStore = productEvidence >= REAL_STORE_THRESHOLD;

  let commerceState;
  if (hasRealStore) commerceState = "store";
  else if (platformCommerce) commerceState = "installed_empty";
  else commerceState = "none";

  // Only a REAL store overrides tier into Large. Empty-but-installed does NOT.
  const hasStore = commerceState === "store";

  // Is this a retail/product business? (drives the e-commerce-opportunity finding)
  const retailHint = /\b(boutique|clothing|apparel|shop|store|gifts?|jewelry|goods|merchandise|prints?|gallery|outfitter|supply)\b/i.test(homeRaw);

  // platform
  const platform =
    /wp-content/i.test(home) ? "WordPress" :
    /cdn\.shopify/i.test(home) ? "Shopify" :
    /wix\.com|_wixcss/i.test(home) ? "Wix" :
    /squarespace/i.test(home) ? "Squarespace" : "unknown";

  // generic/default titles (a real findings signal)
  const titleMatch = homeRaw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const homeTitle = titleMatch ? titleMatch[1].trim() : "";

  // --- HIGH-VALUE AEO SIGNALS (these matter most for AI search) ---------
  const schemaTypeList = [...schemaTypes];   // Set -> array (Sets have no .some())
  const hasFAQSchema = schemaTypeList.some(t => /FAQPage|Question/i.test(t));
  const hasLocalBusiness = schemaTypeList.some(t => /LocalBusiness|Restaurant|Store|.*Store$|Place/i.test(t));
  const hasOrganization = schemaTypeList.some(t => /Organization/i.test(t));
  // question-led headings — content AI engines preferentially extract
  const questionHeadings = all.reduce((n, p) =>
    n + (p.html.match(/<h[2-4][^>]*>\s*[^<]*\?\s*<\/h[2-4]>/gi) || []).length, 0);
  // staleness: most recent 4-digit year visible in content vs current year
  let newestYear = null;
  for (const p of all) {
    const yrs = p.html.match(/\b(20[12]\d)\b/g);
    if (yrs) for (const y of yrs) { const n = +y; if (n > (newestYear || 0)) newestYear = n; }
  }
  const looksStale = newestYear !== null && newestYear <= 2024; // nothing dated 2025+

  return {
    pageCount: all.length,        // note: capped at MAX_PAGES; flagged below if hit cap
    crawlCapped: all.length >= MAX_PAGES,
    hasStore,
    commerceState,                // "none" | "installed_empty" | "store"
    retailHint,
    platform,
    isHttps,
    hasViewport,
    hasOG,
    hasBreadcrumb,
    schemaTypes: [...schemaTypes],
    pagesWithSchema,
    pagesWithMeta,
    hasFAQSchema,
    hasLocalBusiness,
    hasOrganization,
    questionHeadings,
    newestYear,
    looksStale,
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
  // Weighted PERCENTAGE (0–100) + letter grade. Weighted hard toward AI-search
  // readiness, because that's the surface that matters and the one being sold.
  // Presence of plumbing is NOT enough — the high-value, citable signals carry the
  // most weight, so a technically-clean but content-empty site lands in the C/D range,
  // matching reality. Ceiling is capped: nothing without rich citable content hits the 90s.

  let pct = 0;

  // --- AI-SEARCH READINESS (50 pts) — the surface that matters most ---
  if (s.hasOrganization)   pct += 8;   // entity foundation
  if (s.hasLocalBusiness)  pct += 10;  // local/map citability
  if (s.hasFAQSchema)      pct += 16;  // the single highest-value AEO signal
  if (s.questionHeadings >= 3) pct += 10;
  else if (s.questionHeadings >= 1) pct += 5;
  if (s.pagesWithSchema > 0 && s.schemaTypes.length >= 3) pct += 6; // schema depth

  // --- ORGANIC SEO FOUNDATION (28 pts) ---
  if (s.pagesWithMeta >= s.pageCount * 0.8) pct += 8;
  else if (s.pagesWithMeta > 0) pct += 4;
  if (s.homeTitle && s.homeTitle.length >= 15 && !/^home$|^untitled/i.test(s.homeTitle)) pct += 6;
  if (s.hasBreadcrumb) pct += 6;
  if (s.homeImgCount === 0 || s.homeImgWithAlt / Math.max(1, s.homeImgCount) >= 0.8) pct += 8;

  // --- TECHNICAL HYGIENE (14 pts) — table stakes, low weight ---
  if (s.isHttps)     pct += 5;
  if (s.hasViewport) pct += 5;
  if (s.hasOG)       pct += 4;

  // --- FRESHNESS / COMPLETENESS (8 pts, can go negative) ---
  if (!s.looksStale) pct += 5;              // dated 2025+ somewhere = active
  if (s.commerceState === "installed_empty") pct -= 8; // store built but empty = real gap
  if (s.commerceState === "store") pct += 3;            // a working catalog is a plus

  // clamp and CAP the ceiling — even a clean site can't claim "done"
  pct = Math.max(8, Math.min(94, Math.round(pct)));

  return { pct, grade: letterGrade(pct) };
}

function letterGrade(pct) {
  if (pct >= 90) return "A";
  if (pct >= 85) return "A-";
  if (pct >= 80) return "B+";
  if (pct >= 75) return "B";
  if (pct >= 70) return "B-";
  if (pct >= 65) return "C+";
  if (pct >= 60) return "C";
  if (pct >= 55) return "C-";
  if (pct >= 50) return "D+";
  if (pct >= 45) return "D";
  if (pct >= 40) return "D-";
  return "F";
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
    { "priority": "high|med|low", "title": "short plain finding", "rec": "the specific, do-it-yourself fix — name the exact page/element and the concrete change, citing the measured fact (the actual current <title>, the missing schema @type, the page with no meta description). Concrete enough that a competent person could do it with no further research. 1-2 sentences." }
  ]
}
Return 6-10 findings, ordered most important first. Do not restate raw counts as findings without an interpretation.
Every rec must be executable and specific to THIS site — a skilled owner could act on it directly, or hand it to anyone. That completeness is the whole point: the report's value is the full, honest prescription, given freely.

COMMERCE NUANCE — read the commerceState signal carefully:
  - "installed_empty" means the business set up a store platform (e.g. WooCommerce) but has NO products listed. This is a HUGE, specific opportunity: the hardest decision (to sell online) is already made, the plumbing is live, but the shelves are empty. Make this a HIGH-priority finding framed as opportunity, not failure — e.g. "Your store is built but has nothing listed — the biggest decision is already made; the work now is stocking it with photography and product pages." Bucket: editorial (this is Jeremy's photography + catalog wheelhouse).
  - "store" means a real working catalog — normal e-commerce findings apply.
  - "none" — don't invent a store. If they're clearly retail (retailHint), you may gently note selling online as a future option, low priority.

ETHOS — this report is a gift of knowledge, not a sales trap. The tone throughout: here is exactly what's critical to being found by AI search, laid out plainly enough that the owner could hire anyone to do it, or do it themselves. We share what we've learned because we want Oregon Coast businesses visible to the AI search engines. The offer to do it for them is genuine help, never the only path. Never withhold the "what" — the value IS the complete prescription.`;

  const user = `SITE: ${url}
TIER (already classified by code): ${tier}
HEALTH SCORE (already computed): ${score.pct}% (${score.grade})

DETERMINISTIC SIGNALS (ground truth — do not contradict):
- pages crawled: ${signals.pageCount}${signals.crawlCapped ? " (hit crawl cap; site is larger)" : ""}
- platform: ${signals.platform}
- commerce state: ${signals.commerceState}${signals.commerceState === "installed_empty" ? " (store platform live but NO products — opportunity!)" : ""}
- retail business: ${signals.retailHint}
- HTTPS: ${signals.isHttps}
- mobile viewport: ${signals.hasViewport}
- OpenGraph/social tags: ${signals.hasOG}
- breadcrumbs found: ${signals.hasBreadcrumb}
- pages with JSON-LD schema: ${signals.pagesWithSchema}/${signals.pageCount}
- schema @types present: ${signals.schemaTypes.join(", ") || "NONE"}
- FAQ schema present: ${signals.hasFAQSchema}
- LocalBusiness schema present: ${signals.hasLocalBusiness}
- Organization schema present: ${signals.hasOrganization}
- question-led headings found: ${signals.questionHeadings}
- pages with a real meta description: ${signals.pagesWithMeta}/${signals.pageCount}
- newest year referenced on site: ${signals.newestYear || "none found"}${signals.looksStale ? " (looks stale — nothing dated 2025+)" : ""}
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
      max_tokens: 2600,
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

/* ========================================================================
   PER-SURFACE SCORES (0–100) — deterministic, from the same measured signals
   that drive deriveScore. These power the three visual meters in the report.
   Honest range: a site with no schema SHOULD show AI Search near zero — that
   gap is the point. Not clamped to a floor like the overall score.
   ===================================================================== */
function surfaceScores(s) {
  const clamp = n => Math.max(0, Math.min(100, Math.round(n)));

  // AI / answer search — schema, FAQ markup, entity, question-led content
  let answer = 0;
  if (s.pagesWithSchema > 0)        answer += 18;
  if (s.hasOrganization)            answer += 16;
  if (s.hasFAQSchema)               answer += 30;
  if (s.questionHeadings >= 3)      answer += 18;
  else if (s.questionHeadings >= 1) answer += 9;
  if (s.schemaTypes.length >= 3)    answer += 18;

  // Organic / Google SEO — titles, meta, alt text, breadcrumbs, hygiene
  let organic = 0;
  organic += (s.pagesWithMeta / Math.max(1, s.pageCount)) * 30;
  if (s.homeTitle && s.homeTitle.length >= 15 && !/^home$|^untitled/i.test(s.homeTitle)) organic += 22;
  organic += (s.homeImgCount === 0 ? 1 : s.homeImgWithAlt / s.homeImgCount) * 18;
  if (s.hasBreadcrumb) organic += 14;
  if (s.isHttps)       organic += 8;
  if (s.hasViewport)   organic += 8;

  // Local / map — LocalBusiness schema, entity, social/OG, freshness
  let local = 0;
  if (s.hasLocalBusiness) local += 45;
  if (s.hasOrganization)  local += 20;
  if (s.hasOG)            local += 12;
  if (s.hasBreadcrumb)    local += 8;
  if (!s.looksStale)      local += 15;

  return { organic: clamp(organic), answer: clamp(answer), local: clamp(local) };
}

/* ========================================================================
   OWNER NOTIFICATION — Jeremy gets a copy of every audit that runs.
   Private (to LEAD_TO), reuses the Resend setup from lead.js. Best-effort.
   ===================================================================== */
async function emailOwnerSummary(env, d) {
  const sc = d.score || {};
  const surf = sc.surfaces || {};
  const sig = d.signals || {};
  const findings = (d.report && d.report.findings) || [];
  const rows = findings.map(f =>
    `<tr><td style="padding:6px 10px;vertical-align:top;color:${priColor(f.priority)};font:600 11px/1.4 monospace;text-transform:uppercase;white-space:nowrap">${priLabel(f.priority)}</td>` +
    `<td style="padding:6px 10px"><strong>${escHtml(f.title)}</strong><br><span style="color:#555">${escHtml(f.rec)}</span></td></tr>`).join("");

  const html = `<div style="font-family:Georgia,serif;max-width:660px;color:#1a1d1c">
    <h2 style="margin:0 0 2px">AI Review — audit run</h2>
    <p style="margin:0 0 14px;color:#666">${escHtml(d.url)}</p>
    <p style="font-size:15px;margin:0 0 10px"><strong>${escHtml(d.tier)} tier</strong> · grade <strong>${escHtml(sc.grade || "")}</strong> (${escHtml(String(sc.pct == null ? "" : sc.pct))}%) · ${escHtml(String(sig.pageCount || "?"))} pages · ${escHtml(sig.platform || "")}</p>
    <p style="font-size:14px;margin:0 0 16px;color:#333">Google/SEO <strong>${Math.round(surf.organic || 0)}</strong> · AI Search <strong>${Math.round(surf.answer || 0)}</strong> · Local <strong>${Math.round(surf.local || 0)}</strong> <span style="color:#888">(/100)</span></p>
    ${d.report && d.report.summary ? `<p style="font-size:14px;background:#f4f2ec;padding:12px 14px;border-left:3px solid #2f4a3e;margin:0 0 16px">${escHtml(d.report.summary)}</p>` : ""}
    <table style="border-collapse:collapse;font-size:14px;width:100%">${rows}</table>
  </div>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: env.LEAD_FROM || "AI Review <onboarding@resend.dev>",
      to: [env.LEAD_TO],
      subject: `AI Review run — ${safeHost(d.url)} — ${sc.grade || ""} (${d.tier})`,
      html,
    }),
  });
}

function safeHost(u) { try { return new URL(u).host; } catch { return u; } }
function escHtml(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function priColor(p) { return p === "high" ? "#c0492a" : p === "med" ? "#c9952f" : "#4a6b5b"; }
function priLabel(p) { return p === "high" ? "Critical" : p === "med" ? "Important" : "Polish"; }

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
