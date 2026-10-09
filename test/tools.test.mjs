import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { resetAccountsCache } from "../.test-dist/accounts.js";
import {
  listConfiguredAccounts,
  listSessionRecordingsAsync,
  queryAnalyticsDashboardAsync,
  queryDocumentationAsync,
} from "../.test-dist/tools.js";

const originalEnv = { ...process.env };
const originalArgv = [...process.argv];
const originalFetch = globalThis.fetch;
let tempDir;

beforeEach(() => {
  resetAccountsCache();
  delete process.env.CLARITY_API_TOKEN;
  delete process.env.ACCOUNTS_FILE;
  delete process.env.accounts_file;
  process.argv = ["node", "test"];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clarity-tools-test-"));
});

afterEach(() => {
  resetAccountsCache();
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  process.argv = [...originalArgv];
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("queryDocumentationAsync works when no accounts.json is configured but CLARITY_API_TOKEN is set via env", async () => {
  process.env.CLARITY_API_TOKEN = "env-secret-token";

  let capturedAuth;
  let capturedBody;
  globalThis.fetch = async (url, init) => {
    capturedAuth = init?.headers?.Authorization;
    capturedBody = JSON.parse(init?.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ docs: ["result"] }),
    };
  };

  const result = await queryDocumentationAsync("how to setup");
  assert.equal(capturedAuth, "Bearer env-secret-token");
  assert.equal(capturedBody?.query, "how to setup");
  assert.equal(result.content[0].text, '{\n  "docs": [\n    "result"\n  ]\n}');
});

test("queryDocumentationAsync works when accounts file has invalid JSON but CLARITY_API_TOKEN is set via env", async () => {
  const accountsFile = path.join(tempDir, "broken.json");
  fs.writeFileSync(accountsFile, "{ invalid json");
  process.env.ACCOUNTS_FILE = accountsFile;
  process.env.CLARITY_API_TOKEN = "env-fallback-token";

  let capturedAuth;
  globalThis.fetch = async (url, init) => {
    capturedAuth = init?.headers?.Authorization;
    return {
      ok: true,
      status: 200,
      json: async () => ({ docs: ["ok"] }),
    };
  };

  const result = await queryDocumentationAsync("query");
  assert.equal(capturedAuth, "Bearer env-fallback-token");
  assert.equal(result.content[0].text, '{\n  "docs": [\n    "ok"\n  ]\n}');
});

test("queryDocumentationAsync returns helpful error when no token is available", async () => {
  const result = await queryDocumentationAsync("search query");
  assert.match(result.content[0].text, /No Clarity API token available/);
});

test("queryAnalyticsDashboardAsync tags successful response with _account", async () => {
  process.env.CLARITY_API_TOKEN = "env-token";

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ sessions: 100 }),
  });

  const result = await queryAnalyticsDashboardAsync("sessions count", "UTC");
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed._account, "default");
  assert.equal(parsed.sessions, 100);
});

test("queryAnalyticsDashboardAsync throws informative error when account not found", async () => {
  const accountsFile = path.join(tempDir, "accounts.json");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify({
      accounts: {
        "mysite.com": { token: "token123" },
      },
    }),
  );
  process.env.ACCOUNTS_FILE = accountsFile;

  await assert.rejects(
    async () => {
      await queryAnalyticsDashboardAsync("query", "UTC", "unknown.com");
    },
    /Account "unknown.com" not found/,
  );
});

test("listSessionRecordingsAsync safely handles invalid dates without RangeError", async () => {
  process.env.CLARITY_API_TOKEN = "token";

  const invalidDate = new Date("invalid date string");
  const validDate = new Date();

  const result = await listSessionRecordingsAsync(
    invalidDate,
    validDate,
    {},
    "SessionStart_DESC",
    10,
  );

  assert.match(result.content[0].text, /Invalid date provided/);
});

test("listConfiguredAccounts returns empty message when no accounts exist", () => {
  const result = listConfiguredAccounts();
  assert.match(result.content[0].text, /No Clarity accounts configured/);
});

test("listConfiguredAccounts returns accounts list with default marker", () => {
  const accountsFile = path.join(tempDir, "accounts.json");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify({
      default: "site1.com",
      accounts: {
        "site1.com": { token: "t1" },
        "site2.com": { token: "t2" },
      },
    }),
  );
  process.env.ACCOUNTS_FILE = accountsFile;

  const result = listConfiguredAccounts();
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.total, 2);
  assert.equal(parsed.default, "site1.com");
  assert.deepEqual(parsed.accounts, [
    { domain: "site1.com", isDefault: true },
    { domain: "site2.com", isDefault: false },
  ]);
});
