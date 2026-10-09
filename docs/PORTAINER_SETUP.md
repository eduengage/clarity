# Deploying Clarity MCP Server on Portainer with Google Workspace Auth

This guide explains how to deploy the **EduEngage Clarity MCP Server** as a Docker container on **Portainer**, configure **Google Workspace (`@eduengage.com`)** inbound authentication, and connect team members via **Claude Desktop**.

---

## 1. Google Cloud OAuth 2.0 Setup (One-Time)

To allow team members to sign in with their `@eduengage.com` Google account:

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select your agency project (e.g., `eduengage-internal`).
3. Navigate to **APIs & Services** → **OAuth consent screen**:
   * **User Type**: Select **Internal** (only users within the `eduengage.com` Google Workspace organization can access).
   * **App name**: `EduEngage Clarity MCP`
   * **User support email**: `hello@eduengage.com`
4. Navigate to **APIs & Services** → **Credentials**:
   * Click **Create Credentials** → **OAuth client ID**.
   * **Application type**: **Web application**.
   * **Name**: `Clarity MCP Server`.
   * **Authorized redirect URIs**:
     ```text
     https://clarity.eduengage.com/auth/callback
     ```
     *(Or your custom reverse proxy / Portainer subdomain)*.
5. Save your **Client ID** and **Client Secret**.

---

## 2. Deploying on Portainer

### Method A: Deploy via Portainer Web Editor (Recommended)

1. Log into your **Portainer** dashboard.
2. Go to **Stacks** → **Add stack**.
3. Name the stack: `clarity-mcp`.
4. Choose **Web editor** and paste the contents of [`docker-compose.yml`](../docker-compose.yml):

```yaml
version: "3.8"

services:
  clarity-mcp:
    image: ghcr.io/eduengage/clarity:latest # Or build from Git repo
    container_name: clarity-mcp
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - TRANSPORT=http
      - SERVER_BASE_URL=https://clarity.eduengage.com
      - ALLOWED_DOMAIN=eduengage.com
      - GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
      - GOOGLE_CLIENT_SECRET=your-google-client-secret
      - TOKEN_SECRET=generate-a-random-32-char-secret-string
      - EDUENGAGE_AGENCY_KEY=optional-master-admin-key-for-ci
      - ACCOUNTS_CONFIG_JSON={"default":"eduengage.com","accounts":{"eduengage.com":{"token":"clarity-token-1"},"client-a.com":{"token":"clarity-token-2"}}}
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      start_period: 5s
      retries: 3
```

5. Under **Environment variables**, set your secrets:
   * `SERVER_BASE_URL`: The public HTTPS URL where the server is accessed (e.g. `https://clarity.eduengage.com`).
   * `ALLOWED_DOMAIN`: `eduengage.com`
   * `GOOGLE_CLIENT_ID`: Your Google OAuth Client ID.
   * `GOOGLE_CLIENT_SECRET`: Your Google OAuth Client Secret.
   * `TOKEN_SECRET`: A secure random string for signing member session tokens.
   * `ACCOUNTS_CONFIG_JSON`: Your client Clarity API tokens in JSON format.
6. Click **Deploy the stack**.

---

### Method B: Deploy directly from GitHub Repository in Portainer

1. Go to **Stacks** → **Add stack**.
2. Select **Repository**.
3. Repository URL: `https://github.com/eduengage/clarity`.
4. Repository reference: `refs/heads/main`.
5. Compose path: `docker-compose.yml`.
6. Fill in the Environment variables as described above.
7. Click **Deploy the stack**.

---

## 3. Configuring Client Clarity API Tokens

All client Microsoft Clarity tokens live centrally in Portainer. You never need to distribute tokens to employees.

### Setting Tokens via `ACCOUNTS_CONFIG_JSON`:

In Portainer's stack environment variables:

```json
ACCOUNTS_CONFIG_JSON={
  "default": "eduengage.com",
  "accounts": {
    "eduengage.com": {
      "token": "clarity_api_token_agency"
    },
    "clientone.com": {
      "token": "clarity_api_token_client_1"
    },
    "clienttwo.org": {
      "token": "clarity_api_token_client_2"
    }
  }
}
```

Whenever you onboard a new client:
1. Generate the token in that client's **Clarity Dashboard** → **Settings** → **Data Export** → **Generate new API token**.
2. Add the domain and token to `ACCOUNTS_CONFIG_JSON` in Portainer.
3. Update the stack. The server reloads instantly.

---

## 4. How Team Members Connect from Claude Desktop

1. Team member visits:
   ```text
   https://clarity.eduengage.com/auth
   ```
2. Clicks **Sign in with Google Workspace** using their `@eduengage.com` account.
3. The page verifies their `@eduengage.com` identity and displays their personalized Claude Desktop snippet with a **"Copy Config"** button:

```json
{
  "mcpServers": {
    "clarity": {
      "url": "https://clarity.eduengage.com/sse",
      "headers": {
        "Authorization": "Bearer eet_eyJlbWFpbCI6ImpvaG5AZWR1ZW5nYWdlLmNvbSI...<signed-token>"
      }
    }
  }
}
```

4. The employee pastes this snippet into their Claude Desktop configuration file:
   * **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   * **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
5. Restart Claude Desktop.

---

## 5. Usage in Claude

Team members can now query any configured project naturally:

* *"Show me rage click sessions for clientone.com from the past 3 days"*
* *"What were the top referrer sources for eduengage.com this week?"*
* *"What Clarity accounts are available?"* (calls `list-clarity-accounts`)
