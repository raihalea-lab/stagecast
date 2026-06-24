import { describe, expect, it } from "vitest";
import type { CaptionSettings } from "@stagecast/shared";
import { buildControlApiFromEnv, type SecretsResolver } from "./lambda.js";
import type { SecretsWriter } from "./usecases/settings.js";

class FakeSecretsResolver implements SecretsResolver {
  constructor(private readonly map: Record<string, Record<string, string>>) {}
  async getSecretJson(secretId: string): Promise<Record<string, string>> {
    const v = this.map[secretId];
    if (!v) throw new Error(`unknown secret ${secretId}`);
    return v;
  }
}

class FakeSecretsWriter implements SecretsWriter {
  constructor(public readonly map: Record<string, Record<string, string>> = {}) {}
  async putSecretJson(secretId: string, payload: Record<string, string>): Promise<void> {
    this.map[secretId] = { ...payload };
  }
}

const caption: CaptionSettings = {
  languages: ["ja", "en"],
  youtubeLanguage: "ja",
  engine: "transcribe",
  customApiEnabled: false,
};
const adminAuth = { authorization: "Bearer fake:admin:admin@example.com" };

describe("buildControlApiFromEnv (T5 / T7)", () => {
  it("Secrets Manager ARN から招待トークン秘密を解決し、発行/検証が往復する", async () => {
    const secrets = new FakeSecretsResolver({
      "arn:invite": { secret: "from-secrets-manager" },
    });
    const app = await buildControlApiFromEnv({
      secrets,
      env: { INVITE_TOKEN_SECRET_ARN: "arn:invite" },
    });
    const created = await app.handle({
      method: "POST",
      path: "/events",
      headers: adminAuth,
      body: { title: "E", startsAt: "2026-07-01", caption },
    });
    expect(created.status).toBe(201);
    const { id } = created.body as { id: string };
    const issued = await app.handle({
      method: "POST",
      path: `/events/${id}/invites`,
      headers: adminAuth,
      body: { role: "moderator", ttlSec: 3600 },
    });
    expect(issued.status).toBe(201);
    const { token } = issued.body as { token: string };
    const verify = await app.handle({
      method: "POST",
      path: "/invites/verify",
      headers: {},
      body: { token },
    });
    expect(verify.status).toBe(200);
  });

  it("ARN が無ければ INVITE_TOKEN_SECRET をそのまま使う", async () => {
    const app = await buildControlApiFromEnv({
      secrets: new FakeSecretsResolver({}),
      env: { INVITE_TOKEN_SECRET: "plain-env-secret" },
    });
    const created = await app.handle({
      method: "POST",
      path: "/events",
      headers: adminAuth,
      body: { title: "E", startsAt: "2026-07-01", caption },
    });
    expect(created.status).toBe(201);
  });

  it("Cognito 設定が無ければ Fake 認証で起動する (ローカル/テスト互換)", async () => {
    const app = await buildControlApiFromEnv({
      secrets: new FakeSecretsResolver({}),
      env: {},
    });
    const res = await app.handle({
      method: "GET",
      path: "/events",
      headers: adminAuth,
    });
    expect(res.status).toBe(200);
  });

  it("Cognito 設定があれば JWT 検証器を選ぶ (構築のみ確認)", async () => {
    const app = await buildControlApiFromEnv({
      secrets: new FakeSecretsResolver({}),
      env: {
        COGNITO_USER_POOL_ID: "us-east-1_XYZ",
        COGNITO_USER_POOL_CLIENT_ID: "abc123",
      },
    });
    // 公開ルートは認証なしで通過する。
    const res = await app.handle({
      method: "POST",
      path: "/invites/verify",
      headers: {},
      body: { token: "invalid" },
    });
    expect(res.status).toBe(401); // verify は valid:false で 401 を返す
  });

  it("LiveKit Secret から minter を構築する", async () => {
    const secrets = new FakeSecretsResolver({
      "arn:lk": { url: "wss://lk.example", apiKey: "k", apiSecret: "s" },
    });
    const app = await buildControlApiFromEnv({
      secrets,
      env: { LIVEKIT_SECRET_ARN: "arn:lk" },
    });
    expect(app).toBeDefined();
  });

  it("LiveKit Secret の値が空なら minter を作らない (運用者が後で値を更新する想定)", async () => {
    const secrets = new FakeSecretsResolver({
      "arn:lk": { url: "", apiKey: "", apiSecret: "" },
    });
    const app = await buildControlApiFromEnv({
      secrets,
      env: { LIVEKIT_SECRET_ARN: "arn:lk" },
    });
    expect(app).toBeDefined();
  });

  it("LIVEKIT_SECRET_ARN / YOUTUBE_SECRET_ARN があれば SettingsService を配線する", async () => {
    const secrets = new FakeSecretsResolver({
      "arn:lk": { url: "", apiKey: "", apiSecret: "" },
      "arn:yt": { apiKey: "", oauthClientId: "", oauthClientSecret: "" },
    });
    const writer = new FakeSecretsWriter();
    const app = await buildControlApiFromEnv({
      secrets,
      secretsWriter: writer,
      env: { LIVEKIT_SECRET_ARN: "arn:lk", YOUTUBE_SECRET_ARN: "arn:yt" },
    });
    const res = await app.handle({
      method: "PUT",
      path: "/settings/youtube",
      headers: adminAuth,
      body: { apiKey: "K", oauthClientId: "id", oauthClientSecret: "sec" },
    });
    expect(res.status).toBe(200);
    expect(writer.map["arn:yt"]).toEqual({
      apiKey: "K",
      oauthClientId: "id",
      oauthClientSecret: "sec",
    });
  });

  it("Secret ARN が無ければ SettingsService を作らず /settings は 503", async () => {
    const secrets = new FakeSecretsResolver({});
    const app = await buildControlApiFromEnv({ secrets, env: {} });
    const res = await app.handle({
      method: "GET",
      path: "/settings/livekit",
      headers: adminAuth,
    });
    expect(res.status).toBe(503);
  });
});
