/**
 * SettingsPage 連携の end-to-end テスト (ADR D-10, ADR 0008 D-7)。
 *
 * LocalControlApiClient に SettingsService を注入した buildControlApi を渡して、
 * 「保存 → 状態取得」の往復が configured を返すことと、機密値が GET で漏れないことを確認する。
 * URL は per-event 化 (ADR 0008) により本ページからは扱わない。
 */
import { describe, expect, it } from "vitest";
import {
  buildControlApi,
  createSettingsService,
  type SecretsReader,
  type SecretsWriter,
} from "@stagecast/control-api";
import { LocalControlApiClient } from "./api/local-client.js";

const livekitArn = "arn:test:lk";
const youtubeArn = "arn:test:yt";

function buildClient() {
  const store = new Map<string, Record<string, string>>();
  const reader: SecretsReader = {
    getSecretJson: async (id) => store.get(id) ?? {},
  };
  const writer: SecretsWriter = {
    putSecretJson: async (id, payload) => {
      store.set(id, { ...payload });
    },
  };
  const settings = createSettingsService({
    reader,
    writer,
    livekitSecretArn: livekitArn,
    youtubeSecretArn: youtubeArn,
  });
  const app = buildControlApi({ inviteSecret: "local-dev-secret", settings });
  return { client: new LocalControlApiClient(app), store };
}

describe("admin-web SettingsPage 連携 (ADR D-10, ADR 0008)", () => {
  it("LiveKit を保存すると configured:true を返す (機密値・URL とも返らない)", async () => {
    const { client, store } = buildClient();
    expect(await client.getLiveKitSettings()).toEqual({ configured: false });

    const next = await client.putLiveKitSettings({ apiKey: "k", apiSecret: "s" });
    expect(next).toEqual({ configured: true });
    // 機密値も URL もレスポンスに含まれない。
    expect(JSON.stringify(next)).not.toContain("apiKey");
    expect(JSON.stringify(next)).not.toContain("apiSecret");
    expect(JSON.stringify(next)).not.toContain("url");

    expect(await client.getLiveKitSettings()).toEqual({ configured: true });

    // 書き込み済みストアには apiKey / apiSecret がある (url は無い)。
    const stored = store.get(livekitArn);
    expect(stored).toEqual({ apiKey: "k", apiSecret: "s" });
    expect(stored).not.toHaveProperty("url");
  });

  it("YouTube を保存すると configured:true (機密は GET で返らない)", async () => {
    const { client } = buildClient();
    expect(await client.getYouTubeSettings()).toEqual({ configured: false });

    const next = await client.putYouTubeSettings({
      apiKey: "K",
      oauthClientId: "id",
      oauthClientSecret: "sec",
    });
    expect(next).toEqual({ configured: true });

    expect(await client.getYouTubeSettings()).toEqual({ configured: true });
  });

  it("regenerateLiveKitKeys は機密値も URL も返さず configured を返す", async () => {
    const { client, store } = buildClient();
    const result = await client.regenerateLiveKitKeys();
    expect(result).toEqual({ configured: true });
    // クライアントが受け取るレスポンスには apiKey / apiSecret も url も含まれない。
    expect(JSON.stringify(result)).not.toContain("apiKey");
    expect(JSON.stringify(result)).not.toContain("apiSecret");
    expect(JSON.stringify(result)).not.toContain("url");
    // サーバ内部 (Secrets Manager) には実値が保存されている。
    const stored = store.get(livekitArn);
    expect(stored?.apiKey).toMatch(/^API/);
    expect(stored?.apiSecret.length).toBeGreaterThan(40);
    expect(stored).not.toHaveProperty("url");
  });
});
