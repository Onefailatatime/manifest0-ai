# Manifest0 AI

Photograph chemical labels → Muse Spark reads them into an inventory → finds each product's SDS on the web →
saves the PDFs → emails the inventory + SDS sheets to the technician and the client.

Cloudflare Worker `manifest0-ai`. Live at https://manifest0-ai.modecandsllc.workers.dev

## How it works

A technician starts a **site visit**, then uploads photos room by room (as many uploads as they like),
then taps **Finish**. One `VisitAgent` (Agents SDK) lives for the whole visit and remembers everything in it.

```
Browser (public/app/index.html, the app at app.manifest0ai.com and /app/)
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

## Landing page (manifest0ai.com/)

`manifest0ai.com/` is the beta landing page (`public/index.html`, `landing.css`, `landing.js`). The app is at
`app.manifest0ai.com` (its home page serves `public/app/`) and also at `/app/` on any host.
- One screen: logo, headline, one line, a ~30 s looping screen recording of the real app (`public/img/app-walkthrough.mp4`,
  H.264 + AAC) and the apply form. The recording is a demo walk on a local copy: a label photo is snapped (staged camera
  shot) and read (staged server answers, so no AI call; the app screens are real), then that product's
  hazards, and the email reviewed, edited and approved (to the client, a copy to the technician), shown on a phone on a dark stage that the camera pushes in on, with narration (ElevenLabs, voice "Bella"), swoosh and tap sounds and generated music (Google Lyria). It plays muted;
  the speaker button on the phone turns the sound on. The poster `app-screen.webp` / `.png` is its first frame, and
  people who prefer reduced motion see only the poster. Desktop adds three short points. Dark only (B7), whatever
  the device setting. The app itself still follows the device (light B1, dark B7).
- Apply form asks for work email and company only: `POST /api/landing/apply` saves to `beta_applications`
  (migration `0007_landing.sql`) and emails a "you're on the list" confirmation (once per email).
- Traffic source: card QR `https://manifest0ai.com/?src=card`, email links `?src=email`. The tag is saved for 30 days
  on the device, sent with the form, and each tagged visit is counted (`landing_events`). `/join` and `/beta` redirect
  to `/` and keep the query. Old report links (`/?visit=ID`) forward to `/app/?visit=ID`.
- Admin: `/admin/` (sign in with an admin email) shows applications, From card and From email counts and a CSV.
  **Approve** lets that applicant sign in to the app and emails them a sign-in link.

## Sign-in

Technicians sign in with a link emailed to them (Better Auth, `src/auth.ts`, tables in `0008_auth.sql`). No passwords.
- Only approved applicants (Approve on `/admin/`), people who already have an account, and `ADMIN_EMAILS` can sign in.
  Anyone else sees the same "check your inbox" message but gets no email.
- Every `/api/visits*`, `/api/products*` and `/api/files/visits/*` request needs a session, and each technician only
  reaches their own walks (admins too: being admin only opens `/admin/`). SDS PDFs (`/api/files/sds/*`) stay public because client emails link to them.
- Walks made before sign-in existed are linked by email the first time that technician signs in.
- Secrets, set once: `npx wrangler secret put BETTER_AUTH_SECRET` (a long random string) and
  `npx wrangler secret put ADMIN_EMAILS` (comma-separated admin emails). Locally they go in `.dev.vars`.
- Without `RESEND_API_KEY`, sign-in links are written to the log (`wrangler dev` output) instead of emailed.
