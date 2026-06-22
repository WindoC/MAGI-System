import crypto from "node:crypto";

export interface AuthUser {
  id: string;
  email?: string;
  name?: string;
}

export interface AuthSession {
  user: AuthUser;
  accessToken?: string;
  expiresAt: string;
  quotaRemaining?: number;
}

export interface PublicSession {
  authenticated: boolean;
  authEnabled: boolean;
  user: AuthUser | null;
  quotaRemaining: number | null;
  expiresAt: string | null;
}

export interface OAuthState {
  state: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: string;
}

export interface QuotaStatus {
  remaining: number | null;
  limit?: number;
  resetAt?: string;
  used?: number;
  expiresAt?: string;
}

export interface QuotaOperationResult {
  ok: boolean;
  status: number;
  quota?: QuotaStatus;
  session?: AuthSession;
  setCookie?: string;
  error?: string;
  requestId?: string;
}

const sessionCookieName = "magi_session";
const oauthStateCookieName = "magi_oauth_state";
const defaultScope = "openid profile email";
const defaultQuota = 10;
const defaultQuotaApp = "magi-system";
const defaultQuotaFeature = "resolve";

export function createOAuthLogin(request: Request): { redirectUrl: string; setCookie: string } {
  if (!isAuthEnabled()) {
    return { redirectUrl: "/", setCookie: createSessionCookie(createLocalSession(), request) };
  }

  const config = getOAuthConfig(request);
  const state = randomBase64Url(24);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  const requestUrl = new URL(request.url);
  const returnTo = requestUrl.searchParams.get("returnTo") || "/";
  const oauthState: OAuthState = {
    state,
    codeVerifier,
    returnTo,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  };

  const authorizationUrl = new URL(config.authorizationUrl);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizationUrl.searchParams.set("scope", config.scope);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  return {
    redirectUrl: authorizationUrl.toString(),
    setCookie: serializeCookie(oauthStateCookieName, signJson(oauthState), {
      httpOnly: true,
      maxAge: 600,
      sameSite: "Lax",
      secure: isSecureCookie(request)
    })
  };
}

export async function completeOAuthCallback(
  request: Request,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; redirectUrl: string; setCookie: string[] } | { ok: false; status: number; error: string; setCookie?: string[] }> {
  const callbackUrl = new URL(request.url);
  const code = callbackUrl.searchParams.get("code");
  const state = callbackUrl.searchParams.get("state");
  const storedState = readSignedJson<OAuthState>(readCookie(request, oauthStateCookieName));

  if (!code || !state || !storedState || storedState.state !== state || new Date(storedState.expiresAt).getTime() <= Date.now()) {
    return {
      ok: false,
      status: 400,
      error: "invalid oauth state",
      setCookie: [clearCookie(oauthStateCookieName, request)]
    };
  }

  const config = getOAuthConfig(request);
  const tokenResponse = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: storedState.codeVerifier
    })
  });

  if (!tokenResponse.ok) {
    return {
      ok: false,
      status: 502,
      error: "oauth token exchange failed",
      setCookie: [clearCookie(oauthStateCookieName, request)]
    };
  }

  const tokenPayload = (await tokenResponse.json()) as { access_token?: string; expires_in?: number };
  if (!tokenPayload.access_token) {
    return {
      ok: false,
      status: 502,
      error: "oauth token response missing access_token",
      setCookie: [clearCookie(oauthStateCookieName, request)]
    };
  }

  const userResponse = await fetchImpl(config.userInfoUrl, {
    headers: { Authorization: `Bearer ${tokenPayload.access_token}`, Accept: "application/json" }
  });

  if (!userResponse.ok) {
    return {
      ok: false,
      status: 502,
      error: "oauth userinfo failed",
      setCookie: [clearCookie(oauthStateCookieName, request)]
    };
  }

  const userPayload = (await userResponse.json()) as Record<string, unknown>;
  const session: AuthSession = {
    user: normalizeUser(userPayload),
    accessToken: tokenPayload.access_token,
    quotaRemaining: isExternalQuotaConfigured() || !isQuotaEnabled() ? undefined : getDefaultQuota(),
    expiresAt: new Date(Date.now() + getSessionTtlSeconds() * 1000).toISOString()
  };

  return {
    ok: true,
    redirectUrl: storedState.returnTo || "/",
    setCookie: [createSessionCookie(session, request), clearCookie(oauthStateCookieName, request)]
  };
}

