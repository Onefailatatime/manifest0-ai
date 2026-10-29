// Landing page API (the page itself is public/index.html at /).
//   POST /api/landing/apply   beta application form
//   POST /api/landing/visit   one row per tagged visit (?src=card, ?src=email) or app button tap
//   GET  /api/landing/admin   applications + counts per source, header x-admin-key = secret ADMIN_KEY
//   GET  /api/landing/admin.csv
// Tables: migrations/0007_landing.sql (in manifest0-db).

type LandingEnv = { DB: D1Database; ADMIN_KEY?: string };

const TZ = "America/Los_Angeles";
const FIELD_WORKERS = ["1", "2 to 5", "6 to 10", "11 to 25", "26+"];
const CONTAINERS = ["Under 50", "50 to 200", "200 to 500", "500 to 1,000", "Over 1,000"];
const ROLES = ["Owner", "Operations manager", "Field lead or technician", "Compliance or EHS", "Other"];
const STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","PR","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];
const KINDS = ["visit", "app_click"];

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (message: string, status = 400) => json({ ok: false, error: message }, status);
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254;
const clean = (v: unknown, max = 200) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const cleanMulti = (v: unknown, max = 2000) => String(v ?? "").replace(/\r/g, "").trim().slice(0, max);
/** Source tag from ?src= / utm_* (e.g. "card"). Lowercase, short, safe characters only. */
export const cleanSource = (v: unknown) =>
  String(v ?? "").toLowerCase().replace(/[^a-z0-9_.:\/ -]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
const country = (req: Request) => ((req as any).cf?.country as string) || null;
const ptTime = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(ms)) + " PT";

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try { const b = await req.json(); return b && typeof b === "object" ? (b as Record<string, unknown>) : null; } catch { return null; }
}
const logEvent = (env: LandingEnv, req: Request, kind: string, source: string | null, email: string | null = null) =>
  env.DB.prepare("INSERT INTO landing_events (ts, kind, source, email, ip_country) VALUES (?,?,?,?,?)")
    .bind(Date.now(), kind, source, email, country(req)).run();

