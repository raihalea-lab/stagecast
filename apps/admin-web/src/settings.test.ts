/**
 * SettingsPage 連携の end-to-end テスト (ADR D-10)。
 *
 * LocalControlApiClient に SettingsService を注入した buildControlApi を渡して、
 * 「保存 → 状態取得」の往復が configured を返すことと、機密値が GET で漏れないことを確認する。
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

describe("admin-web SettingsPage 連携 (ADR D-10)", () => {
  it("LiveKit を保存すると configured:true + url を返す (機密は返らない)", async () => {
    const { client, store } = buildClient();
    expect(await client.getLiveKitSettings()).toEqual({ configured: false });

    const next = await client.putLiveKitSettings({
      url: "wss://lk.example.com",
      apiKey: "k",
      apiSecret: "s",
    });
    expect(next).toEqual({ configured: true, url: "wss://lk.example.com" });

    // GET でも同じ (機密は返らない)。
    const get = await client.getLiveKitSettings();
    expect(get).toEqual({ configured: true, url: "wss://lk.example.com" });

    // 書き込み済みストアには全フィールドがある (server 内部のみ)。
    expect(store.get(livekitArn)).toEqual({
      url: "wss://lk.example.com",
      apiKey: "k",
      apiSecret: "s",
    });
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

  it("LiveKit URL が wss:// 以外なら API がエラーを返す", async () => {
    const { client } = buildClient();
    await expect(
      client.putLiveKitSettings({
        url: "https://lk.example.com",
        apiKey: "k",
        apiSecret: "s",
      }),
    ).rejects.toThrow();
  });
});
