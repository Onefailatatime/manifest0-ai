// Tests run inside the Workers runtime (Cloudflare's Vitest plugin) with a fresh local D1 and R2 per test.
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // No real keys in tests: Muse is never called, and without a Resend key reports are saved to R2 instead of emailed.
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, MODEL_API_KEY: "test", RESEND_API_KEY: "", ADMIN_KEY: "test-admin-key-123" } },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
