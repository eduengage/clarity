import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import pkg from "../package.json" with { type: "json" };
import {
  authenticateRequest,
  getAllowedDomain,
  getGoogleOAuthUrl,
  handleGoogleOAuthCallback,
} from "./auth.js";
import { loadAccounts } from "./accounts.js";
import { getConfigValue } from "./utils.js";

export interface HttpServerOptions {
  port?: number;
  serverBaseUrl?: string;
}

interface SseSession {
  transport: SSEServerTransport;
  userEmail: string;
  isAdmin: boolean;
}

export function startHttpServer(server: McpServer, options: HttpServerOptions = {}): http.Server {
  const port = options.port || Number(process.env.PORT) || Number(getConfigValue("port", "3000")) || 3000;
  const serverBaseUrl =
    options.serverBaseUrl ||
    process.env.SERVER_BASE_URL ||
    getConfigValue("server_base_url", `http://localhost:${port}`) ||
    `http://localhost:${port}`;

  // Track active SSE transports by sessionId with ownership metadata
  const transports = new Map<string, SseSession>();

  const httpServer = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    const pathname = requestUrl.pathname;
    const method = req.method?.toUpperCase() || "GET";

    // Set standard CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Cf-Access-Authenticated-User-Email");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check endpoint
    if (pathname === "/health" || pathname === "/status") {
      const config = loadAccounts();
      const accountsList = Object.keys(config.accounts);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            status: "ok",
            name: pkg.name,
            version: pkg.version,
            domain: getAllowedDomain(),
            accountsCount: accountsList.length,
            accounts: accountsList,
            uptimeSeconds: Math.floor(process.uptime()),
          },
          null,
          2
        )
      );
      return;
    }

    // Auth portal: /auth or /login
    if (pathname === "/auth" || pathname === "/login") {
      renderLoginPage(res, serverBaseUrl);
      return;
    }

    // OAuth callback: /auth/callback
    if (pathname === "/auth/callback") {
      const code = requestUrl.searchParams.get("code");
      if (!code) {
        renderErrorPage(res, "Missing authorization code from Google sign-in.");
        return;
      }

      const result = await handleGoogleOAuthCallback(code, serverBaseUrl);
      if ("error" in result) {
        renderErrorPage(res, result.error);
        return;
      }

      renderSuccessPage(res, result.user, result.token, serverBaseUrl);
      return;
    }

    // Protected MCP endpoints: /sse and /messages
    if (pathname === "/sse" || pathname === "/messages") {
      // Build headers dictionary for authentication
      const headersRecord: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headersRecord[key] = value;
      }

      // Check query parameter fallback for token (e.g. ?token=...)
      const queryToken = requestUrl.searchParams.get("token");
      if (!headersRecord["authorization"] && queryToken) {
        headersRecord["authorization"] = `Bearer ${queryToken}`;
      }

      const user = await authenticateRequest(headersRecord);
      if (!user) {
        const allowedDomain = getAllowedDomain();
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            {
              error: "Unauthorized",
              message: `Access denied. Valid @${allowedDomain} Google Workspace authentication or team token is required.`,
              authPortal: `${serverBaseUrl}/auth`,
            },
            null,
            2
          )
        );
        return;
      }

      // Handle GET /sse: Establish SSE stream
      if (pathname === "/sse" && method === "GET") {
        console.error(`[SSE Connect] Authenticated user: ${user.email} (${user.source})`);

        // Create SSE transport directing messages to /messages endpoint
        const transport = new SSEServerTransport("/messages", res);
        const sessionId = transport.sessionId;
        const sessionEntry: SseSession = {
          transport,
          userEmail: user.email,
          isAdmin: user.source === "admin_key",
        };
        transports.set(sessionId, sessionEntry);

        const cleanup = () => {
          if (transports.has(sessionId)) {
            console.error(`[SSE Close] Session closed: ${sessionId}`);
            transports.delete(sessionId);
          }
        };

        transport.onclose = cleanup;
        res.on("close", cleanup);

        try {
          await server.connect(transport);
        } catch (err) {
          console.error(`[SSE Error] Failed to connect transport:`, err);
          cleanup();
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to establish SSE stream" }));
          }
        }
        return;
      }

      // Handle POST /messages: Client sending JSON-RPC message
      if (pathname === "/messages" && method === "POST") {
        const sessionId = requestUrl.searchParams.get("sessionId");
        if (!sessionId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing sessionId query parameter" }));
          return;
        }

        const session = transports.get(sessionId);
        if (!session) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }));
          return;
        }

        // Verify session ownership: only the user who established the stream or an admin can post to it
        if (!session.isAdmin && session.userEmail !== user.email && user.source !== "admin_key") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Forbidden: session belongs to another user" }));
          return;
        }

        try {
          await session.transport.handlePostMessage(req, res);
        } catch (err) {
          console.error(`[Messages Error] Error handling post message:`, err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error handling message" }));
          }
        }
        return;
      }
    }

    // Default route: 404 with helpful links
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          error: "Not Found",
          healthCheck: `${serverBaseUrl}/health`,
          authPortal: `${serverBaseUrl}/auth`,
          sseEndpoint: `${serverBaseUrl}/sse`,
        },
        null,
        2
      )
    );
  });

  // Clean up all active transports when server closes
  httpServer.on("close", () => {
    for (const session of transports.values()) {
      try {
        session.transport.close();
      } catch {}
    }
    transports.clear();
  });

  httpServer.listen(port, () => {
    console.error(`=======================================================`);
    console.error(` EduEngage Clarity MCP Server (Remote HTTP / SSE)`);
    console.error(` Listening on port: ${port}`);
    console.error(` Base URL:          ${serverBaseUrl}`);
    console.error(` Allowed Domain:    @${getAllowedDomain()}`);
    console.error(` Health Check:      ${serverBaseUrl}/health`);
    console.error(` Auth Portal:       ${serverBaseUrl}/auth`);
    console.error(` SSE Endpoint:      ${serverBaseUrl}/sse`);
    console.error(`=======================================================`);
  });

  return httpServer;
}