async function apply(req: Request, env: LandingEnv) {
  const b = await readJson(req);
  if (!b) return fail("Something went wrong. Please try again.");
  if (clean(b.website)) return json({ ok: true }); // honeypot
  // The page asks only for work email and company. The other fields are optional and checked only when sent.
  const a = {
    name: clean(b.name, 120) || null, company: clean(b.company, 160), email: clean(b.email, 254).toLowerCase(),
    phone: clean(b.phone, 40) || null, state: clean(b.state, 4) || null, role: clean(b.role, 60) || null,
    field_workers: clean(b.field_workers, 20) || null, containers: clean(b.containers_per_month, 30) || null,
    struggles: cleanMulti(b.struggles) || null, tools: cleanMulti(b.tools_wanted) || null, source: cleanSource(b.source) || null,
  };
  const errors: Record<string, string> = {};
  if (!isEmail(a.email)) errors.email = "Enter a valid work email.";
  if (!a.company) errors.company = "Enter your company name.";
  if (a.phone && a.phone.replace(/\D/g, "").length < 10) errors.phone = "Enter a 10 digit phone number or leave it blank.";
  if (a.state && !STATES.includes(a.state)) errors.state = "Choose your state.";
  if (a.role && !ROLES.includes(a.role)) errors.role = "Choose your role.";
  if (a.field_workers && !FIELD_WORKERS.includes(a.field_workers)) errors.field_workers = "Choose how many field workers take inventory.";
  if (a.containers && !CONTAINERS.includes(a.containers)) errors.containers_per_month = "Choose a range or leave it blank.";
  if (Object.keys(errors).length) return json({ ok: false, error: "Please fix the highlighted fields.", errors }, 400);

  const existing = await env.DB.prepare("SELECT id FROM beta_applications WHERE email = ?").bind(a.email).first();
  if (existing) { await logEvent(env, req, "apply_duplicate", a.source, a.email); return json({ ok: true, duplicate: true }); }
  await env.DB.prepare(`INSERT INTO beta_applications (id, created_at, name, company, email, phone, state, role, field_workers,
      containers_per_month, struggles, tools_wanted, source, ip_country, user_agent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), Date.now(), a.name, a.company, a.email, a.phone, a.state, a.role, a.field_workers, a.containers,
      a.struggles, a.tools, a.source, country(req), clean(req.headers.get("user-agent"), 300) || null).run();
  await logEvent(env, req, "apply", a.source, a.email);
  return json({ ok: true });
}

async function visit(req: Request, env: LandingEnv) {
  const b = await readJson(req);
  const source = cleanSource(b?.source);
  const kind = clean(b?.kind, 20) || "visit";
  if (!source || !KINDS.includes(kind)) return fail("Bad request.");
  await logEvent(env, req, kind, source);
  return json({ ok: true });
}

function authorized(req: Request, env: LandingEnv) {
  const key = req.headers.get("x-admin-key") || "";
  const want = env.ADMIN_KEY || "";
  if (want.length < 12 || key.length !== want.length) return false;
  let r = 0;
  for (let i = 0; i < key.length; i++) r |= key.charCodeAt(i) ^ want.charCodeAt(i);
  return r === 0;
}

type AppRow = { id: string; created_at: number; name: string | null; company: string; email: string; phone: string | null; state: string | null;
  role: string | null; field_workers: string | null; containers_per_month: string | null; struggles: string | null; tools_wanted: string | null; source: string | null };

async function admin(req: Request, env: LandingEnv) {
  if (!authorized(req, env)) return fail(env.ADMIN_KEY ? "Wrong admin key." : "ADMIN_KEY is not set on the Worker.", 401);
  const [{ results: apps }, { results: ev }] = await Promise.all([
    env.DB.prepare("SELECT * FROM beta_applications ORDER BY created_at DESC LIMIT 500").all<AppRow>(),
    env.DB.prepare("SELECT COALESCE(source,'direct') AS source, kind, COUNT(*) AS n FROM landing_events GROUP BY 1,2").all<{ source: string; kind: string; n: number }>(),
  ]);
  const src = new Map<string, { source: string; visits: number; app_clicks: number; applications: number }>();
  const row = (s: string) => src.get(s) ?? (src.set(s, { source: s, visits: 0, app_clicks: 0, applications: 0 }), src.get(s)!);
  for (const e of ev) { if (e.kind === "visit") row(e.source).visits += e.n; if (e.kind === "app_click") row(e.source).app_clicks += e.n; }
  for (const a of apps) row(a.source || "direct").applications++;
  const none = (source: string) => ({ source, visits: 0, app_clicks: 0, applications: 0 });
  const card = src.get("card") ?? none("card");
  const mail = src.get("email") ?? none("email");
  return json({
    ok: true,
    totals: { applications: apps.length, from_card_applications: card.applications, from_card_visits: card.visits, from_card_app_clicks: card.app_clicks,
      from_email_applications: mail.applications, from_email_visits: mail.visits },
    sources: [...src.values()].sort((x, y) => y.applications - x.applications || y.visits - x.visits),
    applications: apps.map((a) => ({ ...a, created_pt: ptTime(a.created_at), from_card: a.source === "card", from_email: a.source === "email" })),
  });
}

async function adminCsv(req: Request, env: LandingEnv) {
  if (!authorized(req, env)) return fail("Wrong admin key.", 401);
  const { results } = await env.DB.prepare("SELECT * FROM beta_applications ORDER BY created_at DESC").all<AppRow>();
  const cols = ["created_pt", "name", "company", "email", "phone", "state", "role", "field_workers", "containers_per_month", "struggles", "tools_wanted", "source"] as const;
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [cols.join(","), ...results.map((r) => cols.map((c) => cell(c === "created_pt" ? ptTime(r.created_at) : r[c])).join(","))];
  return new Response(lines.join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="beta-applications.csv"', "cache-control": "no-store" } });
}

/** Returns a Response for /api/landing/* paths, or null when the path is not ours. */
export async function handleLanding(req: Request, env: LandingEnv, pathname: string): Promise<Response | null> {
  const m = req.method;
  if (m === "POST" && pathname === "/api/landing/apply") return apply(req, env);
  if (m === "POST" && pathname === "/api/landing/visit") return visit(req, env);
  if (m === "GET" && pathname === "/api/landing/admin") return admin(req, env);
  if (m === "GET" && pathname === "/api/landing/admin.csv") return adminCsv(req, env);
  if (pathname.startsWith("/api/landing/")) return fail("Not found.", 404);
  return null;
}
