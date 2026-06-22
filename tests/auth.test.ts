import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkQuotaForSession,
  completeOAuthCallback,
  consumeQuotaForSession,
  createOAuthLogin,
  createSessionCookie,
  debitQuotaForSession,
  getQuotaForSession,
  publicSession,
  readSession
} from "../src/magi/auth";

describe("auth and quota", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates an OAuth2 PKCE redirect and completes callback into a safe session", async () => {
    stubOAuthEnv();
    const login = createOAuthLogin(new Request("https://magi.test/api/auth/login?returnTo=/"));
    const redirect = new URL(login.redirectUrl);
    const cookie = login.setCookie.split(";")[0];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://identity.test/token") {
        return jsonResponse({ access_token: "secret-access-token", expires_in: 3600 });
      }
      if (url === "https://identity.test/userinfo") {
        return jsonResponse({ sub: "user-1", email: "user@example.test", name: "Test User" });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const callback = await completeOAuthCallback(
      new Request(`https://magi.test/api/auth/callback?code=abc&state=${redirect.searchParams.get("state")}`, {
        headers: { cookie }
      }),
      fetchImpl as unknown as typeof fetch
    );

    expect(callback.ok).toBe(true);
    if (callback.ok) {
      const sessionCookie = callback.setCookie.find((value) => value.startsWith("magi_session="));
      expect(sessionCookie).toBeTruthy();
      const session = readSession(new Request("https://magi.test", { headers: { cookie: sessionCookie!.split(";")[0] } }));
      expect(session?.accessToken).toBe("secret-access-token");
      expect(publicSession(session)).toMatchObject({
        authenticated: true,
        user: { id: "user-1", email: "user@example.test", name: "Test User" },
        quotaRemaining: 10
      });
      expect(JSON.stringify(publicSession(session))).not.toContain("secret-access-token");
    }
  });

  it("rejects invalid OAuth state", async () => {
    stubOAuthEnv();
    const result = await completeOAuthCallback(new Request("https://magi.test/api/auth/callback?code=abc&state=bad"));

    expect(result).toMatchObject({ ok: false, status: 400, error: "invalid oauth state" });
  });

  it("debits local quota by updating the signed session cookie", async () => {
    vi.stubEnv("SESSION_SECRET", "test-secret");
    vi.stubEnv("MAGI_DEFAULT_QUOTA", "2");
    const request = new Request("https://magi.test");
    const session = {
      user: { id: "user-1" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      quotaRemaining: 2
    };

    const debit = await debitQuotaForSession(request, session, 1);

    expect(debit).toMatchObject({ ok: true, quota: { remaining: 1 } });
    const updatedSession = readSession(new Request("https://magi.test", { headers: { cookie: debit.setCookie!.split(";")[0] } }));
    expect(updatedSession?.quotaRemaining).toBe(1);
  });

  it("returns quota exhausted when local quota is empty", async () => {
    vi.stubEnv("SESSION_SECRET", "test-secret");
    const request = new Request("https://magi.test");
    const session = {
      user: { id: "user-1" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      quotaRemaining: 0
    };

    await expect(debitQuotaForSession(request, session, 1)).resolves.toMatchObject({
      ok: false,
      status: 402,
      error: "quota exhausted"
    });
  });

  it("reads signed session cookies and rejects tampering", () => {
    vi.stubEnv("SESSION_SECRET", "test-secret");
    const request = new Request("https://magi.test");
    const cookie = createSessionCookie(
      {
        user: { id: "user-1" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        quotaRemaining: 1
      },
      request
    ).split(";")[0];

    expect(readSession(new Request("https://magi.test", { headers: { cookie } }))?.user.id).toBe("user-1");
    expect(readSession(new Request("https://magi.test", { headers: { cookie: `${cookie}tampered` } }))).toBeNull();
  });

  it("reads Windo-C quota with the user access token and no subject", async () => {
    vi.stubEnv("QUOTA_API_URL", "http://localhost:8000");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://localhost:8000/api/apps/magi-system/quota");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer user-token" });
      return jsonResponse([
        {
          app: "magi-system",
          feature: "resolve",
          remaining: 5,
          limit: 5,
          used: 0,
          reset_at: null
        }
      ]);
    });

    const quota = await getQuotaForSession(
      {
        user: { id: "user-1" },
        accessToken: "user-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
      fetchImpl as unknown as typeof fetch
    );

    expect(quota).toMatchObject({ remaining: 5, limit: 5, used: 0 });
  });

  it("checks and consumes Windo-C quota with the same request id", async () => {
    vi.stubEnv("QUOTA_API_URL", "http://localhost:8000");
    vi.stubEnv("MAGI_QUOTA_APP", "custom-magi");
    vi.stubEnv("MAGI_QUOTA_FEATURE", "custom.resolve");
    const calls: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        init,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      });
      return jsonResponse({ allowed: true, consumed: true, remaining: 4, limit: 5, used: 1, reset_at: null });
    });
    const request = new Request("https://magi.test");
    const session = {
      user: { id: "user-1" },
      accessToken: "user-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };

    const check = await checkQuotaForSession(request, session, 1, "request-1", fetchImpl as unknown as typeof fetch);
    const consume = await consumeQuotaForSession(request, session, 1, check.requestId!, fetchImpl as unknown as typeof fetch);

    expect(check.ok).toBe(true);
    expect(consume.ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:8000/api/quota/check",
      "http://localhost:8000/api/quota/consume"
    ]);
    expect(calls[0].init?.headers).toMatchObject({ Authorization: "Bearer user-token" });
    expect(calls[0].body).toEqual({
      app: "custom-magi",
      feature: "custom.resolve",
      quantity: 1,
      request_id: "request-1"
    });
    expect(calls[0].body).not.toHaveProperty("subject");
    expect(calls[1].body.request_id).toBe("request-1");
  });

  it("treats Windo-C 403 quota check as a hard denial", async () => {
    vi.stubEnv("QUOTA_API_URL", "http://localhost:8000");
    const fetchImpl = vi.fn(async () => jsonResponse(
      { allowed: false, remaining: 0, limit: 5, used: 5, reason: "quota_exceeded" },
      403
    ));

    await expect(checkQuotaForSession(
      new Request("https://magi.test"),
      {
        user: { id: "user-1" },
        accessToken: "user-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
      1,
      "request-1",
      fetchImpl as unknown as typeof fetch
    )).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: "quota_exceeded",
      quota: { remaining: 0, limit: 5, used: 5 }
    });
  });
});

function stubOAuthEnv() {
  vi.stubEnv("SESSION_SECRET", "test-secret");
  vi.stubEnv("OAUTH_CLIENT_ID", "client-id");
  vi.stubEnv("OAUTH_CLIENT_SECRET", "client-secret");
  vi.stubEnv("OAUTH_AUTHORIZATION_URL", "https://identity.test/authorize");
  vi.stubEnv("OAUTH_TOKEN_URL", "https://identity.test/token");
  vi.stubEnv("OAUTH_USERINFO_URL", "https://identity.test/userinfo");
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
