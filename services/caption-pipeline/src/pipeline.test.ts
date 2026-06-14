import { describe, expect, it } from "vitest";
import type { AudioChunk } from "@stagecast/shared";
import { InProcessCaptionBus } from "./bus.js";
import { CaptionPipeline } from "./pipeline.js";
import { TranscribeStreamingEngine } from "./engines/transcribe-engine.js";
import { LLMEngine } from "./engines/llm-engine.js";
import { FakeAsrAdapter, FakeLlmAdapter, FakeTranslator } from "./engines/fakes.js";
import { FakeYouTubeCaptionPublisher, YouTubeCaptionSink } from "./sinks/youtube-sink.js";
import { CustomCaptionApiSink, FakeCaptionBroadcaster } from "./sinks/custom-api-sink.js";
import { CaptionStore, InMemoryObjectStorage } from "./store/caption-store.js";

const chunk: AudioChunk = { data: new Uint8Array([1]), timestampMs: 0, sampleRate: 16000 };

function buildSinksAndStore() {
  const youtube = new FakeYouTubeCaptionPublisher();
  const broadcaster = new FakeCaptionBroadcaster();
  const storage = new InMemoryObjectStorage();
  const store = new CaptionStore(storage, { eventId: "evt-1" });
  const sinks = [
    // 常用: 確定字幕を 1 言語 (ja) だけ YouTube へ (6.3.1)
    new YouTubeCaptionSink(youtube, "ja"),
    // 任意起動: 全対応言語を独自 API へ (6.3.2)
    new CustomCaptionApiSink(broadcaster, { languages: ["ja", "en"], eventId: "evt-1" }),
  ];
  return { youtube, broadcaster, storage, store, sinks };
}

describe("CaptionPipeline end-to-end (DESIGN.md 6 章)", () => {
  it("audio → ja/en captions → both sinks; YouTube gets only final ja, custom gets all", async () => {
    const { youtube, broadcaster, store, storage, sinks } = buildSinksAndStore();
    const asr = new FakeAsrAdapter("ja", [
      { startMs: 0, endMs: 800, text: "やあ", isFinal: false },
      { startMs: 0, endMs: 1000, text: "こんにちは", isFinal: true },
    ]);
    const engine = new TranscribeStreamingEngine(
      asr,
      new FakeTranslator({ "en:こんにちは": "Hello", "en:やあ": "Hi" }),
      { sourceLanguage: "ja", targetLanguages: ["ja", "en"], eventId: "evt-1" },
    );
    const pipeline = new CaptionPipeline({ bus: new InProcessCaptionBus(), engine, sinks, store });

    await pipeline.start();
    await pipeline.pushAudio(chunk); // interim やあ/Hi
    await pipeline.pushAudio(chunk); // final こんにちは/Hello
    const savedKeys = await pipeline.stop();

    // YouTube: 確定 ja のみ (暫定や en は送らない)
    expect(youtube.published).toHaveLength(1);
    expect(youtube.published[0]).toMatchObject({
      language: "ja",
      text: "こんにちは",
      status: "final",
    });

    // 独自 API: 全対応言語・確定/暫定すべて (ja x2 + en x2 = 4)
    expect(broadcaster.messages).toHaveLength(4);
    expect(broadcaster.messages.filter((m) => m.language === "en").map((m) => m.text)).toEqual([
      "Hi",
      "Hello",
    ]);
    expect(broadcaster.messages.every((m) => m.v === 1 && m.type === "caption")).toBe(true);

    // S3 保存: 確定字幕のみ SRT/VTT で保存
    expect(savedKeys).toContain("captions/evt-1/ja.srt");
    expect(await storage.get("captions/evt-1/en.srt")).toContain("Hello");
  });

  it("engine is swappable: same sinks work with the LLM engine (F-8)", async () => {
    const { youtube, broadcaster, sinks } = buildSinksAndStore();
    const engine = new LLMEngine(
      new FakeLlmAdapter([{ startMs: 0, endMs: 900, text: "おはよう", isFinal: true }], {
        "en:おはよう": "Good morning",
      }),
      {
        sourceLanguage: "ja",
        targetLanguages: ["ja", "en"],
        mode: "asr+translate",
        eventId: "evt-1",
      },
    );
    const pipeline = new CaptionPipeline({ bus: new InProcessCaptionBus(), engine, sinks });

    await pipeline.start();
    await pipeline.pushAudio(chunk);
    await pipeline.stop();

    expect(youtube.published).toHaveLength(1);
    expect(youtube.published[0]?.text).toBe("おはよう");
    expect(broadcaster.messages.find((m) => m.language === "en")?.text).toBe("Good morning");
  });

  it("sink is swappable: dropping the custom sink leaves only the YouTube path", async () => {
    const youtube = new FakeYouTubeCaptionPublisher();
    const engine = new TranscribeStreamingEngine(
      new FakeAsrAdapter("en", [{ startMs: 0, endMs: 500, text: "hello", isFinal: true }]),
      new FakeTranslator(),
      { sourceLanguage: "en", targetLanguages: ["en"], eventId: "evt-2" },
    );
    const pipeline = new CaptionPipeline({
      bus: new InProcessCaptionBus(),
      engine,
      sinks: [new YouTubeCaptionSink(youtube, "en")],
    });
    await pipeline.start();
    await pipeline.pushAudio(chunk);
    await pipeline.stop();
    expect(youtube.published).toHaveLength(1);
  });
});
