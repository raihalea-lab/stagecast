import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AudioChunk } from "@stagecast/shared";
import {
  CaptionService,
  configFromEnv,
  FakeAudioSource,
  type CaptionServiceConfig,
} from "./bootstrap.js";
import { FakeAsrAdapter, FakeTranslator } from "./engines/fakes.js";

const chunk: AudioChunk = { data: new Uint8Array([1]), timestampMs: 0, sampleRate: 16000 };

function baseConfig(overrides: Partial<CaptionServiceConfig> = {}): CaptionServiceConfig {
  return {
    eventId: "evt-1",
    sourceLanguage: "ja",
    languages: ["ja", "en"],
    engine: "transcribe",
    customApiEnabled: true,
    wsPort: 0, // エフェメラルポート
    ...overrides,
  };
}

function fakeProviders() {
  return {
    asr: new FakeAsrAdapter("ja", [{ startMs: 0, endMs: 1000, text: "こんにちは", isFinal: true }]),
    translator: new FakeTranslator({ "en:こんにちは": "Hello" }),
  };
}

describe("configFromEnv", () => {
  it("parses caption settings from environment variables", () => {
    const cfg = configFromEnv({
      STAGECAST_EVENT_ID: "evt-9",
      CAPTION_LANGUAGES: "ja,en",
      CAPTION_SOURCE_LANGUAGE: "ja",
      CAPTION_ENGINE: "llm",
      YOUTUBE_CAPTION_LANGUAGE: "ja",
      CUSTOM_CAPTION_API: "true",
      CAPTION_WS_PORT: "9001",
    } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({
      eventId: "evt-9",
      engine: "llm",
      youtubeLanguage: "ja",
      customApiEnabled: true,
      wsPort: 9001,
    });
  });
});

describe("CaptionService over a real WebSocket server (DESIGN.md 6.3.2, ADR 0003)", () => {
  it("serves captions to a real ws client on an ephemeral port end-to-end", async () => {
    const service = new CaptionService(baseConfig(), fakeProviders());
    await service.start();
    const port = service.wsPort;
    expect(typeof port).toBe("number");

    const client = new WebSocket(`ws://127.0.0.1:${port}/?lang=ja,en`);
    const messages: { type: string; language?: string; text?: string }[] = [];
    const gotBoth = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 3000);
      client.on("message", (data) => {
        messages.push(JSON.parse(data.toString()));
        const langs = messages.filter((m) => m.type === "caption").map((m) => m.language);
        if (langs.includes("ja") && langs.includes("en")) {
          clearTimeout(timer);
          resolve();
        }
      });
      client.on("error", reject);
    });

    await new Promise<void>((resolve) => client.on("open", () => resolve()));
    // welcome を受けてから音声投入 (確定字幕はバックログにも積まれる)
    await service.pushAudio(chunk);
    await gotBoth;

    const captions = messages.filter((m) => m.type === "caption");
    expect(captions.find((c) => c.language === "ja")?.text).toBe("こんにちは");
    expect(captions.find((c) => c.language === "en")?.text).toBe("Hello");
    expect(messages[0]?.type).toBe("welcome");

    client.close();
    await service.stop();
  });

  it("runs without a ws server when the custom API is disabled", async () => {
    const service = new CaptionService(baseConfig({ customApiEnabled: false }), fakeProviders());
    await service.start();
    expect(service.wsPort).toBeUndefined();
    await service.pushAudio(chunk);
    await service.stop();
  });

  it("drives audio from an AudioSource", async () => {
    const service = new CaptionService(
      baseConfig({ customApiEnabled: false }),
      fakeProviders(),
      new FakeAudioSource([chunk]),
    );
    await service.start();
    // FakeAudioSource は start で台本を流す。停止して完了を確認。
    const keys = await service.stop();
    expect(Array.isArray(keys)).toBe(true);
  });
});
