// Sign-in (Better Auth). The technician enters their email and gets a link; no passwords.
//   /api/auth/*  Better Auth's own endpoints: POST /sign-in/magic-link, GET /magic-link/verify, GET /get-session,
//                POST /sign-out, POST /update-user (name, company).
// Only approved beta applicants (beta_applications.approved_at), existing users and ADMIN_EMAILS can sign in.
// Tables: migrations/0008_auth.sql. Secrets: BETTER_AUTH_SECRET, ADMIN_EMAILS (comma-separated, become admins).
// Admins only get /admin/ (applications, Approve). Walks stay private to whoever made them, admins included.
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { sendEmail } from "./email";

const ROOT = "manifest0ai.com";
const APP = `https://app.${ROOT}`;

export type AppUser = { id: string; email: string; name: string; company?: string | null; role?: string | null };

export const isAdmin = (user: AppUser) => user.role === "admin";

/** One per request: the base URL and cookie domain depend on the host. */
export function createAuth(env: Env, request: Request) {
  const url = new URL(request.url);
  // On manifest0ai.com, sign-in links always go to the app, and the cookie works on every subdomain (the app and /admin/).
  // Locally, wrangler dev keeps localhost as the host (dev.host in wrangler.jsonc).
  const live = url.hostname === ROOT || url.hostname.endsWith(`.${ROOT}`);
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: live ? APP : url.origin,
    basePath: "/api/auth",
    trustedOrigins: live ? [APP, `https://${ROOT}`, `https://www.${ROOT}`] : [url.origin],
    user: {
      additionalFields: {
        role: { type: "string", required: false, input: false },
        company: { type: "string", required: false },
      },
    },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: true, storage: "database" },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      ...(live && { crossSubDomainCookies: { enabled: true, domain: ROOT } }),
    },
    plugins: [
      magicLink({
        expiresIn: 15 * 60,
        // Unknown emails get the same "check your inbox" answer, but no email.
        sendMagicLink: async ({ email, url }) => {
          const known = await env.DB.prepare(`SELECT 1 FROM "user" WHERE email = ?`).bind(email.toLowerCase()).first();
          if (known || (await access(env, email))) await sendLink(env, email, url);
        },
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const ok = await access(env, user.email);
            if (!ok) throw new APIError("FORBIDDEN", { code: "NOT_APPROVED", message: "This email isn't approved for the beta yet." });
            return { data: { ...user, name: user.name || ok.name || "", company: ok.company, role: ok.admin ? "admin" : "user" } };
          },
          // Walks made before sign-in existed belong to whoever used this email.
          after: async (user) => {
            await env.DB.prepare("UPDATE visits SET user_id = ? WHERE user_email = ? AND user_id IS NULL").bind(user.id, user.email).run();
          },
        },
      },
    },
  });
}

/** The signed-in user, or null. */
export async function signedInUser(env: Env, request: Request): Promise<AppUser | null> {
  const session = await createAuth(env, request).api.getSession({ headers: request.headers });
  return (session?.user as AppUser | undefined) ?? null;
}

/** Can this email get an account? Admins always; others once their beta application is approved. */
async function access(env: Env, email: string) {
  email = email.trim().toLowerCase();
  const admins = (env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const app = await env.DB.prepare("SELECT name, company FROM beta_applications WHERE email = ? AND approved_at IS NOT NULL")
    .bind(email).first<{ name: string | null; company: string }>();
  if (admins.includes(email)) return { admin: true, name: app?.name ?? null, company: app?.company ?? null };
  return app ? { admin: false, name: app.name, company: app.company } : null;
}

function sendLink(env: Env, email: string, url: string) {
  return sendEmail(env, email, {
    subject: "Sign in to Manifest0 AI",
    lines: ["Tap to sign in to Manifest0 AI. The link works once, for 15 minutes."],
    button: { label: "Sign in", url },
    footer: "Didn't ask for this? You can ignore this email.",
  });
}
