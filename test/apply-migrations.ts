// Every test starts from an empty database with all migrations applied.
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);

beforeEach(async () => {
  await env.DB.batch(["photos", "products", "visits", "sds_library", "beta_applications", "landing_events",
    "session", "account", "verification", "rateLimit", "user"].map((t) => env.DB.prepare(`DELETE FROM "${t}"`)));
});
