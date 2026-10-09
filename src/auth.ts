import crypto from "node:crypto";
import { getConfigValue } from "./utils.js";

export interface AuthenticatedUser {
  email: string;
  name?: string;
  domain: string;
  source: "google_id_token" | "session_token" | "admin_key" | "proxy_header";
}

export interface SessionTokenPayload {
  email: string;
  domain: string;
  iat: number;
  exp: number;
}

const DEFAULT_ALLOWED_DOMAIN = "eduengage.com";
const DEFAULT_TOKEN_TTL_DAYS = 60; // 60 days validity for Claude Desktop session tokens

/**
 * Get the configured allowed domain (defaults to eduengage.com).
 */
export function getAllowedDomain(): string {
  return process.env.ALLOWED_DOMAIN || getConfigValue("allowed_domain", DEFAULT_ALLOWED_DOMAIN) || DEFAULT_ALLOWED_DOMAIN;
}

/**
 * Get or generate a persistent signing secret for HMAC session tokens.
 */
function getTokenSecret(): string {
  const secret = process.env.TOKEN_SECRET || getConfigValue("token_secret");
  if (secret && secret.length >= 16) {
    return secret;
  }
  // Fallback to a stable hash of agency key or warn in production
  const agencyKey = process.env.EDUENGAGE_AGENCY_KEY || getConfigValue("agency_key");
  if (agencyKey) {
    return crypto.createHash("sha256").update(agencyKey).digest("hex");
  }
  return "default-eduengage-signing-secret-change-in-prod";
}

/**
 * Sign a session token for an authenticated user.
 */
export function createSessionToken(email: string, domain: string, daysValid = DEFAULT_TOKEN_TTL_DAYS): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionTokenPayload = {
    email: email.toLowerCase(),
    domain: domain.toLowerCase(),
    iat: now,
    exp: now + daysValid * 86400,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", getTokenSecret())
    .update(encodedPayload)
    .digest("base64url");

  return `eet_${encodedPayload}.${signature}`;
}

/**
 * Strictly validate that an email address belongs exactly to the allowed domain.
 * Disallows subdomains (e.g. user@sub.eduengage.com), multiple @ symbols, or prefix/suffix attacks.
 */
export function isValidEmailForDomain(email: string, allowedDomain: string): boolean {
  if (typeof email !== "string") return false;
  const normalized = email.trim().toLowerCase();
  const parts = normalized.split("@");
  if (parts.length !== 2) return false;
  const [localPart, domainPart] = parts;
  if (!localPart || !domainPart) return false;
  return domainPart === allowedDomain.trim().toLowerCase();
}

/**
 * Verify and decode an EduEngage session token.
 */
