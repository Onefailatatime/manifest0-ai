// Test data: visits and products with sensible defaults; override only what a test cares about.
import { env } from "cloudflare:test";
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

/** Creates a walk through the API, like the app does. */
export async function createVisit(SELF: Fetcher, body: Record<string, unknown> = {}) {
  const res = await SELF.fetch("https://app.test/api/visits", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipients: [TECH, CLIENT], siteName: "Riverside Clinic", preparedBy: "Tamara", ...body }),
  });
  return { res, json: (await res.json()) as { visitId?: string; error?: string } };
}

/** Puts a product straight into the database (Muse is not called in tests). */
export async function insertProduct(p: ProductRow) {
  const cols = Object.keys(p);
  await env.DB.prepare(`INSERT INTO products (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map((c) => p[c as keyof ProductRow])).run();
}
