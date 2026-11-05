import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CLIENT, TECH, as, insertProduct, productRow, signIn, createVisit as create } from "./helpers";

// Every test runs as TECH, signed in.
let call: ReturnType<typeof as>;
beforeEach(async () => { call = as(await signIn(TECH)); });

const json = (body: unknown) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const createVisit = (body?: Record<string, unknown>) => create(call, body);
const getVisit = async (id: string) => (await (await call(`/api/visits/${id}`)).json()) as any;
const patch = (id: string, body: unknown) => call(`/api/products/${id}`, { method: "PATCH", ...json(body) });

describe("retrying a photo upload", () => {
  it("does not save a batch twice when the app resends it after a lost reply", async () => {
    const { json: out } = await createVisit();
    const batch = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO photos (id, visit_id, batch_id, room, r2_key) VALUES (?, ?, ?, 'Warehouse', 'k')")
      .bind(crypto.randomUUID(), out.visitId, batch).run();
    const fd = new FormData();
    fd.append("room", "Warehouse");
    fd.append("batch", batch);
    fd.append("images", new File([new Uint8Array(10)], "a.jpg", { type: "image/jpeg" }));
    const res = await call(`/api/visits/${out.visitId}/photos`, { method: "POST", body: fd });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ batchId: batch, duplicate: true });
    const { n } = (await env.DB.prepare("SELECT COUNT(*) n FROM photos WHERE visit_id = ?").bind(out.visitId).first()) as any;
    expect(n).toBe(1);
  });
});

describe("starting a walk", () => {
  it("creates a walk with the technician first, the client after, and the name and company from the account", async () => {
    const { res, json: out } = await createVisit();
    expect(res.status).toBe(200);
    const { visit } = await getVisit(out.visitId!);
    expect(visit.site_name).toBe("Riverside Clinic");
    expect(visit.user_email).toBe(TECH);
    expect(JSON.parse(visit.recipients)).toEqual([TECH, CLIENT]);
    expect(visit.prepared_by).toBe("Tamara");
    expect(visit.company).toBe("Acme Environmental");
    expect(visit.status).toBe("open");
  });

  it("requires a site name", async () => {
    const { res, json: out } = await createVisit({ siteName: "   " });
    expect(res.status).toBe(400);
    expect(out.error).toMatch(/site name/i);
  });

  it("rejects a bad email address", async () => {
    const { res } = await createVisit({ recipients: [TECH, "not-an-email"] });
    expect(res.status).toBe(400);
  });

  it("lowercases and de-duplicates the addresses", async () => {
    const { json: out } = await createVisit({ recipients: ["Tech@Example.com", CLIENT, "CLIENT@example.com"] });
    const { visit } = await getVisit(out.visitId!);
    expect(JSON.parse(visit.recipients)).toEqual([TECH, CLIENT]);
  });
});

describe("Locations list", () => {
  it("lists only my walks, newest first, with product counts", async () => {
    const a = (await createVisit({ siteName: "First" })).json.visitId!;
    await env.DB.prepare("UPDATE visits SET created_at = '2026-01-01 00:00:00' WHERE id = ?").bind(a).run();
    const b = (await createVisit({ siteName: "Second" })).json.visitId!;
    await create(as(await signIn("someone@else.com")), { siteName: "Not mine" });
    await insertProduct(productRow({ visit_id: b }));

    const { visits } = (await (await call(`/api/visits`)).json()) as any;
    expect(visits.map((v: any) => v.site_name)).toEqual(["Second", "First"]);
    expect(visits[0].products).toBe(1);
  });
});

describe("deleting a site", () => {
  it("only the technician who made it can delete it", async () => {
    const id = (await createVisit()).json.visitId!;
    const wrong = await as(await signIn("someone@else.com"))(`/api/visits/${id}`, { method: "DELETE" });
    expect(wrong.status).toBe(404);

    const right = await call(`/api/visits/${id}`, { method: "DELETE" });
    expect(right.status).toBe(200);
    expect((await call(`/api/visits/${id}`)).status).toBe(404);
    const { visits } = (await (await call(`/api/visits`)).json()) as any;
    expect(visits).toHaveLength(0);
  });

  it("keeps the data (hidden, not erased)", async () => {
    const id = (await createVisit()).json.visitId!;
    await call(`/api/visits/${id}`, { method: "DELETE" });
    const row = await env.DB.prepare("SELECT deleted FROM visits WHERE id = ?").bind(id).first<{ deleted: number }>();
    expect(row?.deleted).toBe(1);
  });
});

