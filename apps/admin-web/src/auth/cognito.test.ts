import { describe, expect, it } from "vitest";
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

  it("logout URL に client_id と logout_uri が載る", () => {
    const auth = new CognitoAuthClient(config, new MemoryStorage());
    const url = new URL(auth.buildLogoutUrl());
    expect(url.pathname).toBe("/logout");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("logout_uri")).toBe(config.logoutUri);
  });
});
