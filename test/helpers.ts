// Test data: visits and products with sensible defaults; override only what a test cares about.
import { env, SELF } from "cloudflare:test";
import { vi } from "vitest";
import type { ProductRow, VisitRow } from "../src/visit-agent";

export const TECH = "tech@example.com";
export const CLIENT = "client@example.com";

export function visitRow(over: Partial<VisitRow> = {}): VisitRow {
  return {
    id: "visit-1", created_at: "2026-10-29 10:00:00", user_email: TECH, client_email: CLIENT,
    recipients: JSON.stringify([TECH, CLIENT]), site_name: "Riverside Clinic", status: "open", error: null,
    email_sent_at: null, email_subject: null, email_message: null, prepared_by: "Tamara", company: "Acme Environmental",
    ...over,
  };
}

export function productRow(over: Partial<ProductRow> = {}): ProductRow {
  return {
    id: crypto.randomUUID(), visit_id: "visit-1", room: "Janitor closet", manufacturer: "STERIS Corporation",
    product_name: "Septihol Ready-To-Use Alcohol Solution", product_code: "625477", container_type: "bottle",
    container_material: "plastic", container_size: "650 mL (22 fl. oz.)", inner_type: null, inner_count: null, inner_size: null,
    quantity: 3, count_note: null, count_edited: 0, physical_state: "liquid", signal_word: "DANGER",
    hazard_class: "3 (Flammable liquid)", un_number: "UN1219", confirmed: 0, removed: 0,
    hazard_statements: JSON.stringify(["Highly flammable liquid and vapour."]), ghs_pictograms: JSON.stringify(["flammable"]),
    ingredients: JSON.stringify(["Isopropyl alcohol 70%"]), photo_keys: "[]", sds_status: "found", sds_source: "web",
    sds_url: "https://example.com/sds.pdf", sds_page_url: null, sds_key: "sds/test.pdf", sds_notes: null,
    ...over,
  };
}

export const ADMIN = "admin@example.com"; // ADMIN_EMAILS in vitest.config.mts

type Call = (path: string, init?: RequestInit) => Promise<Response>;

/** Approves a beta application for this email (as the admin's Approve button does). */
export async function approve(email: string, name: string | null = "Tamara") {
  await env.DB.prepare("INSERT OR IGNORE INTO beta_applications (id, created_at, name, company, email, approved_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), Date.now(), name, "Acme Environmental", email, Date.now()).run();
}

/** Asks for a sign-in link. Without a Resend key the Worker logs it; returns the link, or undefined when none was sent. */
export async function requestLink(email: string) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const res = await SELF.fetch("https://app.test/api/auth/sign-in/magic-link", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.test" }, body: JSON.stringify({ email }),
    });
    await res.text();
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith(`Sign-in link for ${email}: `));
    return line?.split(": ").pop();
  } finally {
    log.mockRestore();
  }
}

/** Opens a sign-in link and returns the session cookie (empty when sign-in failed). */
export async function openLink(link: string) {
  const res = await SELF.fetch(link, { redirect: "manual" });
  await res.text();
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

/** Signs in through the emailed link, like a technician does. Approves the email first unless told not to. */
export async function signIn(email = TECH, { approved = true } = {}) {
  if (approved) await approve(email);
  const link = await requestLink(email);
  if (!link) throw new Error(`No sign-in link for ${email}`);
  return openLink(link);
}

/** fetch on https://app.test as whoever owns this cookie. */
export const as = (cookie: string): Call => (path, init = {}) => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("Origin", "https://app.test");
  return SELF.fetch(`https://app.test${path}`, { ...init, headers });
};

/** Creates a walk through the API, like the app does. */
export async function createVisit(call: Call, body: Record<string, unknown> = {}) {
  const res = await call("/api/visits", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipients: [CLIENT], siteName: "Riverside Clinic", ...body }),
  });
  return { res, json: (await res.json()) as { visitId?: string; error?: string } };
}

/** Puts a product straight into the database (Muse is not called in tests). */
export async function insertProduct(p: ProductRow) {
  const cols = Object.keys(p);
  await env.DB.prepare(`INSERT INTO products (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map((c) => p[c as keyof ProductRow])).run();
}