export function verifySessionToken(token: string): AuthenticatedUser | null {
  try {
    if (!token || typeof token !== "string" || !token.startsWith("eet_")) {
      return null;
    }

    const raw = token.slice(4);
    const parts = raw.split(".");
    if (parts.length !== 2) {
      return null;
    }

    const [encodedPayload, providedSignature] = parts as [string, string];
    if (!encodedPayload || !providedSignature) {
      return null;
    }

    const expectedSignature = crypto
      .createHmac("sha256", getTokenSecret())
      .update(encodedPayload)
      .digest("base64url");

    const provBuf = Buffer.from(providedSignature);
    const expBuf = Buffer.from(expectedSignature);

    // Constant-time comparison with length guard to prevent RangeError
    if (provBuf.length !== expBuf.length || !crypto.timingSafeEqual(provBuf, expBuf)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SessionTokenPayload;
    const now = Math.floor(Date.now() / 1000);

    if (!payload.exp || typeof payload.exp !== "number" || payload.exp < now) {
      return null; // Expired
    }

    const allowedDomain = getAllowedDomain().toLowerCase();
    if (
      payload.domain?.toLowerCase() !== allowedDomain ||
      !isValidEmailForDomain(payload.email, allowedDomain)
    ) {
      return null; // Domain mismatch
    }

    return {
      email: payload.email.toLowerCase(),
      domain: allowedDomain,
      source: "session_token",
    };
  } catch {
    return null;
  }
}

/**
 * Validate a raw Google OAuth2 ID Token against Google's public tokeninfo endpoint.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<AuthenticatedUser | null> {
  try {
    if (!idToken || typeof idToken !== "string") {
      return null;
    }

    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (!data || typeof data !== "object") {
      return null;
    }

    const allowedDomain = getAllowedDomain().toLowerCase();
    const userDomain = typeof data.hd === "string" ? data.hd.toLowerCase() : "";
    const email = typeof data.email === "string" ? data.email.toLowerCase() : "";
    const emailVerified = data.email_verified === "true" || data.email_verified === true;

    if (!emailVerified) {
      return null;
    }

    // Strictly require BOTH hosted domain (hd) and email to match allowedDomain
    if (userDomain !== allowedDomain || !isValidEmailForDomain(email, allowedDomain)) {
      return null;
    }

    return {
      email,
      name: typeof data.name === "string" ? data.name : undefined,
      domain: allowedDomain,
      source: "google_id_token",
    };
  } catch (error) {
    console.error("Error verifying Google ID token:", error);
    return null;
  }
}

/**
 * Authenticate an incoming HTTP request using any of the supported mechanisms:
 * 1. EduEngage session token (`Bearer eet_...`)
 * 2. Raw Google ID Token (`Bearer eyJ...`)
 * 3. Master Agency Admin Key (`Bearer <EDUENGAGE_AGENCY_KEY>`)
 * 4. Cloudflare Access / Identity-Aware Proxy header (`Cf-Access-Authenticated-User-Email`)
 */
export async function authenticateRequest(headers: Record<string, string | string[] | undefined>): Promise<AuthenticatedUser | null> {
  const allowedDomain = getAllowedDomain().toLowerCase();

  // 1. Check Cloudflare Access / Google Cloud IAP Header
  const rawProxy = headers["cf-access-authenticated-user-email"] ?? headers["x-goog-authenticated-user-email"];
  const proxyEmail = Array.isArray(rawProxy) ? rawProxy[0] : rawProxy;
  if (typeof proxyEmail === "string" && isValidEmailForDomain(proxyEmail, allowedDomain)) {
    return {
      email: proxyEmail.trim().toLowerCase(),
      domain: allowedDomain,
      source: "proxy_header",
    };
  }

  // 2. Extract Authorization header (case-insensitive "Bearer <token>")
  const authHeader = headers["authorization"] ?? headers["Authorization"];
  const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  if (typeof authValue !== "string") {
    return null;
  }

  const bearerMatch = authValue.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch || !bearerMatch[1]) {
    return null;
  }

  const token = bearerMatch[1].trim();
  if (!token) {
    return null;
  }

  // 3. Check EduEngage Session Token
  if (token.startsWith("eet_")) {
    return verifySessionToken(token);
  }

  // 4. Check Master Agency Key (emergency / CI admin key)
  const agencyKey = process.env.EDUENGAGE_AGENCY_KEY || getConfigValue("agency_key");
  if (agencyKey && token === agencyKey) {
    return {
      email: `admin@${allowedDomain}`,
      domain: allowedDomain,
      source: "admin_key",
    };
  }

  // 5. Check if it's a Google ID token (JWT format: 3 segments)
  if (token.split(".").length === 3) {
    return await verifyGoogleIdToken(token);
  }

  return null;
}

/**
 * Build Google OAuth2 authorization URL for web sign-in.
 */
export function getGoogleOAuthUrl(serverBaseUrl: string): string | null {
  const clientId = process.env.GOOGLE_CLIENT_ID || getConfigValue("google_client_id");
  if (!clientId) {
    return null;
  }

  const redirectUri = `${serverBaseUrl.replace(/\/$/, "")}/auth/callback`;
  const allowedDomain = getAllowedDomain();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    hd: allowedDomain, // Restricts Google account picker to the specified domain
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange Google OAuth2 authorization code for user info and issue a session token.
 */
export async function handleGoogleOAuthCallback(
  code: string,
  serverBaseUrl: string,
): Promise<{ user: AuthenticatedUser; token: string } | { error: string }> {
  const clientId = process.env.GOOGLE_CLIENT_ID || getConfigValue("google_client_id");
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || getConfigValue("google_client_secret");

  if (!clientId || !clientSecret) {
    return { error: "Google OAuth credentials not configured on the server." };
  }

  const redirectUri = `${serverBaseUrl.replace(/\/$/, "")}/auth/callback`;

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text();
      console.error("Google token exchange failed:", errBody);
      return { error: "Failed to exchange authorization code with Google." };
    }

    const tokenData = await tokenResponse.json();
    const idToken = tokenData.id_token;
    if (!idToken) {
      return { error: "No ID token received from Google." };
    }

    const verifiedUser = await verifyGoogleIdToken(idToken);
    if (!verifiedUser) {
      const allowedDomain = getAllowedDomain();
      return {
        error: `Access denied. Only authenticated accounts belonging to @${allowedDomain} are authorized.`,
      };
    }

    const sessionToken = createSessionToken(verifiedUser.email, verifiedUser.domain);
    return {
      user: verifiedUser,
      token: sessionToken,
    };
  } catch (error) {
    console.error("OAuth callback error:", error);
    return { error: "An unexpected error occurred during Google sign-in." };
  }
}
