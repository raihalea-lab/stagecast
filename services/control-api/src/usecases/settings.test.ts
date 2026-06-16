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

describe("SettingsService LiveKit", () => {
  const livekitSecretArn = "arn:aws:secretsmanager:ap-northeast-1:1:secret:stagecast/livekit";

  it("初期 (空) は configured:false", async () => {
    const { reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    await expect(svc.getLiveKit()).resolves.toEqual({ configured: false });
  });

  it("ダミー初期値 (空文字) は configured:false (空文字は未設定扱い)", async () => {
    const { store, reader, writer } = fakeStorage();
    store.set(livekitSecretArn, { url: "", apiKey: "", apiSecret: "" });
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    await expect(svc.getLiveKit()).resolves.toEqual({ configured: false });
  });

  it("全フィールド設定済みなら configured:true + url を返す", async () => {
    const { reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    await svc.putLiveKit({
      url: "wss://livekit.example.com",
      apiKey: "k",
      apiSecret: "s",
    });
    await expect(svc.getLiveKit()).resolves.toEqual({
      configured: true,
      url: "wss://livekit.example.com",
    });
  });

  it("URL が wss:// / ws:// 以外なら 400 (ValidationError)", async () => {
    const { reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    await expect(
      svc.putLiveKit({ url: "https://example.com", apiKey: "k", apiSecret: "s" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("どれか欠けたら 400 (ValidationError)", async () => {
    const { reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    await expect(
      svc.putLiveKit({ url: "wss://x", apiKey: "", apiSecret: "s" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("env が無いと操作不可 (ValidationError)", async () => {
    const { reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer }); // arn 未指定
    await expect(svc.getLiveKit()).rejects.toBeInstanceOf(ValidationError);
    await expect(
      svc.putLiveKit({ url: "wss://x", apiKey: "k", apiSecret: "s" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.regenerateLiveKit()).rejects.toBeInstanceOf(ValidationError);
  });

  it("regenerateLiveKit は API キー/シークレットを生成し URL を保持する", async () => {
    const { store, reader, writer } = fakeStorage();
    store.set(livekitSecretArn, { url: "wss://kept.example.com", apiKey: "old", apiSecret: "old" });
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    const result = await svc.regenerateLiveKit();
    expect(result).toEqual({ configured: true, url: "wss://kept.example.com" });
    const stored = store.get(livekitSecretArn);
    expect(stored?.url).toBe("wss://kept.example.com");
    expect(stored?.apiKey).toMatch(/^API[\w-]{12,}$/); // base64url 12 chars after prefix
    expect(stored?.apiKey).not.toBe("old");
    expect(stored?.apiSecret).not.toBe("old");
    expect(stored!.apiSecret.length).toBeGreaterThanOrEqual(40); // 32 bytes ≒ 43 chars
  });

  it("regenerateLiveKit を URL 未設定で呼ぶと configured:false を返す (鍵は生成される)", async () => {
    const { store, reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    const result = await svc.regenerateLiveKit();
    expect(result).toEqual({ configured: false });
    expect(store.get(livekitSecretArn)?.apiKey).toMatch(/^API/);
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

  it("patchLiveKitUrl は URL のみ更新し既存の鍵を保持する", async () => {
    const { store, reader, writer } = fakeStorage();
    store.set(livekitSecretArn, {
      url: "wss://old.example.com",
      apiKey: "kept-key",
      apiSecret: "kept-sec",
    });
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    const result = await svc.patchLiveKitUrl({ url: "wss://new.example.com" });
    expect(result).toEqual({ configured: true, url: "wss://new.example.com" });
    expect(store.get(livekitSecretArn)).toEqual({
      url: "wss://new.example.com",
      apiKey: "kept-key",
      apiSecret: "kept-sec",
    });
  });

  it("patchLiveKitUrl は鍵が無くても URL を保存する (configured:false)", async () => {
    const { store, reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    const result = await svc.patchLiveKitUrl({ url: "wss://x.example.com" });
    expect(result).toEqual({ configured: false });
    expect(store.get(livekitSecretArn)?.url).toBe("wss://x.example.com");
  });

  it("patchLiveKitUrl の URL バリデーションは PUT と同じ (wss:// / ws:// 以外は 400)", async () => {
    const { reader, writer } = fakeStorage();
    const svc = createSettingsService({ reader, writer, livekitSecretArn });
    await expect(svc.patchLiveKitUrl({ url: "https://x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.patchLiveKitUrl({ url: "" })).rejects.toBeInstanceOf(ValidationError);
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
    await svc.putYouTube({
      apiKey: "K",
      oauthClientId: "id",
      oauthClientSecret: "sec",
    });
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
    await svc.putYouTube({
      apiKey: "K",
      oauthClientId: "id",
      oauthClientSecret: "sec",
    });
    expect(store.get(youtubeSecretArn)).toEqual({
      apiKey: "K",
      oauthClientId: "id",
      oauthClientSecret: "sec",
    });
  });
});
