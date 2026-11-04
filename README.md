# Manifest0 AI

Photograph chemical labels → Muse Spark reads them into an inventory → finds each product's SDS on the web →
saves the PDFs → emails the inventory + SDS sheets to the technician and the client.

Cloudflare Worker `manifest0-ai`. Live at https://manifest0-ai.modecandsllc.workers.dev

## How it works

A technician starts a **site visit**, then uploads photos room by room (as many uploads as they like),
then taps **Finish**. One `VisitAgent` (Agents SDK) lives for the whole visit and remembers everything in it.

```
Browser (public/index.html)
   │  POST /api/visits                 start a visit (emails, site name)
   │  POST /api/visits/:id/photos      a batch of photos + room name   (repeat)
   │  POST /api/visits/:id/finish      done → email
   ▼
Worker (src/index.ts) ── saves photos to R2, rows to D1, hands work to the visit's agent
   │
   ▼
VisitAgent (src/visit-agent.ts) — one per visit, durable queue, one step at a time:
   processBatch  Muse reads the new photos AND the products already found in that room,
                 so overlapping photos update a product instead of duplicating it
   findSds       SDS library first (shared across all visits); else Muse web search →
                 download PDF → R2 → add to library
   sendReport    after Finish (and after pending work): inventory + SDS PDFs via Cloudflare Email
```

| Piece | Cloudflare product | Binding |
| --- | --- | --- |
| Database (`visits`, `photos`, `products`, `sds_library`) | D1 | `env.DB` |
| Label photos, SDS PDFs | R2 | `env.FILES` |
| Per-visit memory + background work | Agents SDK (Durable Object) | `env.VisitAgent` |
| Report email | Email Service | `env.EMAIL` |
| AI | Meta Model API, `muse-spark-1.3` | secret `MODEL_API_KEY` |

## How Manifest0-Ai uses Muse Spark

Manifest0-Ai calls Meta's Model API (Responses endpoint, `https://api.meta.ai/v1/responses`) with the model set by `MUSE_MODEL` (default `muse-spark-1.3`). All Muse code is in `src/muse.ts`. It is called from the `VisitAgent` (`src/visit-agent.ts`), one Agents SDK agent per site visit.

Muse Spark does two jobs:

**1. Reading label photos (`extractProducts`)**
- A rep uploads a batch of photos for one room. All photos in the batch go to Muse in a single vision call.
- Muse must answer in strict JSON (`json_schema`, `strict: true`) with one entry per distinct product: manufacturer, product name, product code (EPA Reg. No. or UPC), container type, material and size, inner items for packed boxes or drums, physical state, signal word, DOT hazard class, UN number, hazard statements, GHS pictograms, ingredients, quantity, and which photos show it.
- The prompt tells Muse to merge front and back shots of the same product, count each container once, copy text exactly as printed, and use null instead of guessing.
- Room memory: products already found in that room are sent with each new batch. Muse sets `matchesProductId` when a new photo shows a product it already saw, so overlapping photos update a product instead of duplicating it.

**2. Finding the Safety Data Sheet (`findSds`)**
- For each new product, the agent first checks a shared SDS library in D1 (match on manufacturer plus product name, or product code). If it was found on an earlier visit, it is reused with no Muse call.
- Otherwise Muse runs with Meta's `web_search` tool to find the official SDS PDF, preferring the manufacturer's US site. It returns `pdfUrl`, `pageUrl`, `isSds`, `confidence` and `notes`. Muse is told that ingredient disclosures, spec sheets and labels are not SDSs.
- Only when `isSds` is true and a PDF URL is given, the agent downloads the PDF, saves it to R2 and adds it to the SDS library. Up to 4 SDS searches run at once.

Muse does not assign EPA waste codes. Container codes come from plain rules in the app code. After the rep taps Finish, the inventory and SDS PDFs are emailed (Resend).

### Next steps
- Hands-free capture from Ray-Ban Meta glasses, so a rep can photograph labels while walking the site.
- Voice Transcribe for spoken notes during a site walk.
- SAM 3.1 for photo understanding, such as separating and counting containers in crowded shelf photos.

Accuracy on our 3 sample products: see [docs/accuracy.md](docs/accuracy.md).

## Local development

```bash
npm install
printf "MODEL_API_KEY=...\nRESEND_API_KEY=\n" > .dev.vars   # Muse key from https://dev.meta.ai/api-keys
npx wrangler d1 migrations apply manifest0-db --local
npx wrangler dev
```

Locally, D1 and R2 are simulated on your machine; Muse calls are real. With `RESEND_API_KEY` empty, no email is
sent and the report is saved instead (the visit log shows its link). Put a real Resend key there to send for real.

## Tests

```bash
npm test          # run once
npm run check     # type-check the app and the tests
```

Tests run inside the Workers runtime (Cloudflare's Vitest plugin) with a local D1 and R2, emptied before each test.
Muse and Resend are never called. `test/report.test.ts` covers manifest codes, the spreadsheet, the email draft and
the PDF; `test/api.test.ts` covers the API (walks, products, Locations, deleting, review, files).

## One-time production setup (Cloudflare account owner)

```bash
npx wrangler d1 create manifest0-db                 # paste the database_id into wrangler.jsonc
npx wrangler r2 bucket create manifest0-files
npx wrangler secret put MODEL_API_KEY
npx wrangler secret put RESEND_API_KEY
```

Set the Workers Builds deploy command to `npm run deploy`: it applies D1 migrations, then deploys.
A step-by-step dashboard version (no terminal) is in the "Manifest Zero: Setup for Jessica" doc.

After that, pushes to `main` deploy automatically (Workers Builds).

## Email setup (Resend, free plan)

Free plan: 3,000 emails/month, 100/day, up to 40 MB of attachments per email.

1. **Buy a domain for the project.** Easiest is Cloudflare itself (dashboard → Domain Registration → Register Domains,
   sold at cost). Then the domain's DNS is already in Cloudflare, which makes step 4 one click.
2. **Create a Resend account** at https://resend.com (free).
3. **Add the domain:** Resend → Domains → Add Domain. Use a subdomain like `mail.yourdomain.com`
   so the main domain's email is kept separate.
4. **Verify it:** Resend shows a few DNS records (SPF and DKIM; DMARC is recommended).
   If the domain is on Cloudflare, use Resend's "Sign in to Cloudflare" button to add them automatically,
   or copy them into Cloudflare → DNS → Records. Wait until Resend shows the domain as **Verified**.
5. **Create an API key:** Resend → API Keys → Create (permission: "Sending access", limited to this domain).
6. **Give it to the Worker:**
   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```
7. **Set the sender** in `wrangler.jsonc` → `vars.EMAIL_FROM`, e.g. `"Manifest0 AI <reports@yourdomain.com>"`.

Until the domain is verified, Resend only allows sending from `onboarding@resend.dev` to the email address
the Resend account was created with, which is fine for testing.

## License

License: MIT. See [LICENSE](LICENSE).
