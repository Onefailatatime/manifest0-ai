// Tests run inside the Workers runtime (Cloudflare's Vitest plugin) with a fresh local D1 and R2 per test.
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // No real keys in tests: Muse is never called, and without a Resend key reports are saved to R2 and sign-in links are logged.
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, MODEL_API_KEY: "test", RESEND_API_KEY: "",
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123", ADMIN_EMAILS: "admin@example.com" } },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
