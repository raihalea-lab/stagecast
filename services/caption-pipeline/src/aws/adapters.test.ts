import { describe, expect, it, vi } from "vitest";
import type { TranslateClient } from "@aws-sdk/client-translate";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import type { S3Client } from "@aws-sdk/client-s3";
import type { TranscriptEvent } from "@aws-sdk/client-transcribe-streaming";
import { AmazonTranslateTranslator } from "./translate-adapter.js";
import { BedrockLlmAdapter } from "./bedrock-adapter.js";
import { S3ObjectStorage } from "./s3-storage.js";
import { mapTranscriptEvent } from "./transcribe-adapter.js";

describe("AmazonTranslateTranslator", () => {
  it("calls Translate and returns the translated text", async () => {
    const send = vi.fn().mockResolvedValue({ TranslatedText: "Hello" });
    const t = new AmazonTranslateTranslator({ send } as unknown as TranslateClient);
    expect(await t.translate("こんにちは", "ja", "en")).toBe("Hello");
    const cmd = send.mock.calls[0][0];
    expect(cmd.input).toMatchObject({ SourceLanguageCode: "ja", TargetLanguageCode: "en" });
  });

  it("short-circuits when source equals target (no API call)", async () => {
    const send = vi.fn();
    const t = new AmazonTranslateTranslator({ send } as unknown as TranslateClient);
    expect(await t.translate("x", "ja", "ja")).toBe("x");
    expect(send).not.toHaveBeenCalled();
  });

  it("ターゲット言語ごとの用語集を渡す (ADR 0021 D-3)", async () => {
    const send = vi.fn().mockResolvedValue({ TranslatedText: "Hello" });
    const t = new AmazonTranslateTranslator({ send } as unknown as TranslateClient, "evt-1");
    await t.translate("こんにちは", "ja", "en");
    expect(send.mock.calls[0][0].input).toMatchObject({
      TerminologyNames: ["stagecast-evt-1-en"],
    });
  });

  it("用語集がまだ無ければ用語集なしでやり直す (登録レース)", async () => {
    const missing = Object.assign(new Error("nope"), { name: "ResourceNotFoundException" });
    const send = vi
      .fn()
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce({ TranslatedText: "Hello" });
    const t = new AmazonTranslateTranslator({ send } as unknown as TranslateClient, "evt-1");
    expect(await t.translate("こんにちは", "ja", "en")).toBe("Hello");
    expect(send.mock.calls[1][0].input.TerminologyNames).toBeUndefined();
  });

  it("用語集と無関係なエラーはやり直さない", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"));
    const t = new AmazonTranslateTranslator({ send } as unknown as TranslateClient, "evt-1");
    await expect(t.translate("こんにちは", "ja", "en")).rejects.toThrow("boom");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("BedrockLlmAdapter", () => {
  it("builds a translation prompt and parses the model output", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ content: [{ text: "おはよう" }] }));
    const send = vi.fn().mockResolvedValue({ body });
    const adapter = new BedrockLlmAdapter({ modelId: "anthropic.claude-3-5-sonnet" }, {
      send,
    } as unknown as BedrockRuntimeClient);
    expect(adapter.buildPrompt("good morning", "en", "ja")).toContain("English to Japanese");
    expect(await adapter.translate("good morning", "en", "ja")).toBe("おはよう");
  });
});

describe("S3ObjectStorage", () => {
  it("puts and gets objects", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Body: { transformToString: async () => "WEBVTT" } });
    const s3 = new S3ObjectStorage("bucket", { send } as unknown as S3Client);
    await s3.put("captions/evt/ja.vtt", "WEBVTT", "text/vtt");
    expect(send.mock.calls[0][0].input).toMatchObject({
      Bucket: "bucket",
      Key: "captions/evt/ja.vtt",
    });
    expect(await s3.get("captions/evt/ja.vtt")).toBe("WEBVTT");
  });
});

describe("mapTranscriptEvent (Transcribe 結果の純粋変換)", () => {
  it("maps final/partial results to segments with ms timestamps", () => {
    const event: TranscriptEvent = {
      Transcript: {
        Results: [
          {
            StartTime: 1.0,
            EndTime: 2.5,
            IsPartial: false,
            Alternatives: [{ Transcript: "hello" }],
          },
          {
            StartTime: 2.5,
            EndTime: 3.0,
            IsPartial: true,
            Alternatives: [{ Transcript: "wor" }],
          },
        ],
      },
    };
    const segs = mapTranscriptEvent(event, "spk-1");
    expect(segs).toEqual([
      { startMs: 1000, endMs: 2500, text: "hello", isFinal: true, speakerId: "spk-1" },
      { startMs: 2500, endMs: 3000, text: "wor", isFinal: false, speakerId: "spk-1" },
    ]);
  });

  it("skips results without text", () => {
    expect(mapTranscriptEvent({ Transcript: { Results: [{ Alternatives: [] }] } })).toEqual([]);
  });
});
