import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSessionToken } from "../.test-dist/auth.js";
import { startHttpServer } from "../.test-dist/server-http.js";

let httpServer;
let baseUrl;
const testPort = 39218;

before(async () => {
  process.env.ALLOWED_DOMAIN = "eduengage.com";
  process.env.TOKEN_SECRET = "test-secret-key-with-at-least-16-chars";
  process.env.PORT = String(testPort);

  const mockServer = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  httpServer = startHttpServer(mockServer, { port: testPort });
  baseUrl = `http://127.0.0.1:${testPort}`;

  // Wait for server to start listening
  await new Promise((resolve) => {
    if (httpServer.listening) resolve(true);
    else httpServer.once("listening", resolve);
  });
});

after(async () => {
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test("GET /health returns 200 OK with domain and status", async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.domain, "eduengage.com");
  assert.ok(typeof data.uptimeSeconds === "number");
});

test("GET /auth returns 200 HTML login page", async () => {
  const res = await fetch(`${baseUrl}/auth`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await res.text();
  assert.match(html, /Clarity MCP Server/);
  assert.match(html, /eduengage\.com/);
});

test("GET /sse without credentials returns 401 Unauthorized", async () => {
  const res = await fetch(`${baseUrl}/sse`);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, "Unauthorized");
  assert.match(data.message, /@eduengage\.com/);
});

test("POST /messages without credentials returns 401 Unauthorized", async () => {
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
});

test("POST /messages with valid credentials but missing sessionId returns 400", async () => {
  const token = createSessionToken("employee@eduengage.com", "eduengage.com", 30);
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /sessionId/);
});

test("OPTIONS / preflight returns 204 with CORS headers", async () => {
  const res = await fetch(`${baseUrl}/sse`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers") || "", /Authorization/);
});

test("GET /auth/callback without code returns 403 HTML error page", async () => {
  const res = await fetch(`${baseUrl}/auth/callback`);
  assert.equal(res.status, 403);
  const html = await res.text();
  assert.match(html, /Authentication Failed/);
  assert.match(html, /Missing authorization code/);
});

test("Rapid connect and disconnect on /sse does not crash server", async () => {
  const token = createSessionToken("speedy@eduengage.com", "eduengage.com", 30);
  const controller = new AbortController();

  // Start connection and immediately abort
  const fetchPromise = fetch(`${baseUrl}/sse`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });

  // Abort immediately
  controller.abort();

  await assert.rejects(fetchPromise);

  // Verify server is still healthy and responsive
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
});

test("POST /messages rejects cross-session message submission with 403", async () => {
  // Create two different users
  const tokenAlice = createSessionToken("alice@eduengage.com", "eduengage.com", 30);
  const tokenBob = createSessionToken("bob@eduengage.com", "eduengage.com", 30);

  // Alice connects to SSE to establish a session
  const aliceController = new AbortController();
  const aliceRes = await fetch(`${baseUrl}/sse`, {
    headers: { Authorization: `Bearer ${tokenAlice}` },
    signal: aliceController.signal,
  });

  // Read first chunk to get the endpoint event with sessionId
  const reader = aliceRes.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  const match = text.match(/sessionId=([a-f0-9-]+)/);
  assert.ok(match, "Expected sessionId in SSE endpoint event");
  const aliceSessionId = match[1];

  // Bob tries to post to Alice's sessionId
  const bobPostRes = await fetch(`${baseUrl}/messages?sessionId=${aliceSessionId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenBob}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
  });

  assert.equal(bobPostRes.status, 403);
  const bobData = await bobPostRes.json();
  assert.match(bobData.error, /Forbidden/);

  // Clean up Alice's connection
  aliceController.abort();
});
