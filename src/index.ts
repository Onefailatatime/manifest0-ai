import { getAgentByName } from "agents";
import { CONTAINER_MATERIALS, manifestCode, type ContainerMaterial } from "./manifest";
import { CONTAINER_TYPES, type ContainerType } from "./muse";
import type { ProductRow, VisitRow } from "./visit-agent";

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

    const visit = pathname.match(/^\/api\/visits\/([\w-]+)(\/photos|\/finish)?$/);
    if (visit) {
      const [, visitId, action] = visit;
      if (method === "GET" && !action) return getVisit(env, visitId);
      if (method === "POST" && action === "/photos") return addPhotos(request, env, visitId);
      if (method === "POST" && action === "/finish") return finishVisit(env, visitId);
    }

    const product = pathname.match(/^\/api\/products\/([\w-]+)$/);
    if (method === "PATCH" && product) return editProduct(request, env, product[1]);

    if (method === "GET" && pathname.startsWith("/api/files/")) {
      const obj = await env.FILES.get(decodeURIComponent(pathname.slice("/api/files/".length)));
      if (!obj) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      return new Response(obj.body, { headers });
    }

    // Everything else (the page) is served from ./public
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** Start a site visit and its agent. The first recipient is the technician (reply-to), the rest are the client. */
async function createVisit(request: Request, env: Env, origin: string) {
  const body = (await request.json()) as { recipients?: string[]; siteName?: string };
  const recipients = [...new Set((body.recipients ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (!recipients.length || recipients.length > 10 || !recipients.every(isEmail)) return error("Enter 1–10 valid email addresses.");

  const visitId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO visits (id, user_email, client_email, recipients, site_name) VALUES (?, ?, ?, ?, ?)")
    .bind(visitId, recipients[0], recipients.slice(1).join(", "), JSON.stringify(recipients), body.siteName?.trim() || null).run();

  const agent = await getAgentByName(env.VisitAgent, visitId);
  await agent.open(visitId, origin);
  return Response.json({ visitId });
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

  const batchId = crypto.randomUUID();
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

async function finishVisit(env: Env, visitId: string) {
  const visit = await env.DB.prepare("SELECT status FROM visits WHERE id = ?").bind(visitId).first<{ status: string }>();
  if (!visit) return error("Visit not found.", 404);
  if (visit.status !== "open") return error("This visit is already finished.");
  const agent = await getAgentByName(env.VisitAgent, visitId);
  await agent.finish();
  return Response.json({ ok: true });
}

/** Visit page data: the visit, its products, photo processing state, and the agent's log. */
async function getVisit(env: Env, visitId: string) {
  const visit = await env.DB.prepare("SELECT * FROM visits WHERE id = ?").bind(visitId).first<VisitRow>();
  if (!visit) return error("Not found", 404);
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
