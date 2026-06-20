import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeOAuthCallback,
  createOAuthLogin,
  createSessionCookie,
  debitQuotaForSession,
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
});

function stubOAuthEnv() {
  vi.stubEnv("SESSION_SECRET", "test-secret");
  vi.stubEnv("OAUTH_CLIENT_ID", "client-id");
  vi.stubEnv("OAUTH_CLIENT_SECRET", "client-secret");
  vi.stubEnv("OAUTH_AUTHORIZATION_URL", "https://identity.test/authorize");
  vi.stubEnv("OAUTH_TOKEN_URL", "https://identity.test/token");
  vi.stubEnv("OAUTH_USERINFO_URL", "https://identity.test/userinfo");
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
