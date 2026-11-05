import { getAgentByName } from "agents";
import { CONTAINER_MATERIALS, manifestCode, type ContainerMaterial } from "./manifest";
import { CONTAINER_TYPES, type ContainerType } from "./muse";
import { defaultEmail, inventoryCsv, type ProductRow, type VisitRow } from "./visit-agent";
import { reportPdf } from "./report-pdf";

/** Byte-order mark: makes Excel open the CSV as UTF-8 (accents, symbols). */
const BOM = String.fromCharCode(0xfeff);

// Durable Object classes must be exported from the entry file.
export { VisitAgent } from "./visit-agent";

const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const error = (message: string, status = 400) => Response.json({ error: message }, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { method } = request;
    const { pathname } = url;

    if (method === "POST" && pathname === "/api/visits") return createVisit(request, env, url.origin);
    if (method === "GET" && pathname === "/api/visits") return listVisits(env, url.searchParams.get("email") ?? "");

    const visit = pathname.match(/^\/api\/visits\/([\w-]+)(\/photos|\/finish|\/report|\/report\.pdf|\/inventory\.csv)?$/);
    if (visit) {
      const [, visitId, action] = visit;
      if (method === "GET" && !action) return getVisit(env, visitId);
      if (method === "DELETE" && !action) return deleteVisit(env, visitId, url.searchParams.get("email") ?? "");
      if (method === "POST" && action === "/photos") return addPhotos(request, env, visitId);
      if (method === "POST" && action === "/finish") return finishVisit(request, env, visitId);
      if (method === "GET" && action === "/report") return reportPreview(env, visitId);
      if (method === "GET" && action === "/report.pdf") return reportFile(env, visitId, url.searchParams.has("download"));
      if (method === "GET" && action === "/inventory.csv") return inventoryFile(env, visitId, url.searchParams.has("download"));
    }

    const product = pathname.match(/^\/api\/products\/([\w-]+)$/);
    if (method === "PATCH" && product) return editProduct(request, env, product[1]);

    if (method === "GET" && pathname.startsWith("/api/files/")) {
      const obj = await env.FILES.get(decodeURIComponent(pathname.slice("/api/files/".length)));
      if (!obj) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      // Open in the browser by default; ?download=1 (the Download button) saves it, named by ?name=.
      const name = (url.searchParams.get("name") ?? pathname.split("/").pop() ?? "file").replace(/[^\w\s.&()-]/g, "");
      headers.set("Content-Disposition", `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="${name}"`);
      return new Response(obj.body, { headers });
    }

    // Everything else (the page) is served from ./public
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** Start a site visit and its agent. The first recipient is the technician (reply-to), the rest are the client. */
async function createVisit(request: Request, env: Env, origin: string) {
  const body = (await request.json()) as { recipients?: string[]; siteName?: string; preparedBy?: string; company?: string };
  const recipients = [...new Set((body.recipients ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (!recipients.length || recipients.length > 10 || !recipients.every(isEmail)) return error("Enter 1–10 valid email addresses.");
  const siteName = body.siteName?.trim();
  if (!siteName) return error("Enter the site name.");

  const visitId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO visits (id, user_email, client_email, recipients, site_name, prepared_by, company) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(visitId, recipients[0], recipients.slice(1).join(", "), JSON.stringify(recipients), siteName,
      body.preparedBy?.trim().slice(0, 100) || null, body.company?.trim().slice(0, 100) || null).run();

  const agent = await getAgentByName(env.VisitAgent, visitId);
  await agent.open(visitId, origin);
  return Response.json({ visitId });
}

/**
 * The technician's site walks, newest first (the Locations list).
 * Demo: filtered by the email the app signed in with. Once real login exists this must come from the session, not the URL.
 */
async function listVisits(env: Env, email: string) {
  if (!isEmail(email)) return error("Enter a valid email.");
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.site_name, v.status, v.created_at, v.recipients, v.email_sent_at,
       (SELECT COUNT(*) FROM products p WHERE p.visit_id = v.id AND p.removed = 0) AS products
     FROM visits v WHERE v.user_email = ? AND v.deleted = 0 ORDER BY v.created_at DESC LIMIT 50`,
  ).bind(email.trim().toLowerCase()).all();
  return Response.json({ visits: results });
}

/** Delete a site walk from Locations (hidden, not erased). Only its technician can, and not while the report is sending. */
async function deleteVisit(env: Env, visitId: string, email: string) {
  const visit = await env.DB.prepare("SELECT user_email, status FROM visits WHERE id = ? AND deleted = 0").bind(visitId)
    .first<{ user_email: string; status: string }>();
  if (!visit) return error("Location not found.", 404);
  if (visit.user_email !== email.trim().toLowerCase()) return error("You can only delete your own locations.", 403);
  if (visit.status === "finishing") return error("The report is being sent. Try again in a minute.");
  await env.DB.prepare("UPDATE visits SET deleted = 1 WHERE id = ?").bind(visitId).run();
  return Response.json({ ok: true });
}

/** Add a batch of photos from one room; the agent processes them in the background. */
async function addPhotos(request: Request, env: Env, visitId: string) {
  const visit = await env.DB.prepare("SELECT status FROM visits WHERE id = ?").bind(visitId).first<{ status: string }>();
  if (!visit) return error("Visit not found.", 404);
  if (visit.status !== "open") return error("This visit is already finished.");

  const form = await request.formData();
  const room = String(form.get("room") ?? "").trim() || "Unspecified";
  const images = form.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
  if (images.length === 0 || images.length > MAX_IMAGES) return error(`Add 1–${MAX_IMAGES} photos.`);
  if (images.some((f) => !f.type.startsWith("image/") || f.size > MAX_IMAGE_BYTES)) return error("Photos must be images under 10 MB.");

  // The app names each upload and reuses the name when it retries. If a reply got lost on a bad signal but the photos
  // are already here, say "done" instead of saving them twice.
  const sent = String(form.get("batch") ?? "");
  const batchId = /^[0-9a-f-]{36}$/i.test(sent) ? sent : crypto.randomUUID();
  if (batchId === sent) {
    const seen = await env.DB.prepare("SELECT 1 FROM photos WHERE batch_id = ? AND visit_id = ? LIMIT 1").bind(batchId, visitId).first();
    if (seen) return Response.json({ batchId, duplicate: true });
  }
  const insert = env.DB.prepare("INSERT INTO photos (id, visit_id, batch_id, room, r2_key) VALUES (?, ?, ?, ?, ?)");
  const rows = await Promise.all(images.map(async (file, i) => {
    const id = crypto.randomUUID();
    const key = `visits/${visitId}/photos/${batchId}-${String(i).padStart(2, "0")}-${file.name.replace(/[^\w.-]/g, "_")}`;
    await env.FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
    return insert.bind(id, visitId, batchId, room, key);
  }));
  await env.DB.batch(rows);

  const agent = await getAgentByName(env.VisitAgent, visitId);
  await agent.addBatch(batchId);
  return Response.json({ batchId });
}

/**
 * Technician review of one product. Send only the fields that changed:
 * container fields (count, type, material, items inside) mark it as edited, so the agent won't overwrite them;
 * confirmed / removed are the Confirm and Remove buttons.
 */
async function editProduct(request: Request, env: Env, productId: string) {
  const body = (await request.json()) as {
    quantity?: number; containerType?: string; containerMaterial?: string; innerCount?: number | null;
    confirmed?: boolean; removed?: boolean;
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (column: string, value: unknown) => { sets.push(`${column} = ?`); params.push(value); };

  if (body.quantity !== undefined) {
    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) return error("Count must be a whole number, 1 or more.");
    set("quantity", quantity);
  }
  if (body.containerType !== undefined) {
    if (!CONTAINER_TYPES.includes(body.containerType as ContainerType)) return error("Unknown container type.");
    set("container_type", body.containerType);
  }
  if (body.containerMaterial !== undefined) {
    if (!CONTAINER_MATERIALS.includes(body.containerMaterial as ContainerMaterial)) return error("Unknown container material.");
    set("container_material", body.containerMaterial);
  }
  if (body.innerCount !== undefined) {
    const innerCount = body.innerCount === null ? null : Number(body.innerCount);
    if (innerCount !== null && (!Number.isInteger(innerCount) || innerCount < 0)) return error("Items inside must be a whole number.");
    set("inner_count", innerCount);
  }
  if (sets.length) sets.push("count_note = NULL", "count_edited = 1");
  if (body.confirmed !== undefined) set("confirmed", body.confirmed ? 1 : 0);
  if (body.removed !== undefined) set("removed", body.removed ? 1 : 0);
  if (!sets.length) return error("Nothing to change.");

  const row = await env.DB.prepare(
    "SELECT v.status FROM products p JOIN visits v ON v.id = p.visit_id WHERE p.id = ?",
  ).bind(productId).first<{ status: string }>();
  if (!row) return error("Product not found.", 404);
  if (row.status !== "open") return error("This visit is already finished.");

  await env.DB.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`).bind(...params, productId).run();
  return Response.json({ ok: true });
}

/** What the client will get: the email draft (editable) and the attachments, each of which can be opened to look at. */
async function reportPreview(env: Env, visitId: string) {
  const loaded = await loadReport(env, visitId);
  if (!loaded) return error("Not found", 404);
  const { visit, products } = loaded;
  const draft = defaultEmail(visit, products);
  const site = visit.site_name ?? "site";
  const sds = new Map<string, string>();                 // one SDS per PDF, even if several rows share it
  for (const p of products) if (p.sds_key && !sds.has(p.sds_key)) sds.set(p.sds_key, p.product_name);
  return Response.json({
    to: (JSON.parse(visit.recipients) as string[]).slice(1),
    cc: visit.user_email,
    subject: visit.email_subject || draft.subject,
    message: visit.email_message ?? draft.message,
    attachments: [
      { name: `Inventory report - ${site}.pdf`, kind: "report", url: `/api/visits/${visitId}/report.pdf` },
      { name: `Inventory - ${site}.csv`, kind: "spreadsheet", url: `/api/visits/${visitId}/inventory.csv` },
      ...[...sds].map(([key, name]) => ({ name: `SDS - ${name}.pdf`, kind: "sds", url: `/api/files/${key}` })),
    ],
    missingSds: products.filter((p) => !p.sds_key).map((p) => p.product_name),
  });
}

/** The report PDF, exactly as it will be attached. */
async function reportFile(env: Env, visitId: string, download: boolean) {
  const loaded = await loadReport(env, visitId);
  if (!loaded) return error("Not found", 404);
  const name = `Inventory report - ${(loaded.visit.site_name ?? "site").replace(/[^\w\s.&()-]/g, "")}.pdf`;
  const pdf = await reportPdf(loaded.visit, loaded.products);
  return new Response(pdf.buffer as ArrayBuffer, {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`, "Cache-Control": "no-store" },
  });
}

/** The inventory spreadsheet, exactly as it will be attached. */
async function inventoryFile(env: Env, visitId: string, download: boolean) {
  const loaded = await loadReport(env, visitId);
  if (!loaded) return error("Not found", 404);
  const name = `Inventory - ${(loaded.visit.site_name ?? "site").replace(/[^\w\s.&()-]/g, "")}.csv`;
  return new Response(BOM + inventoryCsv(loaded.products), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`, "Cache-Control": "no-store" },
  });
}

async function loadReport(env: Env, visitId: string) {
  const visit = await env.DB.prepare("SELECT * FROM visits WHERE id = ? AND deleted = 0").bind(visitId).first<VisitRow>();
  if (!visit) return null;
  const { results: products } = await env.DB.prepare(
    "SELECT * FROM products WHERE visit_id = ? AND removed = 0 ORDER BY room, product_name",
  ).bind(visitId).all<ProductRow>();
  return { visit, products };
}

/** Send the report, with the subject and message as the technician reviewed them. */
async function finishVisit(request: Request, env: Env, visitId: string) {
  const visit = await env.DB.prepare("SELECT status FROM visits WHERE id = ?").bind(visitId).first<{ status: string }>();
  if (!visit) return error("Visit not found.", 404);
  if (visit.status !== "open") return error("This visit is already finished.");
  const body = (await request.json().catch(() => ({}))) as { subject?: string; message?: string };
  const subject = body.subject?.trim().slice(0, 200) || null;
  const message = body.message?.trim().slice(0, 5000) || null;
  await env.DB.prepare("UPDATE visits SET email_subject = ?, email_message = ? WHERE id = ?").bind(subject, message, visitId).run();
  const agent = await getAgentByName(env.VisitAgent, visitId);
  await agent.finish();
  return Response.json({ ok: true });
}

/** Visit page data: the visit, its products, photo processing state, and the agent's log. */
async function getVisit(env: Env, visitId: string) {
  const visit = await env.DB.prepare("SELECT * FROM visits WHERE id = ? AND deleted = 0").bind(visitId).first<VisitRow>();
  if (!visit) return error("This location was deleted or doesn't exist.", 404);
  const [{ results: products }, photos, { results: rooms }] = await Promise.all([
    // Removed products are kept in the table (so new photos of them stay removed) but not shown.
    env.DB.prepare("SELECT * FROM products WHERE visit_id = ? AND removed = 0 ORDER BY room, product_name").bind(visitId).all<ProductRow>(),
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(processed = 0) AS pending FROM photos WHERE visit_id = ?")
      .bind(visitId).first<{ total: number; pending: number | null }>(),
    // Every room photographed so far (the room dropdown), in the order they were visited.
    env.DB.prepare("SELECT room FROM photos WHERE visit_id = ? GROUP BY room ORDER BY MIN(created_at)").bind(visitId).all<{ room: string }>(),
  ]);
  const agent = await getAgentByName(env.VisitAgent, visitId);
  return Response.json({
    visit,
    products: products.map((p) => ({ ...p, manifest: manifestCode(p.container_type, p.container_material) })),
    photos: { total: photos?.total ?? 0, pending: photos?.pending ?? 0 }, rooms: rooms.map((r) => r.room), log: await agent.getLog(),
  });
}
