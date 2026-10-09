import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getConfigValue } from "./utils.js";

export interface AccountEntry {
  token: string;
}

export interface AccountsConfig {
  default?: string;
  accounts: Record<string, AccountEntry>;
}

const CONFIG_PATHS = [
  path.join(os.homedir(), ".clarity-mcp", "accounts.json"),
  path.join(os.homedir(), ".config", "clarity-mcp", "accounts.json"),
];

let _cached: AccountsConfig | null = null;

/**
 * Reset cached accounts configuration (useful for testing).
 */
export function resetAccountsCache(): void {
  _cached = null;
}

/**
 * Load accounts from config file, CLI args, or env vars.
 * Priority:
 *   1. --accounts-file=/path/to/accounts.json
 *   2. ~/.clarity-mcp/accounts.json or ~/.config/clarity-mcp/accounts.json
 *   3. Single token via --clarity_api_token or CLARITY_API_TOKEN (legacy compat)
 */
export function loadAccounts(): AccountsConfig {
  if (_cached) return _cached;

  // 1. Check for ACCOUNTS_CONFIG_JSON environment variable or argument
  const envJson = process.env.ACCOUNTS_CONFIG_JSON || getConfigValue("accounts_config_json") || getConfigValue("accounts_json");
  if (envJson && envJson.trim().length > 0) {
    const parsed = parseAccountsJson(envJson, "ACCOUNTS_CONFIG_JSON environment variable");
    if (Object.keys(parsed.accounts).length > 0) {
      _cached = parsed;
      return _cached;
    }
  }

  // 2. Check for explicit accounts file path
  const explicitPath = getConfigValue("accounts_file") || getConfigValue("accounts-file");
  if (explicitPath) {
    if (fs.existsSync(explicitPath)) {
      _cached = parseAccountsFile(explicitPath);
      return _cached;
    }
    console.error(`Specified accounts file not found: ${explicitPath}`);
    _cached = { accounts: {} };
    return _cached;
  }

  // 3. Check default config paths
  for (const configPath of CONFIG_PATHS) {
    if (fs.existsSync(configPath)) {
      const parsed = parseAccountsFile(configPath);
      if (Object.keys(parsed.accounts).length > 0) {
        _cached = parsed;
        return _cached;
      }
    }
  }

  // Fallback: single token from CLI/env (backward compatible)
  const singleToken = getConfigValue("clarity_api_token")?.trim();
  if (singleToken) {
    _cached = {
      default: "default",
      accounts: {
        default: { token: singleToken },
      },
    };
    return _cached;
  }

  // No config at all
  _cached = { accounts: {} };
  return _cached;
}

function parseAccountsFile(filePath: string): AccountsConfig {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return parseAccountsJson(raw, filePath);
  } catch (err) {
    console.error(`Failed to read accounts config at ${filePath}:`, err);
    return { accounts: {} };
  }
}

export function parseAccountsJson(raw: string, sourceName = "json string"): AccountsConfig {
  try {
    const parsed = JSON.parse(raw);

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !parsed.accounts ||
      typeof parsed.accounts !== "object" ||
      Array.isArray(parsed.accounts)
    ) {
      console.error(`Invalid accounts config: missing or invalid "accounts" object in ${sourceName}`);
      return { accounts: {} };
    }

    // Validate each entry has a non-empty token
    const accounts: Record<string, AccountEntry> = {};
    for (const [domain, entry] of Object.entries(parsed.accounts)) {
      const cleanDomain = domain.trim();
      if (!cleanDomain) {
        console.error(`Skipping account with empty domain name in ${sourceName}`);
        continue;
      }
      const e = entry as any;
      if (typeof e?.token === "string" && e.token.trim().length > 0) {
        accounts[cleanDomain] = { token: e.token.trim() };
      } else {
        console.error(`Skipping account "${domain}": missing or empty token`);
      }
    }

    // Validate default account points to an existing account
    let defaultAccount: string | undefined;
    if (typeof parsed.default === "string" && parsed.default.trim().length > 0) {
      const cleanDefault = parsed.default.trim();
      if (accounts[cleanDefault]) {
        defaultAccount = cleanDefault;
      } else {
        const lower = cleanDefault.toLowerCase();
        const matched = Object.keys(accounts).find((d) => d.toLowerCase() === lower);
        if (matched) {
          defaultAccount = matched;
        } else {
          console.error(`Default account "${parsed.default}" not found in configured accounts.`);
        }
      }
    }

    return {
      default: defaultAccount,
      accounts,
    };
  } catch (err) {
    console.error(`Failed to parse accounts config at ${sourceName}:`, err);
    return { accounts: {} };
  }
}

/**
 * Resolve the API token for a given account identifier (domain).
 * Falls back to default account if no account specified.
 */
export function resolveToken(account?: string): { token: string; account: string } | null {
  const config = loadAccounts();
  const domains = Object.keys(config.accounts);

  if (domains.length === 0) return null;

  const trimmedAccount = account?.trim();

  // If account specified, look it up directly
  if (trimmedAccount) {
    const entry = config.accounts[trimmedAccount];
    if (entry) return { token: entry.token, account: trimmedAccount };

    // Try case-insensitive match
    const lower = trimmedAccount.toLowerCase();
    for (const [domain, entry] of Object.entries(config.accounts)) {
      if (domain.toLowerCase() === lower) {
        return { token: entry.token, account: domain };
      }
    }

    return null; // Not found
  }

  // No account specified — use default
  if (config.default && config.accounts[config.default]) {
    return { token: config.accounts[config.default]!.token, account: config.default };
  }

  // If only one account, use it
  if (domains.length === 1) {
    const domain = domains[0]!;
    return { token: config.accounts[domain]!.token, account: domain };
  }

  // Multiple accounts, no default set, no account specified
  return null;
}

/**
 * List all configured account domains.
 */
export function listAccounts(): string[] {
  const config = loadAccounts();
  return Object.keys(config.accounts);
}

/**
 * Get the default account domain, if set.
 */
export function getDefaultAccount(): string | undefined {
  return loadAccounts().default;
}
