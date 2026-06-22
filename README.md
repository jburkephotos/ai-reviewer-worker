# AI Review — deploy to live

This is the complete, deployment-ready tool. Front-end + the hybrid audit engine
(deterministic parsing for the exact numbers, Claude for the editorial judgment).
Going live is copy-paste-and-deploy — the build is done.

Target: **aireview.jburkephotos.com**

---

## What's in here

```
ai-review-worker/
├── index.html              ← the public front-end (calls /api/audit)
└── functions/
    └── api/
        └── audit.js        ← the audit engine (Cloudflare Pages Function)
```

Cloudflare Pages automatically turns anything in `functions/` into serverless routes.
`functions/api/audit.js` becomes `POST /api/audit`. No separate Worker project needed.

---

## How it works (the architecture you chose — Option 3, hybrid)

1. **Deterministic layer** (pure JS in audit.js): crawls up to 12 pages, measures the
   hard signals exactly — JSON-LD schema and which @types, meta descriptions, alt-text
   coverage, HTTPS, mobile viewport, OpenGraph, breadcrumbs, page count, store detection.
   These drive the **tier** and the **quote**, so they're code, not Claude — exact and
   identical every run. (Tier logic is unit-tested: e-commerce overrides page count into
   Large; 35+ pages → Enterprise.)

2. **Judgment layer** (Claude, opus-4-8): gets the measured facts + page digests and
   produces what code can't — the three-surface read (Google/SEO · AI Search · Local),
   the prioritized findings, the editorial narrative. The system prompt encodes your
   actual methodology: three surfaces, five hard gates, truth-first / no-invented-facts,
   anti-slop voice. Each finding is tagged agent / editorial / approve so prospects see
   your "agent does the data entry, I approve" model right on the page.

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
- It's a public tool, so if it ever gets hammered, add a simple rate limit (Cloudflare
  Turnstile on the form, or a KV counter per IP). Not needed at launch; note it for later.
- Model is set to `claude-opus-4-8` because the report quality IS the product. If you want
  to cut cost later, swap to Sonnet in `CLAUDE_MODEL` — but test the voice first; Opus
  reads more like you.

---

## Where this sits in the funnel
Prospector ranks chamber businesses (great reviews + weak site) → you point **AI Review**
at the top of that list → free report + auto-quote → you close the phased work → the
agent does the data-entry heavy lifting under your approval.

This tool is the conversion engine. It's ready the moment the subdomain resolves.
