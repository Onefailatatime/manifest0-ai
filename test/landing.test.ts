// Landing page API: apply form, ?src=card tracking, admin for signed-in admins, approving applicants, old links.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ADMIN, TECH, as, openLink, requestLink, signIn } from "./helpers";

const url = (path: string) => `https://app.test${path}`;
const post = (path: string, body: unknown) =>
  SELF.fetch(url(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const admin = async () => as(await signIn(ADMIN, { approved: false }))("/api/landing/admin");
// The page sends only work email, company and the source tag.
const application = { company: "Example Waste Co", email: "Sam@Example.com", source: "card" };

describe("landing page", () => {
  it("saves an application once and counts it as from the card", async () => {
    expect(await (await post("/api/landing/apply", application)).json()).toEqual({ ok: true });
    expect(await (await post("/api/landing/apply", application)).json()).toEqual({ ok: true, duplicate: true });
    await post("/api/landing/visit", { source: "card" });
    const out = (await (await admin()).json()) as any;
    expect(out.totals).toMatchObject({ applications: 1, from_card_applications: 1, from_card_visits: 1 });
    expect(out.applications[0].email).toBe("sam@example.com");
  });

  it("records ?src=email applications", async () => {
    await post("/api/landing/apply", { company: "Mail Co", email: "pat@example.com", source: "email" });
    const out = (await (await admin()).json()) as any;
    expect(out.totals).toMatchObject({ applications: 1, from_card_applications: 0, from_email_applications: 1 });
    expect(out.applications[0]).toMatchObject({ source: "email", from_email: true, name: null, state: null });
  });

  it("emails a confirmation once, not for a duplicate application", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await post("/api/landing/apply", application);
    await post("/api/landing/apply", application);
    const sent = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("Email to sam@example.com: You're on the Manifest0 AI beta list"));
    log.mockRestore();
    expect(sent).toHaveLength(1);
  });

  it("rejects a bad application with field errors", async () => {
    const res = await post("/api/landing/apply", { email: "nope", company: "" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).errors).toMatchObject({ email: expect.any(String), company: expect.any(String) });
    const bad = await post("/api/landing/apply", { ...application, state: "XX" });
    expect(((await bad.json()) as any).errors).toHaveProperty("state");
  });

  it("keeps admin for signed-in admins only", async () => {
    expect((await SELF.fetch(url("/api/landing/admin"))).status).toBe(401);
    expect((await SELF.fetch(url("/api/landing/admin.csv"))).status).toBe(401);
    const tech = as(await signIn(TECH));
    expect((await tech("/api/landing/admin")).status).toBe(401);
    expect((await tech("/api/landing/approve", { method: "POST", body: JSON.stringify({ email: TECH }) })).status).toBe(401);
  });

  it("approving an applicant lets them sign in, with their company on the account", async () => {
    await post("/api/landing/apply", application);
    expect(await requestLink("sam@example.com")).toBeUndefined();     // not approved yet: no link
    const boss = as(await signIn(ADMIN, { approved: false }));
    const res = await boss("/api/landing/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "sam@example.com" }) });
    expect(await res.json()).toEqual({ ok: true });
    expect(((await (await admin()).json()) as any).applications[0].approved).toBe(true);

    const sam = as(await openLink((await requestLink("sam@example.com"))!));
    const { user } = (await (await sam("/api/auth/get-session")).json()) as any;
    expect(user).toMatchObject({ email: "sam@example.com", company: "Example Waste Co", role: "user" });
    const row = await env.DB.prepare("SELECT approved_at FROM beta_applications WHERE email = ?").bind("sam@example.com").first();
    expect(row?.approved_at).toBeTruthy();
  });

  it("serves the app on app.manifest0ai.com/ and the landing page on manifest0ai.com/", async () => {
    const app = await (await SELF.fetch("https://app.manifest0ai.com/?visit=abc")).text();
    expect(app).toContain('id="signinForm"');
    const home = await (await SELF.fetch("https://manifest0ai.com/")).text();
    expect(home).toContain('id="apply-form"');
    expect(home).not.toContain('id="signinForm"');
  });

  it("answers byte ranges for the video (iPhone Safari needs them)", async () => {
    const video = (range?: string) => SELF.fetch("https://manifest0ai.com/img/app-walkthrough.mp4", range ? { headers: { Range: range } } : {});
    const whole = await video();
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Accept-Ranges")).toBe("bytes");
    const size = (await whole.arrayBuffer()).byteLength;

    const probe = await video("bytes=0-1");                     // Safari's first request
    expect(probe.status).toBe(206);
    expect(probe.headers.get("Content-Range")).toBe(`bytes 0-1/${size}`);
    expect((await probe.arrayBuffer()).byteLength).toBe(2);

    const middle = await video("bytes=100-199");
    expect(middle.headers.get("Content-Range")).toBe(`bytes 100-199/${size}`);
    expect((await middle.arrayBuffer()).byteLength).toBe(100);

    const tail = await video(`bytes=${size - 10}-`);
    expect(tail.headers.get("Content-Range")).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
    await tail.arrayBuffer();

    const past = await video(`bytes=${size}-`);
    expect(past.status).toBe(416);
    expect(past.headers.get("Content-Range")).toBe(`bytes */${size}`);
  });

  it("redirects /join and /beta to the home page, keeping the query", async () => {
    for (const path of ["/join?src=card", "/beta?src=card"]) {
      const res = await SELF.fetch(url(path), { redirect: "manual" });
      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe("https://app.test/?src=card");
    }
  });
});