describe("editing a product", () => {
  async function setup() {
    const visitId = (await createVisit()).json.visitId!;
    const p = productRow({ visit_id: visitId });
    await insertProduct(p);
    return { visitId, p };
  }

  it("saves count, type and material and marks it as edited", async () => {
    const { visitId, p } = await setup();
    expect((await patch(p.id, { quantity: 5, containerType: "drum", containerMaterial: "metal" })).status).toBe(200);
    const saved = (await getVisit(visitId)).products[0];
    expect(saved).toMatchObject({ quantity: 5, container_type: "drum", container_material: "metal", count_edited: 1 });
    expect(saved.manifest.code).toBe("DM");
  });

  it("rejects nonsense values", async () => {
    const { p } = await setup();
    expect((await patch(p.id, { quantity: 0 })).status).toBe(400);
    expect((await patch(p.id, { quantity: 2.5 })).status).toBe(400);
    expect((await patch(p.id, { containerType: "spaceship" })).status).toBe(400);
    expect((await patch(p.id, { containerMaterial: "cheese" })).status).toBe(400);
    expect((await patch(p.id, {})).status).toBe(400);
  });

  it("deleting hides the product, and it can be restored (Undo)", async () => {
    const { visitId, p } = await setup();
    await patch(p.id, { removed: true });
    expect((await getVisit(visitId)).products).toHaveLength(0);
    await patch(p.id, { removed: false });
    expect((await getVisit(visitId)).products).toHaveLength(1);
  });

  it("can't change anything after the report is sent", async () => {
    const { visitId, p } = await setup();
    await env.DB.prepare("UPDATE visits SET status = 'done' WHERE id = ?").bind(visitId).run();
    expect((await patch(p.id, { quantity: 9 })).status).toBe(400);
  });
});

describe("review before sending", () => {
  async function setup() {
    const visitId = (await createVisit()).json.visitId!;
    await insertProduct(productRow({ visit_id: visitId }));
    await insertProduct(productRow({ visit_id: visitId, product_name: "Mystery cleaner", sds_key: null, sds_status: "not_found" }));
    return visitId;
  }

  it("prepares the email draft and lists every attachment", async () => {
    const r = (await (await call(`/api/visits/${await setup()}/report`)).json()) as any;
    expect(r.to).toEqual([CLIENT]);
    expect(r.cc).toBe(TECH);
    expect(r.subject).toContain("Riverside Clinic");
    expect(r.attachments.map((a: any) => a.kind)).toEqual(["report", "spreadsheet", "sds"]);
    expect(r.missingSds).toEqual(["Mystery cleaner"]);
  });

  it("serves the report PDF to view, or to download", async () => {
    const id = await setup();
    const view = await call(`/api/visits/${id}/report.pdf`);
    expect(view.headers.get("Content-Type")).toBe("application/pdf");
    expect(view.headers.get("Content-Disposition")).toMatch(/^inline/);
    expect(new TextDecoder().decode((await view.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    const dl = await call(`/api/visits/${id}/report.pdf?download=1`);
    expect(dl.headers.get("Content-Disposition")).toMatch(/^attachment; filename="Inventory report - Riverside Clinic.pdf"/);
    await dl.arrayBuffer();
  });

  it("serves the spreadsheet with the marker Excel needs", async () => {
    const res = await call(`/api/visits/${await setup()}/inventory.csv`);
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toContain("Mystery cleaner");
  });

  it("saves the edited subject and message when sending", async () => {
    const id = await setup();
    const res = await call(`/api/visits/${id}/finish`, { method: "POST", ...json({ subject: "My subject", message: "Hi Sam" }) });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT email_subject, email_message, status FROM visits WHERE id = ?").bind(id)
      .first<{ email_subject: string; email_message: string; status: string }>();
    expect(row).toMatchObject({ email_subject: "My subject", email_message: "Hi Sam" });
    expect(["finishing", "done"]).toContain(row!.status);
  });

  it("can't be sent twice", async () => {
    const id = await setup();
    await call(`/api/visits/${id}/finish`, { method: "POST", ...json({}) });
    expect((await call(`/api/visits/${id}/finish`, { method: "POST", ...json({}) })).status).toBe(400);
  });
});

describe("files", () => {
  it("opens a stored file in the browser, or downloads it with a readable name", async () => {
    await env.FILES.put("sds/test.pdf", "%PDF-1.4 test", { httpMetadata: { contentType: "application/pdf" } });
    const view = await call("/api/files/sds/test.pdf");
    expect(view.headers.get("Content-Disposition")).toMatch(/^inline/);
    await view.arrayBuffer();
    const dl = await call("/api/files/sds/test.pdf?download=1&name=SDS%20-%20Septihol.pdf");
    expect(dl.headers.get("Content-Disposition")).toBe('attachment; filename="SDS - Septihol.pdf"');
    await dl.arrayBuffer();
  });

  it("says not found for a missing file", async () => {
    const res = await call("/api/files/nope.pdf");
    expect(res.status).toBe(404);
    await res.text();
  });
});
