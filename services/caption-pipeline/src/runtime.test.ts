import { describe, expect, it } from "vitest";
import type { AudioChunk } from "@stagecast/shared";
import {
  assembleCaptionPipeline,
  createCaptionWorker,
  selectEngine,
  selectSinks,
  type CaptionRuntimeConfig,
} from "./runtime.js";
import { FakeAsrAdapter, FakeLlmAdapter, FakeTranslator } from "./engines/fakes.js";
import { FakeYouTubeCaptionPublisher } from "./sinks/youtube-sink.js";
import { FakeCaptionBroadcaster } from "./sinks/custom-api-sink.js";
import { InMemoryObjectStorage } from "./store/caption-store.js";
import { CaptionMetricsCollector, InMemoryMetricsSink } from "./metrics.js";
import { attachConnection, type WebSocketLike } from "./sinks/ws-server.js";
import type { ServerMessage } from "./sinks/caption-hub.js";

const baseConfig: CaptionRuntimeConfig = {
  eventId: "evt-1",
  sourceLanguage: "ja",
  languages: ["ja", "en"],
  engine: "transcribe",
  youtubeLanguage: "ja",
  customApiEnabled: true,
};

const chunk: AudioChunk = { data: new Uint8Array([1]), timestampMs: 0, sampleRate: 16000 };

describe("caption runtime assembly (DESIGN.md 6 章, 8 章)", () => {
  it("selects the engine by config.engine kind (F-8)", () => {
    expect(
      selectEngine(baseConfig, {
        asr: new FakeAsrAdapter("ja", []),
        translator: new FakeTranslator(),
      }).kind,
    ).toBe("transcribe");
    expect(selectEngine({ ...baseConfig, engine: "llm" }, { llm: new FakeLlmAdapter() }).kind).toBe(
      "llm",
    );
    expect(selectEngine({ ...baseConfig, engine: "self-hosted-asr" }, {}).kind).toBe(
      "self-hosted-asr",
    );
  });

  it("throws when a required provider is missing", () => {
    expect(() => selectEngine(baseConfig, {})).toThrow(/transcribe engine requires/);
    expect(() => selectEngine({ ...baseConfig, engine: "llm" }, {})).toThrow(/llm engine requires/);
  });

  it("selects sinks based on youtubeLanguage and customApiEnabled (6.3)", () => {
    const providers = {
      youtubePublisher: new FakeYouTubeCaptionPublisher(),
      broadcaster: new FakeCaptionBroadcaster(),
    };
    expect(selectSinks(baseConfig, providers).map((s) => s.kind)).toEqual([
      "youtube",
      "custom-api",
    ]);
    expect(
      selectSinks({ ...baseConfig, customApiEnabled: false }, providers).map((s) => s.kind),
    ).toEqual(["youtube"]);
    expect(
      selectSinks({ ...baseConfig, youtubeLanguage: undefined }, providers).map((s) => s.kind),
    ).toEqual(["custom-api"]);
  });

  it("assembles a working pipeline end-to-end from config", async () => {
    const youtube = new FakeYouTubeCaptionPublisher();
    const broadcaster = new FakeCaptionBroadcaster();
    const storage = new InMemoryObjectStorage();
    const pipeline = assembleCaptionPipeline(baseConfig, {
      asr: new FakeAsrAdapter("ja", [
        { startMs: 0, endMs: 1000, text: "こんにちは", isFinal: true },
      ]),
      translator: new FakeTranslator({ "en:こんにちは": "Hello" }),
      youtubePublisher: youtube,
      broadcaster,
      storage,
    });

    await pipeline.start();
    await pipeline.pushAudio(chunk);
    const saved = await pipeline.stop();

    expect(youtube.published.map((c) => c.text)).toEqual(["こんにちは"]); // 確定 ja
    expect(broadcaster.messages.find((m) => m.language === "en")?.text).toBe("Hello");
    expect(saved).toContain("captions/evt-1/ja.srt");
  });

  it("注入したメトリクスで字幕件数と翻訳失敗を計測する (T9)", async () => {
    const sink = new InMemoryMetricsSink();
    const metrics = new CaptionMetricsCollector({ eventId: "evt-1", sink, now: () => 0 });
    const failingTranslator = {
      translate: async (_t: string, _s: string, _target: string): Promise<string> => {
        throw new Error("translate down");
      },
    };
    const pipeline = assembleCaptionPipeline(
      { ...baseConfig, youtubeLanguage: undefined, customApiEnabled: false },
      {
        asr: new FakeAsrAdapter("ja", [{ startMs: 0, endMs: 1000, text: "やあ", isFinal: true }]),
        translator: failingTranslator,
        metrics,
      },
    );

    await pipeline.start();
    await pipeline.pushAudio(chunk);
    await pipeline.stop();

    // ソース ja は発行され計測、en は全リトライ失敗で TranslateErrors を計上。
    const published = sink.records.filter((r) =>
      r.metrics.some((m) => m.name === "CaptionsPublished"),
    );
    expect(published.map((r) => r.dimensions.Language)).toEqual(["ja"]);
    const translateErrors = sink.records.filter((r) =>
      r.metrics.some((m) => m.name === "TranslateErrors"),
    );
    expect(translateErrors.map((r) => r.dimensions.Language)).toEqual(["en"]);
  });

  it("CaptionWorker delivers captions to a WebSocket client via the hub (end-to-end)", async () => {
    // 独自字幕 API 有効。worker が hub を用意し、pipeline と接続する。
    const worker = createCaptionWorker(baseConfig, {
      asr: new FakeAsrAdapter("ja", [{ startMs: 0, endMs: 1000, text: "おはよう", isFinal: true }]),
      translator: new FakeTranslator({ "en:おはよう": "Good morning" }),
    });
    expect(worker.hub).toBeDefined();

    // ws クライアントをハブに接続し ja/en を購読
    const received: ServerMessage[] = [];
    const socket: WebSocketLike = {
      send: (data) => received.push(JSON.parse(data)),
      close: () => {},
      on: () => {},
    };
    attachConnection(worker.hub!, socket, { id: "viewer-1", languages: ["ja", "en"] });

    await worker.start();
    await worker.pushAudio(chunk);
    await worker.stop();

    const captions = received.filter((m): m is Extract<ServerMessage, { type: "caption" }> => {
      return m.type === "caption";
    });
    expect(captions.find((c) => c.language === "ja")?.text).toBe("おはよう");
    expect(captions.find((c) => c.language === "en")?.text).toBe("Good morning");
  });
});