function renderLoginPage(res: http.ServerResponse, serverBaseUrl: string): void {
  const allowedDomain = getAllowedDomain();
  const googleOAuthUrl = getGoogleOAuthUrl(serverBaseUrl);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EduEngage Clarity MCP Server - Sign In</title>
  <style>
    :root {
      --primary: #10b981;
      --primary-hover: #059669;
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --muted: #94a3b8;
      --border: #334155;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background-color: var(--bg); color: var(--text); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 1rem; max-width: 480px; width: 100%; padding: 2.5rem; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    .logo { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.5rem; }
    .badge { background: rgba(16, 185, 129, 0.15); color: #34d399; font-size: 0.75rem; font-weight: 600; padding: 0.25rem 0.6rem; border-radius: 9999px; text-transform: uppercase; }
    h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem; }
    p { color: var(--muted); font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.75rem; }
    .btn-google { display: flex; align-items: center; justify-content: center; gap: 0.75rem; width: 100%; padding: 0.85rem 1.25rem; background: #ffffff; color: #1e293b; font-weight: 600; font-size: 0.95rem; border-radius: 0.5rem; text-decoration: none; transition: background 0.2s, transform 0.1s; }
    .btn-google:hover { background: #f1f5f9; transform: translateY(-1px); }
    .notice { margin-top: 1.5rem; padding: 0.85rem; background: rgba(51, 65, 85, 0.4); border-radius: 0.5rem; border-left: 3px solid var(--primary); font-size: 0.85rem; color: var(--muted); }
    .error-box { background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; color: #fca5a5; padding: 1rem; border-radius: 0.5rem; font-size: 0.9rem; margin-bottom: 1.5rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <span class="badge">Internal Only</span>
    </div>
    <h1>Clarity MCP Server</h1>
    <p>Sign in with your <strong>@${escapeHtml(allowedDomain)}</strong> Google Workspace account to generate your Claude Desktop credentials.</p>
    
    ${
      googleOAuthUrl
        ? `<a href="${escapeHtml(googleOAuthUrl)}" class="btn-google">
             <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.616z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"/></svg>
             Sign in with Google Workspace
           </a>`
        : `<div class="error-box">
             <strong>Google OAuth Not Configured:</strong> Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in your Portainer container environment variables to enable Google sign-in.
           </div>`
    }

    <div class="notice">
      🔒 Access is strictly restricted to active team members with an @${escapeHtml(allowedDomain)} email.
    </div>
  </div>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function renderSuccessPage(
  res: http.ServerResponse,
  user: { email: string; name?: string },
  token: string,
  serverBaseUrl: string
): void {
  const configSnippet = JSON.stringify(
    {
      mcpServers: {
        clarity: {
          url: `${serverBaseUrl.replace(/\/$/, "")}/sse`,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2
  );

  const safeEmail = escapeHtml(user.email);
  const avatarLetter = escapeHtml(user.email.charAt(0).toUpperCase());

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connected - EduEngage Clarity MCP</title>
  <style>
    :root {
      --primary: #10b981;
      --primary-hover: #059669;
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --muted: #94a3b8;
      --code-bg: #090d16;
      --border: #334155;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background-color: var(--bg); color: var(--text); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 1rem; max-width: 600px; width: 100%; padding: 2.5rem; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
    .user-info { display: flex; align-items: center; gap: 0.75rem; }
    .avatar { width: 36px; height: 36px; border-radius: 9999px; background: #3b82f6; display: flex; align-items: center; justify-content: center; font-weight: 700; color: #fff; font-size: 0.95rem; }
    .success-badge { background: rgba(16, 185, 129, 0.2); color: #34d399; font-size: 0.75rem; font-weight: 600; padding: 0.35rem 0.75rem; border-radius: 9999px; }
    h1 { font-size: 1.35rem; font-weight: 700; margin-bottom: 0.25rem; }
    .email { color: var(--muted); font-size: 0.85rem; }
    p { color: var(--muted); font-size: 0.95rem; line-height: 1.5; margin: 1rem 0; }
    .code-container { position: relative; margin-top: 1rem; }
    pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1rem; color: #e2e8f0; font-family: "SFMono-Regular", Consolas, monospace; font-size: 0.85rem; overflow-x: auto; }
    .copy-btn { position: absolute; top: 0.6rem; right: 0.6rem; background: var(--primary); color: #fff; border: none; padding: 0.4rem 0.75rem; border-radius: 0.35rem; font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    .copy-btn:hover { background: var(--primary-hover); }
    .instructions { margin-top: 1.5rem; background: rgba(51, 65, 85, 0.4); border-radius: 0.5rem; padding: 1rem; font-size: 0.85rem; color: var(--muted); line-height: 1.6; }
    .instructions ol { padding-left: 1.25rem; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="user-info">
        <div class="avatar">${avatarLetter}</div>
        <div>
          <h1>Authenticated</h1>
          <div class="email">${safeEmail}</div>
        </div>
      </div>
      <span class="success-badge">✓ Google Verified</span>
    </div>

    <p>Add this configuration to your <strong>Claude Desktop</strong> config file to start using Microsoft Clarity tools across your client projects:</p>

    <div class="code-container">
      <button class="copy-btn" id="copyBtn" onclick="copySnippet()">Copy Config</button>
      <pre id="codeSnippet"><code>${escapeHtml(configSnippet)}</code></pre>
    </div>

    <div class="instructions">
      <strong>Setup in 3 steps:</strong>
      <ol>
        <li>Open <code>~/Library/Application Support/Claude/claude_desktop_config.json</code> (macOS) or <code>%APPDATA%\\Claude\\claude_desktop_config.json</code> (Windows).</li>
        <li>Paste the configuration above into the <code>mcpServers</code> section.</li>
        <li>Restart Claude Desktop. You can now ask Claude about any client domain!</li>
      </ol>
    </div>
  </div>

  <script>
    function copySnippet() {
      const text = document.getElementById('codeSnippet').innerText;
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('copyBtn');
        btn.innerText = 'Copied!';
        setTimeout(() => { btn.innerText = 'Copy Config'; }, 2500);
      });
    }
  </script>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function renderErrorPage(res: http.ServerResponse, error: string): void {
  const allowedDomain = getAllowedDomain();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Sign-in Error - EduEngage</title>
  <style>
    body { background: #0f172a; color: #f8fafc; font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1.5rem; }
    .card { background: #1e293b; border: 1px solid #ef4444; border-radius: 1rem; max-width: 480px; width: 100%; padding: 2rem; }
    h1 { color: #f87171; font-size: 1.35rem; margin-bottom: 0.5rem; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.5rem; }
    a { display: inline-block; background: #334155; color: #fff; padding: 0.5rem 1rem; border-radius: 0.35rem; text-decoration: none; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authentication Failed</h1>
    <p>${escapeHtml(error)}</p>
    <p>Please ensure you are signing in with an active <strong>@${escapeHtml(allowedDomain)}</strong> account.</p>
    <a href="/auth">← Back to Sign In</a>
  </div>
</body>
</html>`;

  res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
