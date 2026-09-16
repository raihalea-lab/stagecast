import { describe, expect, it } from "vitest";
import type { AudioChunk, CaptionEvent } from "@stagecast/shared";
import { TranscribeStreamingEngine } from "./transcribe-engine.js";
import { LLMEngine } from "./llm-engine.js";
import { SelfHostedAsrEngine } from "./self-hosted.js";
import { FakeAsrAdapter, FakeLlmAdapter, FakeTranslator } from "./fakes.js";
import type { LlmAdapter } from "./types.js";

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

  it("翻訳の一過性失敗は再試行で回復する (best-effort, N-2)", async () => {
    let calls = 0;
    const flakyTranslator = {
      async translate(): Promise<string> {
        calls += 1;
        if (calls < 3) throw new Error("Throttling");
        return "Hello";
      },
    };
    const engine = new TranscribeStreamingEngine(
      new FakeAsrAdapter("ja", [{ startMs: 0, endMs: 1000, text: "こんにちは", isFinal: true }]),
      flakyTranslator,
      { sourceLanguage: "ja", targetLanguages: ["en"], translateRetry: { sleep: async () => {} } },
    );
    const out: CaptionEvent[] = [];
    engine.onCaption((c) => out.push(c));
    await engine.start();
    await engine.pushAudio(chunk);
    expect(out.find((c) => c.language === "en")?.text).toBe("Hello");
  });

  it("固まった翻訳は translateTimeoutMs で打ち切られ pushAudio がハングしない (耐ハング)", async () => {
    const hangingTranslator = {
      translate: () => new Promise<string>(() => {}), // 決して解決しない
    };
    const errors: string[] = [];
    const engine = new TranscribeStreamingEngine(
      new FakeAsrAdapter("ja", [{ startMs: 0, endMs: 1000, text: "やあ", isFinal: true }]),
      hangingTranslator,
      {
        sourceLanguage: "ja",
        targetLanguages: ["en"],
        translateTimeoutMs: 5,
        translateRetry: { retries: 0, sleep: async () => {} },
        onTranslateError: (target) => errors.push(target),
      },
    );
    const out: CaptionEvent[] = [];
    engine.onCaption((c) => out.push(c));
    await engine.start();
    await engine.pushAudio(chunk); // タイムアウトで返る (ハングしない)
    expect(out.map((c) => c.language)).toEqual(["ja"]); // ソースのみ
    expect(errors).toEqual(["en"]); // 翻訳失敗を計測通知
  });

  it("翻訳が全リトライ失敗してもソース字幕は流れ pushAudio は壊れない", async () => {
    const brokenTranslator = {
      async translate(): Promise<string> {
        throw new Error("translate down");
      },
    };
    const engine = new TranscribeStreamingEngine(
      new FakeAsrAdapter("ja", [{ startMs: 0, endMs: 1000, text: "やあ", isFinal: true }]),
      brokenTranslator,
      { sourceLanguage: "ja", targetLanguages: ["en"], translateRetry: { sleep: async () => {} } },
    );
    const out: CaptionEvent[] = [];
    engine.onCaption((c) => out.push(c));
    await engine.start();
    await engine.pushAudio(chunk); // reject しない
    expect(out.map((c) => c.language)).toEqual(["ja"]); // ソースのみ、en はスキップ
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

  it("登壇資料と直前の発話を文脈として渡す (ADR 0021 D-3, D-4)", async () => {
    const seen: (string | undefined)[] = [];
    const llm: LlmAdapter = {
      async translate(text, _source, _target, context): Promise<string> {
        seen.push(context);
        return `[${text}]`;
      },
    };
    const engine = new LLMEngine(llm, {
      sourceLanguage: "ja",
      targetLanguages: ["en"],
      mode: "translate-only",
      materials: { current: () => "AgentCore は…" },
    });
    engine.onCaption(() => {});
    await engine.start();

    await engine.pushText({ startMs: 0, endMs: 500, text: "最初の発話", isFinal: true });
    // 1 回目は直前の発話が無いので資料だけ。
    expect(seen[0]).toContain("<reference_material>");
    expect(seen[0]).toContain("AgentCore は…");
    expect(seen[0]).not.toContain("<recent_speech>");

    await engine.pushText({ startMs: 500, endMs: 900, text: "次の発話", isFinal: true });
    // 2 回目は確定済みの 1 回目が履歴に入る。自分自身は含まない。
    expect(seen[1]).toContain("- 最初の発話");
    expect(seen[1]).not.toContain("- 次の発話");
  });

  it("資料が無ければ文脈を渡さない", async () => {
    const seen: (string | undefined)[] = [];
    const llm: LlmAdapter = {
      async translate(text, _s, _t, context): Promise<string> {
        seen.push(context);
        return text;
      },
    };
    const engine = new LLMEngine(llm, {
      sourceLanguage: "ja",
      targetLanguages: ["en"],
      mode: "translate-only",
    });
    engine.onCaption(() => {});
    await engine.start();
    await engine.pushText({ startMs: 0, endMs: 100, text: "発話", isFinal: true });
    expect(seen[0]).toBeUndefined();
  });

  it("翻訳が全リトライ失敗してもソース字幕は流れる (LLM, best-effort)", async () => {
    const brokenLlm: LlmAdapter = {
      async translate(): Promise<string> {
        throw new Error("bedrock down");
      },
    };
    const engine = new LLMEngine(brokenLlm, {
      sourceLanguage: "ja",
      targetLanguages: ["en"],
      mode: "translate-only",
      translateRetry: { sleep: async () => {} },
    });
    const out: CaptionEvent[] = [];
    engine.onCaption((c) => out.push(c));
    await engine.start();
    await engine.pushText({ text: "やあ", startMs: 0, endMs: 500, isFinal: true });
    expect(out.map((c) => c.language)).toEqual(["ja"]); // ソースのみ、en はスキップ
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
