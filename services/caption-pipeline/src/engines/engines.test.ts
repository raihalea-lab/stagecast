import { describe, expect, it } from "vitest";
import type { AudioChunk, CaptionEvent } from "@stagecast/shared";
import { TranscribeStreamingEngine } from "./transcribe-engine.js";
import { LLMEngine } from "./llm-engine.js";
import { SelfHostedAsrEngine } from "./self-hosted.js";
import { FakeAsrAdapter, FakeLlmAdapter, FakeTranslator } from "./fakes.js";

const chunk: AudioChunk = { data: new Uint8Array([0]), timestampMs: 0, sampleRate: 16000 };

describe("TranscribeStreamingEngine (常用・低遅延経路)", () => {
  it("emits source + translated captions for each segment (F-7, F-8)", async () => {
    const asr = new FakeAsrAdapter("ja", [
      { startMs: 0, endMs: 1000, text: "こんにちは", isFinal: true, speakerId: "spk-1" },
    ]);
    const engine = new TranscribeStreamingEngine(
      asr,
      new FakeTranslator({ "en:こんにちは": "Hello" }),
      {
        sourceLanguage: "ja",
        targetLanguages: ["ja", "en"],
        eventId: "evt-1",
      },
    );
    const out: CaptionEvent[] = [];
    engine.onCaption((c) => out.push(c));
    await engine.start();
    await engine.pushAudio(chunk);

    expect(out).toHaveLength(2); // ja (source) + en (translated); ja target は重複除外
    expect(out.find((c) => c.language === "ja")?.text).toBe("こんにちは");
    expect(out.find((c) => c.language === "en")?.text).toBe("Hello");
    expect(out.every((c) => c.status === "final" && c.speakerId === "spk-1")).toBe(true);
  });
});

describe("LLMEngine (品質重視経路)", () => {
  it("does ASR + translate from audio", async () => {
    const llm = new FakeLlmAdapter(
      [{ startMs: 0, endMs: 900, text: "good morning", isFinal: true }],
      { "ja:good morning": "おはよう" },
    );
    const engine = new LLMEngine(llm, {
      sourceLanguage: "en",
      targetLanguages: ["ja"],
      mode: "asr+translate",
    });
    const out: CaptionEvent[] = [];
    engine.onCaption((c) => out.push(c));
    await engine.start();
    await engine.pushAudio(chunk);

    expect(out.find((c) => c.language === "en")?.text).toBe("good morning");
    expect(out.find((c) => c.language === "ja")?.text).toBe("おはよう");
  });

  it("translate-only mode accepts finalized source text", async () => {
    const engine = new LLMEngine(new FakeLlmAdapter([], { "en:確定テキスト": "final text" }), {
      sourceLanguage: "ja",
      targetLanguages: ["en"],
      mode: "translate-only",
    });
    const out: CaptionEvent[] = [];
    engine.onCaption((c) => out.push(c));
    await engine.start();
    await engine.pushText({ text: "確定テキスト", startMs: 0, endMs: 500, isFinal: true });
    expect(out.find((c) => c.language === "en")?.text).toBe("final text");
  });
});

describe("SelfHostedAsrEngine (拡張ポイント)", () => {
  it("exposes the common interface but is not implemented yet", async () => {
    const engine = new SelfHostedAsrEngine({
      sourceLanguage: "ja",
      targetLanguages: ["en"],
      modelEndpoint: "http://gpu.local",
    });
    expect(engine.kind).toBe("self-hosted-asr");
    await expect(engine.start()).rejects.toThrow(/not yet implemented/);
  });
});
