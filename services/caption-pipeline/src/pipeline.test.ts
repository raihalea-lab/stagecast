import { describe, expect, it } from "vitest";
import type { AudioChunk, CaptionEvent, CaptionSink } from "@stagecast/shared";
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

  it("sink delivery is resilient: transient failures retry, permanent failures don't crash (N-2)", async () => {
    class FlakySink implements CaptionSink {
      readonly kind: string;
      attempts = 0;
      readonly delivered: CaptionEvent[] = [];
      constructor(
        kind: string,
        private failuresLeft: number,
      ) {
        this.kind = kind;
      }
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async deliver(caption: CaptionEvent): Promise<void> {
        this.attempts += 1;
        if (this.failuresLeft > 0) {
          this.failuresLeft -= 1;
          throw new Error("transient");
        }
        this.delivered.push(caption);
      }
    }
    const recovering = new FlakySink("recovering", 2); // 2 回失敗 → 3 回目で成功
    const broken = new FlakySink("broken", Number.POSITIVE_INFINITY); // 常に失敗
    const engine = new TranscribeStreamingEngine(
      new FakeAsrAdapter("en", [{ startMs: 0, endMs: 500, text: "hi", isFinal: true }]),
      new FakeTranslator(),
      { sourceLanguage: "en", targetLanguages: ["en"], eventId: "evt-r" },
    );
    const pipeline = new CaptionPipeline({
      bus: new InProcessCaptionBus(),
      engine,
      sinks: [recovering, broken],
      // テストは実時間を待たない。
      sinkRetry: { retries: 3, sleep: async () => {} },
    });

    await pipeline.start();
    // broken が全リトライ失敗しても pushAudio は reject しない (best-effort)。
    await pipeline.pushAudio(chunk);
    await pipeline.stop();

    // recovering は再試行で最終的に 1 件配信。
    expect(recovering.delivered).toHaveLength(1);
    expect(recovering.attempts).toBe(3);
    // broken は初回 + 3 再試行 = 4 回試行し、配信は 0。パイプラインは継続。
    expect(broken.attempts).toBe(4);
    expect(broken.delivered).toHaveLength(0);
  });

  it("一過性失敗は observeSinkRetry、全滅は observeSinkError を計測する (可観測性)", async () => {
    class FlakySink implements CaptionSink {
      readonly kind = "flaky";
      private failuresLeft = 2;
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async deliver(): Promise<void> {
        if (this.failuresLeft > 0) {
          this.failuresLeft -= 1;
          throw new Error("transient");
        }
      }
    }
    const retries: string[] = [];
    const errors: string[] = [];
    const metrics = {
      observeCaption() {},
      observeSinkRetry(kind: string) {
        retries.push(kind);
      },
      observeSinkError(kind: string) {
        errors.push(kind);
      },
    } as unknown as import("./metrics.js").CaptionMetricsCollector;
    const engine = new TranscribeStreamingEngine(
      new FakeAsrAdapter("en", [{ startMs: 0, endMs: 500, text: "hi", isFinal: true }]),
      new FakeTranslator(),
      { sourceLanguage: "en", targetLanguages: ["en"], eventId: "evt-m" },
    );
    const pipeline = new CaptionPipeline({
      bus: new InProcessCaptionBus(),
      engine,
      sinks: [new FlakySink()],
      metrics,
      sinkRetry: { sleep: async () => {} },
    });
    await pipeline.start();
    await pipeline.pushAudio(chunk);
    await pipeline.stop();

    expect(retries).toEqual(["flaky", "flaky"]); // 2 回再試行で回復
    expect(errors).toEqual([]); // 最終的に成功 → エラー計測なし
  });

  it("固まった Sink は sinkTimeoutMs で打ち切られ drain がハングしない (耐ハング)", async () => {
    // deliver が永遠に解決しない Sink。タイムアウトが無ければ pushAudio/drain が固まる。
    class HangingSink implements CaptionSink {
      readonly kind = "hanging";
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async deliver(): Promise<void> {
        return new Promise<void>(() => {}); // 決して解決しない
      }
    }
    const errors: string[] = [];
    const metrics = {
      observeCaption() {},
      observeSinkRetry() {},
      observeSinkError(kind: string) {
        errors.push(kind);
      },
    } as unknown as import("./metrics.js").CaptionMetricsCollector;
    const engine = new TranscribeStreamingEngine(
      new FakeAsrAdapter("en", [{ startMs: 0, endMs: 500, text: "hi", isFinal: true }]),
      new FakeTranslator(),
      { sourceLanguage: "en", targetLanguages: ["en"], eventId: "evt-h" },
    );
    const pipeline = new CaptionPipeline({
      bus: new InProcessCaptionBus(),
      engine,
      sinks: [new HangingSink()],
      metrics,
      sinkTimeoutMs: 5,
      sinkRetry: { retries: 1, sleep: async () => {} },
    });

    await pipeline.start();
    // タイムアウトが効くので pushAudio は固まらずに返る。
    await pipeline.pushAudio(chunk);
    await pipeline.stop();

    // 初回 + 1 再試行ともタイムアウト → 最終的に observeSinkError を 1 回計上。
    expect(errors).toEqual(["hanging"]);
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