export function readSession(request: Request): AuthSession | null {
  if (!isAuthEnabled()) {
    return createLocalSession();
  }

  const session = readSignedJson<AuthSession>(readCookie(request, sessionCookieName));
  if (!session || !session.user?.id || new Date(session.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  return session;
}

export function publicSession(session: AuthSession | null): PublicSession {
  if (!session) {
    return { authenticated: false, authEnabled: isAuthEnabled(), user: null, quotaRemaining: null, expiresAt: null };
  }

  return {
    authenticated: true,
    authEnabled: isAuthEnabled(),
    user: session.user,
    quotaRemaining: session.quotaRemaining ?? null,
    expiresAt: session.expiresAt
  };
}

export async function getQuotaForSession(session: AuthSession, fetchImpl: typeof fetch = fetch): Promise<QuotaStatus> {
  if (!isQuotaEnabled()) {
    return { remaining: null };
  }

  const externalUrl = process.env.QUOTA_API_URL;
  if (externalUrl) {
    if (!session.accessToken) {
      return { remaining: 0 };
    }
    const url = new URL(`${externalUrl.replace(/\/$/, "")}/api/apps/${getQuotaApp()}/quota`);
    const response = await fetchImpl(url, {
      headers: quotaHeaders(session)
    });
    if (!response.ok) {
      return { remaining: 0 };
    }
    return normalizeQuota(await response.json());
  }

  return { remaining: session.quotaRemaining ?? getDefaultQuota() };
}

export async function checkQuotaForSession(
  request: Request,
  session: AuthSession,
  amount: number,
  requestId: string = crypto.randomUUID(),
  fetchImpl: typeof fetch = fetch
): Promise<QuotaOperationResult> {
  const externalUrl = process.env.QUOTA_API_URL;
  if (!isQuotaEnabled()) {
    return { ok: true, status: 200, quota: { remaining: null }, session, requestId };
  }

  if (externalUrl) {
    if (!session.accessToken) {
      return { ok: false, status: 401, error: "missing access token", requestId };
    }

    const response = await fetchImpl(`${externalUrl.replace(/\/$/, "")}/api/quota/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...quotaHeaders(session) },
      body: JSON.stringify({
        app: getQuotaApp(),
        feature: getQuotaFeature(),
        quantity: amount,
        request_id: requestId
      })
    });

    const payload = await safeJson(response);
    if (response.status === 403) {
      return {
        ok: false,
        status: 403,
        error: stringValue(payload.reason) || "quota exhausted",
        quota: normalizeQuota(payload),
        requestId
      };
    }
    if (response.status === 429) {
      return { ok: false, status: 429, error: "quota rate limited", quota: normalizeQuota(payload), requestId };
    }
    if (!response.ok) {
      return { ok: false, status: 502, error: "quota check failed", quota: normalizeQuota(payload), requestId };
    }

    const quota = normalizeQuota(payload);
    if (payload.allowed === false) {
      return { ok: false, status: 403, error: "quota exhausted", quota, requestId };
    }

    return { ok: true, status: 200, quota, session, requestId };
  }

  const current = session.quotaRemaining ?? getDefaultQuota();
  if (current < amount) {
    return { ok: false, status: 402, error: "quota exhausted", quota: { remaining: current }, requestId };
  }

  return { ok: true, status: 200, quota: { remaining: current }, session, requestId };
}

export async function consumeQuotaForSession(
  request: Request,
  session: AuthSession,
  amount: number,
  requestId: string,
  fetchImpl: typeof fetch = fetch
): Promise<QuotaOperationResult> {
  const externalUrl = process.env.QUOTA_API_URL;
  if (!isQuotaEnabled()) {
    return { ok: true, status: 200, quota: { remaining: null }, session, requestId };
  }

  if (externalUrl) {
    if (!session.accessToken) {
      return { ok: false, status: 401, error: "missing access token", requestId };
    }

    const response = await fetchQuotaConsume(
      `${externalUrl.replace(/\/$/, "")}/api/quota/consume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...quotaHeaders(session) },
        body: JSON.stringify({
          app: getQuotaApp(),
          feature: getQuotaFeature(),
          quantity: amount,
          request_id: requestId
        })
      },
      fetchImpl
    );

    const payload = await safeJson(response);
    if (response.status === 429) {
      return { ok: false, status: 429, error: "quota rate limited", quota: normalizeQuota(payload), requestId };
    }
    if (!response.ok) {
      return { ok: false, status: 502, error: "quota consume failed", quota: normalizeQuota(payload), requestId };
    }

    return { ok: true, status: 200, quota: normalizeQuota(payload), session, requestId };
  }

  const current = session.quotaRemaining ?? getDefaultQuota();
  if (current < amount) {
    return { ok: false, status: 402, error: "quota exhausted", quota: { remaining: current }, requestId };
  }
  const updatedSession = { ...session, quotaRemaining: current - amount };
  return {
    ok: true,
    status: 200,
    quota: { remaining: updatedSession.quotaRemaining },
    session: updatedSession,
    setCookie: createSessionCookie(updatedSession, request)
  };
}

