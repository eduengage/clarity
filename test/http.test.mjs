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
