-- Real sign-in (Better Auth, src/auth.ts): a link is emailed to the technician, no passwords.
-- Tables and columns are Better Auth's own (camelCase), generated from its schema for SQLite.
-- user.role = 'admin' opens /admin/; company is shown on reports.
CREATE TABLE "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null,
  "image" text, "createdAt" date not null, "updatedAt" date not null, "role" text, "company" text);
CREATE TABLE "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null,
  "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);
CREATE TABLE "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null,
  "createdAt" date not null, "updatedAt" date not null);
CREATE TABLE "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);
CREATE INDEX "session_userId_idx" ON "session" ("userId");
CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

-- Who owns a visit. Visits made before sign-in existed are linked by user_email the first time that person signs in.
ALTER TABLE visits ADD COLUMN user_id TEXT REFERENCES "user" ("id");
CREATE INDEX visits_user ON visits(user_id);

-- Only approved applicants can sign in. Set by the Approve button on /admin/ (unix ms).
ALTER TABLE beta_applications ADD COLUMN approved_at INTEGER;