export async function debitQuotaForSession(
  request: Request,
  session: AuthSession,
  amount: number,
  fetchImpl: typeof fetch = fetch
): Promise<QuotaOperationResult> {
  const checked = await checkQuotaForSession(request, session, amount, crypto.randomUUID(), fetchImpl);
  if (!checked.ok) {
    return checked;
  }
  return consumeQuotaForSession(request, session, amount, checked.requestId!, fetchImpl);
}

export function createSessionCookie(session: AuthSession, request: Request): string {
  return serializeCookie(sessionCookieName, signJson(session), {
    httpOnly: true,
    maxAge: getSessionTtlSeconds(),
    sameSite: "Lax",
    secure: isSecureCookie(request)
  });
}

export function clearSessionCookie(request: Request): string {
  return clearCookie(sessionCookieName, request);
}

export function authError(status: 401 | 402, error: string): { status: number; payload: { error: string } } {
  return { status, payload: { error } };
}

function getOAuthConfig(request: Request) {
  const origin = new URL(request.url).origin;
  const clientId = process.env.OAUTH_CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;
  const authorizationUrl = process.env.OAUTH_AUTHORIZATION_URL;
  const tokenUrl = process.env.OAUTH_TOKEN_URL;
  const userInfoUrl = process.env.OAUTH_USERINFO_URL;
  const redirectUri = process.env.OAUTH_REDIRECT_URI || `${origin}/api/auth/callback`;

  if (!clientId || !clientSecret || !authorizationUrl || !tokenUrl || !userInfoUrl) {
    throw new Error("OAuth2 environment is not configured");
  }

  return {
    clientId,
    clientSecret,
    authorizationUrl,
    tokenUrl,
    userInfoUrl,
    redirectUri,
    scope: process.env.OAUTH_SCOPE || defaultScope
  };
}

function createLocalSession(): AuthSession {
  return {
    user: {
      id: process.env.MAGI_LOCAL_USER_ID?.trim() || "local-user",
      email: process.env.MAGI_LOCAL_USER_EMAIL?.trim() || undefined,
      name: process.env.MAGI_LOCAL_USER_NAME?.trim() || "Local User"
    },
    quotaRemaining: isQuotaEnabled() ? getDefaultQuota() : undefined,
    expiresAt: new Date(Date.now() + getSessionTtlSeconds() * 1000).toISOString()
  };
}

function normalizeUser(payload: Record<string, unknown>): AuthUser {
  const id = stringValue(payload.sub) || stringValue(payload.id) || stringValue(payload.email);
  if (!id) {
    throw new Error("oauth userinfo missing subject");
  }

  return {
    id,
    email: stringValue(payload.email),
    name: stringValue(payload.name) || stringValue(payload.preferred_username)
  };
}

