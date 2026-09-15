import { afterEach, describe, expect, it, vi } from "vitest";
import { CognitoAuthClient, createPkceChallenge, type SessionStorageLike } from "./cognito.js";

class MemoryStorage implements SessionStorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const config = {
  domain: "stagecast-admin-123.auth.us-east-1.amazoncognito.com",
  clientId: "test-client",
  redirectUri: "https://admin.example/auth/callback",
  logoutUri: "https://admin.example/",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CognitoAuthClient (T6 / F-12)", () => {
  it("PKCE challenge は base64url 形式 (RFC 7636)", async () => {
    const { verifier, challenge } = await createPkceChallenge();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("ログイン URL に code_challenge と state を載せる", async () => {
    const storage = new MemoryStorage();
    const auth = new CognitoAuthClient(config, storage);
    const url = new URL(await auth.buildLoginUrl());
    expect(url.host).toBe(config.domain);
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
    // verifier と state は storage に保存される (callback で検証する)。
    expect(storage.getItem("stagecast.auth.pkce.verifier")).toBeTruthy();
    expect(storage.getItem("stagecast.auth.oauth.state")).toBeTruthy();
  });

  it("state 不一致なら exchange を拒否する (CSRF 防御)", async () => {
    const storage = new MemoryStorage();
    storage.setItem("stagecast.auth.oauth.state", "expected");
    storage.setItem("stagecast.auth.pkce.verifier", "vvv");
    const auth = new CognitoAuthClient(config, storage);
    await expect(auth.exchangeCode("code", "different")).rejects.toThrow(/state mismatch/);
  });

  it("verifier 未保存なら exchange を拒否する", async () => {
    const storage = new MemoryStorage();
    storage.setItem("stagecast.auth.oauth.state", "s");
    const auth = new CognitoAuthClient(config, storage);
    await expect(auth.exchangeCode("code", "s")).rejects.toThrow(/verifier missing/);
  });

  it("saveTokens → getTokens は期限内ならトークンを返し、期限切れなら undefined", () => {
    const storage = new MemoryStorage();
    const auth = new CognitoAuthClient(config, storage);
    auth.saveTokens({ idToken: "id", accessToken: "ac", expiresAtMs: Date.now() + 60_000 });
    expect(auth.getTokens()?.idToken).toBe("id");
    auth.saveTokens({ idToken: "id", accessToken: "ac", expiresAtMs: Date.now() - 1 });
    expect(auth.getTokens()).toBeUndefined();
  });

  it("exchangeCode は応答の refresh_token を保存する (D11)", async () => {
    const storage = new MemoryStorage();
    storage.setItem("stagecast.auth.oauth.state", "s");
    storage.setItem("stagecast.auth.pkce.verifier", "v");
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id_token: "id-1",
        access_token: "ac-1",
        expires_in: 21_600,
        refresh_token: "rt-1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = new CognitoAuthClient(config, storage);
    const tokens = await auth.exchangeCode("code", "s");

    expect(tokens.refreshToken).toBe("rt-1");
    expect(storage.getItem("stagecast.refreshToken")).toBe("rt-1");
  });

  it("期限が近いと refresh token で更新する (D11)", async () => {
    const storage = new MemoryStorage();
    const auth = new CognitoAuthClient(config, storage);
    // 残り 1 分 = リード時間 (5 分) を切っているので更新対象。
    auth.saveTokens({
      idToken: "old-id",
      accessToken: "old-ac",
      expiresAtMs: Date.now() + 60_000,
      refreshToken: "rt-1",
    });
    // リクエスト内容を検証するので引数の型を明示する (vi.fn(() => ...) だと calls が [] 型になる)。
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse({ id_token: "new-id", access_token: "new-ac", expires_in: 21_600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await auth.getValidToken();

    expect(tokens?.idToken).toBe("new-id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(fetchMock.mock.calls[0]?.[1].body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    expect(body.get("client_id")).toBe(config.clientId);
    // Cognito は更新応答に refresh_token を含めないので、既存のものを持ち越す。
    expect(storage.getItem("stagecast.refreshToken")).toBe("rt-1");
  });

  it("期限切れでも refresh token が生きていれば復帰する (D11)", async () => {
    const storage = new MemoryStorage();
    const auth = new CognitoAuthClient(config, storage);
    auth.saveTokens({
      idToken: "old-id",
      accessToken: "old-ac",
      expiresAtMs: Date.now() - 1,
      refreshToken: "rt-1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ id_token: "new-id", access_token: "new-ac", expires_in: 21_600 }),
      ),
    );

    expect(auth.getTokens()).toBeUndefined();
    expect((await auth.getValidToken())?.idToken).toBe("new-id");
  });

  it("期限に余裕があれば更新しない (D11)", async () => {
    const storage = new MemoryStorage();
    const auth = new CognitoAuthClient(config, storage);
    auth.saveTokens({
      idToken: "id",
      accessToken: "ac",
      expiresAtMs: Date.now() + 3_600_000,
      refreshToken: "rt-1",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect((await auth.getValidToken())?.idToken).toBe("id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("同時に呼ばれても更新リクエストは 1 回に畳む (single-flight)", async () => {
    const storage = new MemoryStorage();
    const auth = new CognitoAuthClient(config, storage);
    auth.saveTokens({
      idToken: "old",
      accessToken: "old",
      expiresAtMs: Date.now() - 1,
      refreshToken: "rt-1",
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id_token: "new-id", access_token: "new-ac", expires_in: 21_600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.all([
      auth.getValidToken(),
      auth.getValidToken(),
      auth.getValidToken(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r?.idToken)).toEqual(["new-id", "new-id", "new-id"]);
  });

  it("refresh token が失効 (4xx) していればトークンを捨てる", async () => {
    const storage = new MemoryStorage();
    const auth = new CognitoAuthClient(config, storage);
    auth.saveTokens({
      idToken: "id",
      accessToken: "ac",
      expiresAtMs: Date.now() - 1,
      refreshToken: "rt-dead",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 400)),
    );

    expect(await auth.getValidToken()).toBeUndefined();
    expect(storage.getItem("stagecast.refreshToken")).toBeNull();
  });

  it("Cognito 側の一時障害 (5xx) では refresh token を残す", async () => {
    const storage = new MemoryStorage();
    const auth = new CognitoAuthClient(config, storage);
    auth.saveTokens({
      idToken: "id",
      accessToken: "ac",
      expiresAtMs: Date.now() - 1,
      refreshToken: "rt-1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "internal" }, 500)),
    );

    expect(await auth.getValidToken()).toBeUndefined();
    expect(storage.getItem("stagecast.refreshToken")).toBe("rt-1");
  });

  it("ネットワーク断では更新を諦めるが期限内トークンは使い続ける", async () => {
    const storage = new MemoryStorage();
    const auth = new CognitoAuthClient(config, storage);
    // 残り 1 分。更新はしたいが、失敗しても期限内なので現行トークンで粘る。
    auth.saveTokens({
      idToken: "id",
      accessToken: "ac",
      expiresAtMs: Date.now() + 60_000,
      refreshToken: "rt-1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network error");
      }),
    );

    expect((await auth.getValidToken())?.idToken).toBe("id");
    expect(storage.getItem("stagecast.refreshToken")).toBe("rt-1");
  });

  it("refresh token を持っていなければ更新できない", async () => {
    const storage = new MemoryStorage();
    const auth = new CognitoAuthClient(config, storage);
    auth.saveTokens({ idToken: "id", accessToken: "ac", expiresAtMs: Date.now() - 1 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await auth.getValidToken()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ログインし直したら前のセッションの refresh token は残さない", async () => {
    const storage = new MemoryStorage();
    const auth = new CognitoAuthClient(config, storage);
    auth.saveTokens({
      idToken: "old",
      accessToken: "old",
      expiresAtMs: Date.now() - 1,
      refreshToken: "rt-old",
    });
    storage.setItem("stagecast.auth.oauth.state", "s");
    storage.setItem("stagecast.auth.pkce.verifier", "v");
    // refresh_token を返さない応答でも、古いものを引き継いではいけない。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id_token: "id", access_token: "ac", expires_in: 21_600 })),
    );

    await auth.exchangeCode("code", "s");

    expect(storage.getItem("stagecast.refreshToken")).toBeNull();
  });

  it("更新応答が壊れていても例外にせず更新失敗として扱う", async () => {
    const storage = new MemoryStorage();
    const auth = new CognitoAuthClient(config, storage);
    auth.saveTokens({
      idToken: "id",
      accessToken: "ac",
      expiresAtMs: Date.now() + 60_000,
      refreshToken: "rt-1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>not json</html>", { status: 200 })),
    );

    // 期限内なので現行トークンで粘る。reject させない (認証判定ごと落ちてしまうため)。
    expect((await auth.getValidToken())?.idToken).toBe("id");
  });

  it("clearTokens は refresh token も消す", () => {
    const storage = new MemoryStorage();
    const auth = new CognitoAuthClient(config, storage);
    auth.saveTokens({
      idToken: "id",
      accessToken: "ac",
      expiresAtMs: Date.now() + 60_000,
      refreshToken: "rt-1",
    });
    auth.clearTokens();
    expect(storage.getItem("stagecast.refreshToken")).toBeNull();
  });

  it("logout URL に client_id と logout_uri が載る", () => {
    const auth = new CognitoAuthClient(config, new MemoryStorage());
    const url = new URL(auth.buildLogoutUrl());
    expect(url.pathname).toBe("/logout");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("logout_uri")).toBe(config.logoutUri);
  });
});
