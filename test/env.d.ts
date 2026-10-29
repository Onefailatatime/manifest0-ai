// Test-only bindings (see vitest.config.mts).
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS?: import("cloudflare:test").D1Migration[];
  }
}
