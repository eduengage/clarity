import {
  ANALYTICS_DASHBOARD_URL,
  DOCUMENTATION_URL,
  SESSION_RECORDINGS_URL
} from "./constants.js";
import {
  type FiltersType,
  type SortOptionsType,
  SortOptionsEnum
} from "./types.js";
import { getConfigValue, tryAsync } from "./utils.js";
import { resolveToken, listAccounts, getDefaultAccount } from "./accounts.js";

function resolveTokenOrError(account?: string): { token: string; account: string } {
  const resolved = resolveToken(account);
  if (resolved) return resolved;

  const accounts = listAccounts();
  if (accounts.length === 0) {
    const singleToken = getConfigValue("clarity_api_token")?.trim();
    if (singleToken) {
      return { token: singleToken, account: "default" };
    }

    throw new Error(
      "No Clarity accounts configured. Create ~/.clarity-mcp/accounts.json or pass --clarity_api_token."
    );
  }

  const trimmedAccount = account?.trim();
  if (!trimmedAccount) {
    throw new Error(
      `Multiple accounts configured but no account specified and no default set. ` +
      `Available accounts: ${accounts.join(", ")}. ` +
      `Specify one with the 'account' parameter or set "default" in accounts.json.`
    );
  }

  throw new Error(
    `Account "${account}" not found. Available accounts: ${accounts.join(", ")}`
  );
}

export async function queryAnalyticsDashboardAsync(
  query: string,
  timezone: string,
  account?: string,
): Promise<any> {
  const { token, account: resolvedAccount } = resolveTokenOrError(account);

  const result = await tryAsync(ANALYTICS_DASHBOARD_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: query,
      timezone: timezone,
    })
  });

  // Tag the response with which account was used
  if (result?.content?.[0]?.type === "text") {
    try {
      const data = JSON.parse(result.content[0].text);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        result.content[0].text = JSON.stringify({ _account: resolvedAccount, ...data }, null, 2);
      }
    } catch { /* leave as-is if not valid JSON */ }
  }

  return result;
}

export async function queryDocumentationAsync(query: string): Promise<any> {
  // Documentation doesn't need an account - it's global
  // But we still need a valid token to authenticate
  const accounts = listAccounts();
  let token: string | undefined;

  if (accounts.length > 0) {
    const defaultAcct = getDefaultAccount();
    const resolved = resolveToken(defaultAcct || accounts[0]);
    token = resolved?.token;
  }

  if (!token) {
    token = getConfigValue("clarity_api_token")?.trim();
  }

  if (!token) {
    return {
      content: [{
        type: "text",
        text: "No Clarity API token available. Configure at least one account or set CLARITY_API_TOKEN.",
      }],
    };
  }

  return await tryAsync(DOCUMENTATION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: query,
    })
  });
}

export async function listSessionRecordingsAsync(
  startDate: Date,
  endDate: Date,
  filters: FiltersType,
  sortBy: SortOptionsType,
  count: number,
  account?: string,
): Promise<any> {
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return {
      content: [{
        type: "text",
        text: "Invalid date provided. Start and end dates must be valid ISO 8601 timestamps.",
      }],
    };
  }

  const { token, account: resolvedAccount } = resolveTokenOrError(account);

  const sortValue = SortOptionsEnum[sortBy] ?? SortOptionsEnum.SessionStart_DESC;

  const result = await tryAsync(SESSION_RECORDINGS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      sortBy: sortValue,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      filters: filters,
      count: count
    })
  });

  // Tag the response
  if (result?.content?.[0]?.type === "text") {
    try {
      const data = JSON.parse(result.content[0].text);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        result.content[0].text = JSON.stringify({ _account: resolvedAccount, ...data }, null, 2);
      }
    } catch { /* leave as-is */ }
  }

  return result;
}

export function listConfiguredAccounts(): any {
  const accounts = listAccounts();
  const defaultAccount = getDefaultAccount();

  if (accounts.length === 0) {
    return {
      content: [{
        type: "text",
        text: "No Clarity accounts configured. Create ~/.clarity-mcp/accounts.json with your project domains and API tokens.",
      }],
    };
  }

  const accountList = accounts.map(domain => ({
    domain,
    isDefault: domain === defaultAccount,
  }));

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        accounts: accountList,
        total: accounts.length,
        default: defaultAccount || null,
        configHelp: accounts.length === 1 && !defaultAccount
          ? "Single account configured — it will be used automatically."
          : undefined,
      }, null, 2),
    }],
  };
}
