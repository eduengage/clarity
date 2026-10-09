import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  getDefaultAccount,
  listAccounts,
  loadAccounts,
  resetAccountsCache,
  resolveToken,
} from "../.test-dist/accounts.js";

const originalEnv = { ...process.env };
const originalArgv = [...process.argv];
let tempDir;

beforeEach(() => {
  resetAccountsCache();
  delete process.env.CLARITY_API_TOKEN;
  delete process.env.ACCOUNTS_FILE;
  delete process.env.accounts_file;
  process.argv = ["node", "test"];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clarity-test-"));
});

afterEach(() => {
  resetAccountsCache();
  process.env = { ...originalEnv };
  process.argv = [...originalArgv];
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadAccounts loads accounts from valid accounts.json file", () => {
  const accountsFile = path.join(tempDir, "accounts.json");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify({
      default: "site1.com",
      accounts: {
        "site1.com": { token: "token-1" },
        "site2.com": { token: "token-2" },
      },
    }),
  );

  process.env.ACCOUNTS_FILE = accountsFile;

  const config = loadAccounts();
  assert.equal(config.default, "site1.com");
  assert.equal(Object.keys(config.accounts).length, 2);
  assert.equal(config.accounts["site1.com"]?.token, "token-1");
  assert.equal(config.accounts["site2.com"]?.token, "token-2");
});

test("loadAccounts falls back to CLARITY_API_TOKEN when no accounts file exists", () => {
  process.env.CLARITY_API_TOKEN = "env-token";

  const config = loadAccounts();
  assert.equal(config.default, "default");
  assert.equal(config.accounts["default"]?.token, "env-token");
  assert.deepEqual(listAccounts(), ["default"]);
});

test("loadAccounts handles invalid JSON without throwing", () => {
  const accountsFile = path.join(tempDir, "malformed.json");
  fs.writeFileSync(accountsFile, "{ invalid json content");

  process.env.ACCOUNTS_FILE = accountsFile;

  const config = loadAccounts();
  assert.deepEqual(config.accounts, {});
});

test("loadAccounts handles non-existent accounts-file without throwing", () => {
  process.env.ACCOUNTS_FILE = path.join(tempDir, "non-existent.json");

  const config = loadAccounts();
  assert.deepEqual(config.accounts, {});
});

test("parseAccountsFile skips accounts with empty or whitespace tokens", () => {
  const accountsFile = path.join(tempDir, "accounts.json");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify({
      default: "valid.com",
      accounts: {
        "empty.com": { token: "" },
        "whitespace.com": { token: "   " },
        "notoken.com": {},
        "valid.com": { token: "  valid-token  " },
      },
    }),
  );

  process.env.ACCOUNTS_FILE = accountsFile;

  const config = loadAccounts();
  assert.deepEqual(Object.keys(config.accounts), ["valid.com"]);
  assert.equal(config.accounts["valid.com"]?.token, "valid-token");
});

test("parseAccountsFile invalidates default account if it was skipped or missing", () => {
  const accountsFile = path.join(tempDir, "accounts.json");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify({
      default: "skipped.com",
      accounts: {
        "skipped.com": { token: "" },
        "valid.com": { token: "token-v" },
      },
    }),
  );

  process.env.ACCOUNTS_FILE = accountsFile;

  const config = loadAccounts();
  assert.equal(config.default, undefined);
  assert.equal(getDefaultAccount(), undefined);
});

test("resolveToken performs case-insensitive domain matching", () => {
  const accountsFile = path.join(tempDir, "accounts.json");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify({
      accounts: {
        "MySite.com": { token: "token-mysite" },
      },
    }),
  );

  process.env.ACCOUNTS_FILE = accountsFile;

  const resolved = resolveToken("mysite.com");
  assert.notEqual(resolved, null);
  assert.equal(resolved?.token, "token-mysite");
  assert.equal(resolved?.account, "MySite.com");
});

test("resolveToken auto-selects if only one account exists", () => {
  const accountsFile = path.join(tempDir, "accounts.json");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify({
      accounts: {
        "single.com": { token: "single-token" },
      },
    }),
  );

  process.env.ACCOUNTS_FILE = accountsFile;

  const resolved = resolveToken();
  assert.notEqual(resolved, null);
  assert.equal(resolved?.account, "single.com");
  assert.equal(resolved?.token, "single-token");
});

test("resolveToken returns null when multiple accounts exist and no default is set", () => {
  const accountsFile = path.join(tempDir, "accounts.json");
  fs.writeFileSync(
    accountsFile,
    JSON.stringify({
      accounts: {
        "site1.com": { token: "token1" },
        "site2.com": { token: "token2" },
      },
    }),
  );

  process.env.ACCOUNTS_FILE = accountsFile;

  const resolved = resolveToken();
  assert.equal(resolved, null);
});
