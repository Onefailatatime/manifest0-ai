// Sign-in and who can see what: only approved applicants get in, and technicians only reach their own walks.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN, TECH, approve, as, createVisit, insertProduct, openLink, productRow, requestLink, signIn } from "./helpers";

const OTHER = "other@example.com";

describe("signing in", () => {
  it("emails a link to approved applicants and the link signs them in", async () => {
    const tech = as(await signIn(TECH));
    const { user } = (await (await tech("/api/auth/get-session")).json()) as any;
    expect(user).toMatchObject({ email: TECH, name: "Tamara", company: "Acme Environmental", role: "user" });
  });

  it("sends nothing to an email that isn't approved, but answers the same", async () => {
    expect(await requestLink("stranger@example.com")).toBeUndefined();
  });

  it("refuses the account if approval was taken back before the link is opened", async () => {
    await approve(OTHER);
    const link = (await requestLink(OTHER))!;
    await env.DB.prepare("UPDATE beta_applications SET approved_at = NULL WHERE email = ?").bind(OTHER).run();
    const res = await SELF.fetch(link, { redirect: "manual" });
    expect(res.headers.get("Location")).toContain("error=NOT_APPROVED");
    expect(await env.DB.prepare(`SELECT 1 FROM "user" WHERE email = ?`).bind(OTHER).first()).toBeNull();
  });

  it("a link works only once", async () => {
    await signIn(TECH);
    const link = (await requestLink(TECH))!;
    expect(await openLink(link)).toContain("session_token");
    expect(await openLink(link)).toBe("");
  });

  it("ADMIN_EMAILS can sign in without applying, as admins", async () => {
    const admin = as(await signIn(ADMIN, { approved: false }));
    expect(((await (await admin("/api/auth/get-session")).json()) as any).user.role).toBe("admin");
  });

  it("can't make yourself an admin", async () => {
    const tech = as(await signIn(TECH));
    await tech("/api/auth/update-user", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "admin" }) });
    expect(((await (await tech("/api/auth/get-session")).json()) as any).user.role).toBe("user");
  });

  it("links walks made before sign-in existed to the technician who made them", async () => {
    await env.DB.prepare("INSERT INTO visits (id, user_email, client_email, recipients, site_name) VALUES (?, ?, ?, ?, ?)")
      .bind("old-walk", TECH, "client@example.com", JSON.stringify([TECH, "client@example.com"]), "Old site").run();
    const tech = as(await signIn(TECH));
    const { visits } = (await (await tech("/api/visits")).json()) as any;
    expect(visits.map((v: any) => v.id)).toEqual(["old-walk"]);
  });
});

describe("who can see what", () => {
  async function setup() {
    const tech = as(await signIn(TECH));
    const other = as(await signIn(OTHER));
    const visitId = (await createVisit(tech)).json.visitId!;
    const p = productRow({ visit_id: visitId });
    await insertProduct(p);
    await env.FILES.put(`visits/${visitId}/photos/a.jpg`, "jpg", { httpMetadata: { contentType: "image/jpeg" } });
    return { tech, other, visitId, p };
  }

  it("needs sign-in for the app's API", async () => {
    for (const path of ["/api/visits", "/api/visits/x", "/api/visits/x/report.pdf", "/api/files/visits/x/photos/a.jpg"]) {
      const res = await SELF.fetch(`https://app.test${path}`);
      expect(res.status, path).toBe(401);
      await res.arrayBuffer();
    }
  });

  it("someone else's walk doesn't exist for you", async () => {
    const { other, visitId, p } = await setup();
    for (const path of ["", "/report", "/report.pdf", "/inventory.csv"]) {
      const res = await other(`/api/visits/${visitId}${path}`);
      expect(res.status, path).toBe(404);
      await res.arrayBuffer();
    }
    expect((await other(`/api/visits/${visitId}/finish`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await other(`/api/products/${p.id}`, { method: "PATCH", body: JSON.stringify({ quantity: 9 }) })).status).toBe(404);
    const photo = await other(`/api/files/visits/${visitId}/photos/a.jpg`);
    expect(photo.status).toBe(404);
    await photo.arrayBuffer();
  });

  it("your own walk's photos open for you", async () => {
    const { tech, visitId } = await setup();
    const photo = await tech(`/api/files/visits/${visitId}/photos/a.jpg`);
    expect(photo.status).toBe(200);
    await photo.arrayBuffer();
  });

  it("admins can't open technicians' walks either", async () => {
    const { visitId } = await setup();
    const admin = as(await signIn(ADMIN, { approved: false }));
    const res = await admin(`/api/visits/${visitId}`);
    expect(res.status).toBe(404);
    await res.arrayBuffer();
  });

  it("SDS PDFs stay public: the client's report email links to them", async () => {
    await env.FILES.put("sds/test.pdf", "%PDF-1.4 test", { httpMetadata: { contentType: "application/pdf" } });
    const res = await SELF.fetch("https://app.test/api/files/sds/test.pdf");
    expect(res.status).toBe(200);
    await res.text();
  });

  it("a signed-out session can't be used again", async () => {
    const cookie = await signIn(TECH);
    await as(cookie)("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect((await as(cookie)("/api/visits")).status).toBe(401);
  });
});
