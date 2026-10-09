import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import pkg from "../package.json" with { type: "json" };

import {
  ANALYTICS_DASHBOARD_DESCRIPTION,
  ANALYTICS_DASHBOARD_TOOL,
  DOCUMENTATION_DESCRIPTION,
  DOCUMENTATION_TOOL,
  LIST_ACCOUNTS_DESCRIPTION,
  LIST_ACCOUNTS_TOOL,
  SESSION_RECORDINGS_DESCRIPTION,
  SESSION_RECORDINGS_TOOL
} from "./constants.js";
import {
  SYSTEM_INSTRUCTIONS_PROMPT
} from "./instructions.js";
import {
  listConfiguredAccounts,
  listSessionRecordingsAsync,
  queryAnalyticsDashboardAsync,
  queryDocumentationAsync
} from "./tools.js";
import {
  ListRequest,
  SearchRequest,
} from "./types.js";
import { loadAccounts } from "./accounts.js";

// Account parameter — added to data-fetching tools
const AccountParam = z.string().optional().describe(
  "The domain name of the Clarity project/account to query (e.g., 'crowntrophy.com', 'zenworkflow.app'). " +
  "Use the list-clarity-accounts tool to see available accounts. " +
  "If omitted, the default account is used."
);

// Create server instance
const server = new McpServer(
  {
    name: pkg.name,
    version: pkg.version,
  },
  {
    instructions: SYSTEM_INSTRUCTIONS_PROMPT,
    capabilities: {
      resources: {},
      tools: {}
    },
  }
);

// Register the list-accounts tool
server.tool(
  LIST_ACCOUNTS_TOOL,
  LIST_ACCOUNTS_DESCRIPTION,
  {},
  {
    title: "List Clarity Accounts",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  },
  async () => {
    return listConfiguredAccounts();
  }
);

// Register the query-analytics-dashboard tool
server.tool(
  ANALYTICS_DASHBOARD_TOOL,
  ANALYTICS_DASHBOARD_DESCRIPTION,
  {
    ...SearchRequest,
    account: AccountParam,
  },
  {
    title: "Query Analytics Dashboard",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  },
  async ({ query, account }) => {
    return await queryAnalyticsDashboardAsync(query, Intl.DateTimeFormat().resolvedOptions().timeZone, account);
  }
);

// Register the session-recordings tool
server.tool(
  SESSION_RECORDINGS_TOOL,
  SESSION_RECORDINGS_DESCRIPTION,
  {
    ...ListRequest,
    account: AccountParam,
  },
  {
    title: "List Session Recordings",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  },
  async ({ filters, sortBy, count, account }) => {
    const now = new Date();
    const endDate = filters?.date?.end ? new Date(filters.date.end) : now;
    let startDate: Date;

    if (filters?.date?.start) {
      startDate = new Date(filters.date.start);
    } else {
      startDate = new Date(endDate.getTime());
      startDate.setDate(endDate.getDate() - 2);
    }

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return {
        content: [{
          type: "text",
          text: "Invalid date provided. Start and end dates must be valid ISO 8601 timestamps.",
        }],
      };
    }

    return await listSessionRecordingsAsync(startDate, endDate, filters, sortBy, count, account);
  }
);

// Register the query-documentation-resources tool
server.tool(
  DOCUMENTATION_TOOL,
  DOCUMENTATION_DESCRIPTION,
  SearchRequest,
  {
    title: "Query Documentation Resources",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  },
  async ({ query }) => {
    return await queryDocumentationAsync(query);
  }
);

import { startHttpServer } from "./server-http.js";
import { getConfigValue } from "./utils.js";

// Main function
async function main() {
  const config = loadAccounts();
  const accountCount = Object.keys(config.accounts).length;

  if (accountCount > 0) {
    console.error(`Loaded ${accountCount} Clarity account(s): ${Object.keys(config.accounts).join(", ")}`);
    if (config.default) {
      console.error(`Default account: ${config.default}`);
    }
  } else {
    console.error("No Clarity accounts configured. Use ACCOUNTS_CONFIG_JSON, ~/.clarity-mcp/accounts.json or --clarity_api_token");
  }

  const transportMode = process.env.TRANSPORT || getConfigValue("transport");
  const isHttpMode =
    transportMode === "http" ||
    transportMode === "sse" ||
    Boolean(process.env.PORT) ||
    Boolean(getConfigValue("port"));

  if (isHttpMode) {
    startHttpServer(server);
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Clarity MCP Server running on stdio...");
  }
}

// Handle graceful termination in Docker containers (PID 1) and CLI
const shutdown = () => {
  console.error("Shutting down Clarity MCP Server...");
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Prevent unhandled EPIPE errors when stdio pipe closes
process.stdout.on("error", (err: any) => {
  if (err?.code === "EPIPE") {
    process.exit(0);
  }
});

// Run the server
main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