function normalizeQuota(payload: unknown): QuotaStatus {
  const quotaApp = getQuotaApp();
  const quotaFeature = getQuotaFeature();
  const source = Array.isArray(payload)
    ? payload.find((item) => isQuotaRecord(item) && item.app === quotaApp && item.feature === quotaFeature) ?? payload[0]
    : payload;
  const record = typeof source === "object" && source !== null ? (source as Record<string, unknown>) : {};
  const remaining = numberValue(record.remaining ?? record.quotaRemaining);
  return {
    remaining: remaining ?? 0,
    limit: numberValue(record.limit),
    used: numberValue(record.used),
    resetAt: stringValue(record.reset_at) || stringValue(record.resetAt),
    expiresAt: stringValue(record.expires_at) || stringValue(record.expiresAt)
  };
}

function quotaHeaders(session: AuthSession): HeadersInit {
  return { Authorization: `Bearer ${session.accessToken}` };
}

function getQuotaApp(): string {
  return process.env.MAGI_QUOTA_APP?.trim() || defaultQuotaApp;
}

function getQuotaFeature(): string {
  return process.env.MAGI_QUOTA_FEATURE?.trim() || defaultQuotaFeature;
}

export function isAuthEnabled(): boolean {
  return process.env.MAGI_AUTH_ENABLED !== "false";
}

export function isQuotaEnabled(): boolean {
  return process.env.MAGI_QUOTA_ENABLED !== "false";
}

function isExternalQuotaConfigured(): boolean {
  return Boolean(process.env.QUOTA_API_URL?.trim());
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload = await response.json();
    return typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function fetchQuotaConsume(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch {
    return fetchImpl(url, init);
  }
}

function isQuotaRecord(value: unknown): value is { app?: unknown; feature?: unknown } {
  return typeof value === "object" && value !== null;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) {
    return null;
  }

  for (const item of header.split(";")) {
    const [cookieName, ...valueParts] = item.trim().split("=");
    if (cookieName === name) {
      return valueParts.join("=");
    }
  }

  return null;
}

function signJson(value: unknown): string {
  const payload = base64Url(Buffer.from(JSON.stringify(value), "utf8"));
  const signature = base64Url(crypto.createHmac("sha256", getSessionSecret()).update(payload).digest());
  return `${payload}.${signature}`;
}

function readSignedJson<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }

  const [payload, signature] = value.split(".");
  if (!payload || !signature) {
    return null;
  }

  const expected = base64Url(crypto.createHmac("sha256", getSessionSecret()).update(payload).digest());
  if (!timingSafeEqual(signature, expected)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(base64UrlToBase64(payload), "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function serializeCookie(
  name: string,
  value: string,
  options: { httpOnly?: boolean; maxAge?: number; sameSite?: "Lax" | "Strict" | "None"; secure?: boolean }
): string {
  const parts = [`${name}=${value}`, "Path=/"];
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  return parts.join("; ");
}

function clearCookie(name: string, request: Request): string {
  return serializeCookie(name, "", {
    httpOnly: true,
    maxAge: 0,
    sameSite: "Lax",
    secure: isSecureCookie(request)
  });
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET is required in production");
    }
    return "magi-development-session-secret";
  }
  return secret;
}

function getSessionTtlSeconds(): number {
  const parsed = Number(process.env.SESSION_TTL_SECONDS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 60 * 60 * 8;
}

function getDefaultQuota(): number {
  const parsed = Number(process.env.MAGI_DEFAULT_QUOTA);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : defaultQuota;
}

function isSecureCookie(request: Request): boolean {
  return new URL(request.url).protocol === "https:" || process.env.NODE_ENV === "production";
}

function randomBase64Url(bytes: number): string {
  return base64Url(crypto.randomBytes(bytes));
}

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlToBase64(input: string): string {
  const padded = input.padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}
