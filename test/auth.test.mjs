import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  authenticateRequest,
  createSessionToken,
  getAllowedDomain,
  getGoogleOAuthUrl,
  verifyGoogleIdToken,
  verifySessionToken,
} from "../.test-dist/auth.js";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.ALLOWED_DOMAIN = "eduengage.com";
  process.env.TOKEN_SECRET = "test-secret-key-with-at-least-16-chars";
});

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

test("getAllowedDomain defaults to eduengage.com", () => {
  delete process.env.ALLOWED_DOMAIN;
  assert.equal(getAllowedDomain(), "eduengage.com");
});

test("createSessionToken and verifySessionToken round-trip for valid eduengage.com user", () => {
  const token = createSessionToken("john@eduengage.com", "eduengage.com", 30);
  assert.ok(token.startsWith("eet_"));

  const user = verifySessionToken(token);
  assert.ok(user);
  assert.equal(user.email, "john@eduengage.com");
  assert.equal(user.domain, "eduengage.com");
  assert.equal(user.source, "session_token");
});

test("verifySessionToken rejects tokens for non-allowed domains", () => {
  const token = createSessionToken("stranger@otherdomain.com", "otherdomain.com", 30);
  const user = verifySessionToken(token);
  assert.equal(user, null);
});

test("verifySessionToken rejects tampered signatures", () => {
  const token = createSessionToken("john@eduengage.com", "eduengage.com", 30);
  const tampered = token.slice(0, -4) + "XXXX";
  assert.equal(verifySessionToken(tampered), null);
});

test("verifySessionToken rejects expired tokens", () => {
  // -1 days valid = expired
  const token = createSessionToken("john@eduengage.com", "eduengage.com", -1);
  assert.equal(verifySessionToken(token), null);
});

test("authenticateRequest recognizes valid session token", async () => {
  const token = createSessionToken("dev@eduengage.com", "eduengage.com", 30);
  const user = await authenticateRequest({
    authorization: `Bearer ${token}`,
  });
  assert.ok(user);
  assert.equal(user.email, "dev@eduengage.com");
});

test("authenticateRequest recognizes master agency key", async () => {
  process.env.EDUENGAGE_AGENCY_KEY = "super-secret-agency-key";
  const user = await authenticateRequest({
    authorization: "Bearer super-secret-agency-key",
  });
  assert.ok(user);
  assert.equal(user.email, "admin@eduengage.com");
  assert.equal(user.source, "admin_key");
});

test("authenticateRequest recognizes Cloudflare Access proxy header", async () => {
  const user = await authenticateRequest({
    "cf-access-authenticated-user-email": "sarah@eduengage.com",
  });
  assert.ok(user);
  assert.equal(user.email, "sarah@eduengage.com");
  assert.equal(user.source, "proxy_header");
});

test("authenticateRequest rejects unauthorized proxy header domain", async () => {
  const user = await authenticateRequest({
    "cf-access-authenticated-user-email": "intruder@gmail.com",
  });
  assert.equal(user, null);
});

test("authenticateRequest returns null when no credentials provided", async () => {
  const user = await authenticateRequest({});
  assert.equal(user, null);
});

test("getGoogleOAuthUrl includes required domain restriction parameters", () => {
  process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  const authUrl = getGoogleOAuthUrl("https://clarity.eduengage.com");
  assert.ok(authUrl);
  assert.match(authUrl, /accounts\.google\.com/);
  assert.match(authUrl, /test-client-id/);
  assert.match(authUrl, /hd=eduengage\.com/);
  assert.match(authUrl, /redirect_uri=https%3A%2F%2Fclarity\.eduengage\.com%2Fauth%2Fcallback/);
});

test("verifyGoogleIdToken verifies hosted domain and verified email", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      email: "engineer@eduengage.com",
      email_verified: "true",
      hd: "eduengage.com",
      name: "EduEngage Engineer",
    }),
  });

  const user = await verifyGoogleIdToken("fake-jwt-token");
  assert.ok(user);
  assert.equal(user.email, "engineer@eduengage.com");
  assert.equal(user.domain, "eduengage.com");
  assert.equal(user.source, "google_id_token");
});

test("verifyGoogleIdToken rejects foreign Google account", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      email: "random@gmail.com",
      email_verified: "true",
      hd: undefined,
    }),
  });

  const user = await verifyGoogleIdToken("fake-jwt-token");
  assert.equal(user, null);
});
