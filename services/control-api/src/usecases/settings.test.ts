import { describe, expect, it } from "vitest";
import { createSettingsService, type SecretsReader, type SecretsWriter } from "./settings.js";
import { ValidationError } from "./events.js";

function fakeStorage() {
  const store = new Map<string, Record<string, string>>();
  const reader: SecretsReader = {
    getSecretJson: async (id) => store.get(id) ?? {},
  };
  const writer: SecretsWriter = {
    putSecretJson: async (id, payload) => {
      store.set(id, { ...payload });
    },
  };
  return { store, reader, writer };
}

describe("SettingsService LiveKit (ADR 0008 D-7: URL 削除後)", () => {
  const livekitSecretArn = "arn:aws:secretsmanager:ap-northeast-1:1:secret:stagecast/livekit";

  it("初期 (空) は configured:false", async () => {
    const { reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    await expect(svc.getLiveKit()).resolves.toEqual({ configured: false });
  });

  it("ダミー初期値 (空文字) は configured:false", async () => {
    const { store, reader, writer } = fakeStorage();
    store.set(livekitSecretArn, { apiKey: "", apiSecret: "" });
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    await expect(svc.getLiveKit()).resolves.toEqual({ configured: false });
  });

  it("全フィールド設定済みなら configured:true (機密値は返さない)", async () => {
    const { reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    await svc.putLiveKit({ apiKey: "k", apiSecret: "s" });
    const result = await svc.getLiveKit();
    expect(result).toEqual({ configured: true });
    // 機密値はレスポンスに含まれない。
    expect(JSON.stringify(result)).not.toContain("apiKey");
    expect(JSON.stringify(result)).not.toContain("apiSecret");
  });

  it("PUT は apiKey/apiSecret のみを受け付ける (URL は受け付けない)", async () => {
    const { store, reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    await svc.putLiveKit({ apiKey: "k", apiSecret: "s" });
    expect(store.get(livekitSecretArn)).toEqual({ apiKey: "k", apiSecret: "s" });
  });

  it("どれか欠けたら 400 (ValidationError)", async () => {
    const { reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    await expect(svc.putLiveKit({ apiKey: "", apiSecret: "s" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("env が無いと操作不可 (ValidationError)", async () => {
    const { reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer }); // arn 未指定
    await expect(svc.getLiveKit()).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.putLiveKit({ apiKey: "k", apiSecret: "s" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(svc.regenerateLiveKit()).rejects.toBeInstanceOf(ValidationError);
  });

  it("regenerateLiveKit は API キー/シークレットを生成し configured:true を返す", async () => {
    const { store, reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    const result = await svc.regenerateLiveKit();
    expect(result).toEqual({ configured: true });
    const stored = store.get(livekitSecretArn);
    expect(stored?.apiKey).toMatch(/^API[\w-]{12,}$/);
    expect(stored!.apiSecret.length).toBeGreaterThanOrEqual(40);
    // ADR 0008: url フィールドは生成しない (per-event 化)。
    expect(stored).not.toHaveProperty("url");
  });

  it("regenerateLiveKit を 2 回呼ぶと毎回違う値になる", async () => {
    const { store, reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    await svc.regenerateLiveKit();
    const first = { ...store.get(livekitSecretArn)! };
    await svc.regenerateLiveKit();
    const second = store.get(livekitSecretArn)!;
    expect(second.apiKey).not.toBe(first.apiKey);
    expect(second.apiSecret).not.toBe(first.apiSecret);
  });
});

describe("SettingsService YouTube", () => {
  const youtubeSecretArn = "arn:aws:secretsmanager:ap-northeast-1:1:secret:stagecast/youtube";

  it("初期は configured:false", async () => {
    const { reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, youtubeSecretArn });
    await expect(svc.getYouTube()).resolves.toEqual({ configured: false });
  });

  it("全フィールド設定済みなら configured:true (機密は返さない)", async () => {
    const { reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, youtubeSecretArn });
    await svc.putYouTube({ apiKey: "K", oauthClientId: "id", oauthClientSecret: "sec" });
    await expect(svc.getYouTube()).resolves.toEqual({ configured: true });
  });

  it("どれか欠けたら 400 (ValidationError)", async () => {
    const { reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, youtubeSecretArn });
    await expect(
      svc.putYouTube({ apiKey: "K", oauthClientId: "", oauthClientSecret: "s" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("PUT 後の値は writer に保存されている", async () => {
    const { store, reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, youtubeSecretArn });
    await svc.putYouTube({ apiKey: "K", oauthClientId: "id", oauthClientSecret: "sec" });
    expect(store.get(youtubeSecretArn)).toEqual({
      apiKey: "K",
      oauthClientId: "id",
      oauthClientSecret: "sec",
    });
  });
});
