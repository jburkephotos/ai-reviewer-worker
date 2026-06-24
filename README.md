# AI Review — deploy to live

This is the complete, deployment-ready tool. Front-end + the hybrid audit engine
(deterministic parsing for the exact numbers, Claude for the editorial judgment).
Going live is copy-paste-and-deploy — the build is done.

Target: **aireview.jburkephotos.com**

---

## What's in here

```
ai-review-worker/
├── index.html              ← the public front-end (calls /api/audit, /api/preview, /api/deep, /api/lead)
└── functions/
    └── api/
        ├── audit.js        ← summary audit engine (deterministic signals + Claude judgment)
        ├── preview.js      ← gated "your homepage, rebuilt" preview (brand-aware hero)
        ├── deep.js         ← gated page-by-page report (one Claude call per page)
        └── lead.js         ← lead capture (email / KV / log)
```

Cloudflare Pages automatically turns anything in `functions/` into serverless routes —
e.g. `functions/api/audit.js` becomes `POST /api/audit`. No separate Worker project needed.

---

## How it works (the architecture you chose — Option 3, hybrid)

1. **Deterministic layer** (pure JS in audit.js): crawls up to 12 pages, measures the
   hard signals exactly — JSON-LD schema and which @types, meta descriptions, alt-text
   coverage, HTTPS, mobile viewport, OpenGraph, breadcrumbs, page count, store detection.
   These drive the **tier** and the **quote**, so they're code, not Claude — exact and
   identical every run. (Tier logic is unit-tested: e-commerce overrides page count into
   Large; 35+ pages → Enterprise.) They also compute the three per-surface scores
   (Google/SEO · AI Search · Local, 0–100) that power the visual scorecard in the report.

2. **Judgment layer** (Claude, opus-4-8): gets the measured facts + page digests and
   produces what code can't — the three-surface read (Google/SEO · AI Search · Local),
   the prioritized findings, the editorial narrative. The system prompt encodes your
   actual methodology: three surfaces, five hard gates, truth-first / no-invented-facts,
   anti-slop voice. Each finding is a specific, do-it-yourself fix that cites the exact
   measured signal — the report gives away the complete prescription on purpose. The
   honesty is the moat: ~3–5% will DIY the list, the other 95% read the real scope of
   work and hire it out.

If Claude ever fails, the tool still returns the deterministic audit + quote — it never
errors out on the visitor.

---

## Deploy steps

### 1. Put the folder in a Git repo
Create a new GitHub repo (e.g. `ai-review`) and push this folder's contents to it
(so `index.html` and `functions/` are at the repo root).

### 2. Create the Cloudflare Pages project
- Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
- Pick the repo.
- Build settings: **Framework preset: None**. Build command: *(leave blank)*.
  Build output directory: **/** (root). Click **Save and Deploy**.

### 3. Set the API key (this is the one secret)
- Project → **Settings** → **Environment variables** → **Add variable**.
- Name: `ANTHROPIC_API_KEY`  ·  Value: your key  ·  scope: **Production** (and Preview if you want).
- **Redeploy** so the function picks it up.

### 4. Point the subdomain
- Project → **Custom domains** → **Set up a custom domain** → `aireview.jburkephotos.com`.
- Cloudflare adds the CNAME automatically if jburkephotos.com's DNS is on Cloudflare.
  If DNS is elsewhere, add the CNAME it shows you at your DNS host.

That's it. Visit the subdomain and audit a site.

---

## Test it before you announce it
Run it against sites you know cold so you can sanity-check the output:
- **jburkephotos.com** — should score high (you fixed it). Good "healthy site" baseline.
- A local café/gallery with an obviously thin site — should score low, land Small/Medium,
  and surface the no-schema / no-meta findings.
- **aquarium.org** — should land Enterprise and route to a call (no auto-number).

If the tier or quote ever looks wrong, the bug is in the deterministic layer (audit.js
`classify` / `analyzeSignals`), not Claude — those are the exact, testable parts.

---

## Cost control (worth knowing)
- The crawl is capped at 12 pages and Claude only sees 8 page digests (~1,200 chars each),
  so each audit is a small, bounded Claude call. Cheap per run.
- The two **gated** steps cost more — which is exactly why they sit behind the contact form:
  `/api/deep` runs one Claude call per page (~10), and `/api/preview` runs one Claude call to
  write the rebuilt-homepage hero. The free summary stays a single bounded call; the expensive
  work only runs after someone leaves their details.
- It's a public tool, so if it ever gets hammered, add a simple rate limit (Cloudflare
  Turnstile on the form, or a KV counter per IP). Not needed at launch; note it for later.
- Model is set to `claude-opus-4-8` because the report quality IS the product. If you want
  to cut cost later, swap to Sonnet in `CLAUDE_MODEL` — but test the voice first; Opus
  reads more like you.

---

## Where leads land — pick one (the form never loses a lead)

The qualifying form posts to `/api/lead` (`functions/api/lead.js`). It ALWAYS logs each
submission, so nothing is ever lost. Pick how you want to actually receive them:

> **Also:** once `RESEND_API_KEY` + `LEAD_TO` are set (below), you get a private email copy
> of **every audit and deep report that runs** — not just form submissions — fired
> best-effort from `audit.js` / `deep.js`. Your inbox becomes the archive of everything the
> tool sees, including people who bounce without leaving contact info.

**Recommended — email to your inbox (~5 min):**
1. Free account at **resend.com**, create an API key.
2. Cloudflare → your Pages project → **Settings → Variables and Secrets**, add:
   - `RESEND_API_KEY` — your Resend key — as a **Secret**
   - `LEAD_TO` — your email (jlburkephotos@gmail.com) — as a plain variable
   - (optional) `LEAD_FROM` — leave unset until you verify a domain; it uses Resend's test
     sender, which delivers fine to your own inbox.
3. Redeploy. Every lead now emails to you instantly, visitor's email as reply-to. Your
   inbox is your lead list.

**Durable list — KV (optional, later):** bind a KV namespace named `LEADS` (Settings →
Functions → KV bindings). Leads also write there permanently for export.

**Zero setup:** with neither, leads appear in Deployments → your deploy → Functions logs as
`NEW LEAD: {...}`. Nothing lost; just read them there until you wire up email.

---

## Where this sits in the funnel
Prospector ranks chamber businesses (great reviews + weak site) → you point **AI Review**
at the top of that list → free report + auto-quote → you close the phased work → the
agent does the data-entry heavy lifting under your approval.

This tool is the conversion engine. It's ready the moment the subdomain resolves.
