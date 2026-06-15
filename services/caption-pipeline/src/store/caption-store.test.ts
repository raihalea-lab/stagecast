import { describe, expect, it } from "vitest";
import type { CaptionEvent } from "@stagecast/shared";
import {
  CaptionStore,
  InMemoryObjectStorage,
  formatSrtTime,
  formatVttTime,
  toSrt,
  toVtt,
} from "./caption-store.js";

const caps: CaptionEvent[] = [
  { startMs: 0, endMs: 1500, language: "ja", text: "おはよう", status: "final" },
  { startMs: 1500, endMs: 3200, language: "ja", text: "ございます", status: "final" },
];

describe("caption store formatting (DESIGN.md 6.4)", () => {
  it("formats SRT and VTT timecodes", () => {
    expect(formatSrtTime(3_661_123)).toBe("01:01:01,123");
    expect(formatVttTime(3_661_123)).toBe("01:01:01.123");
  });

  it("produces valid SRT", () => {
    const srt = toSrt(caps);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\nおはよう");
    expect(srt).toContain("2\n00:00:01,500 --> 00:00:03,200\nございます");
  });

  it("produces valid WEBVTT", () => {
    const vtt = toVtt(caps);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.500\nおはよう");
  });

  it("VTT は & < > をエスケープし、SRT は生のまま (字幕崩れ防止)", () => {
    const c: CaptionEvent[] = [
      { startMs: 0, endMs: 1000, language: "en", text: "Q&A: a < b > c", status: "final" },
    ];
    expect(toVtt(c)).toContain("Q&amp;A: a &lt; b &gt; c");
    // SRT には標準エスケープが無いので生テキストのまま。
    expect(toSrt(c)).toContain("Q&A: a < b > c");
  });

  it("キュー内の空行/CRLF を除去してキュー境界の崩れを防ぐ", () => {
    const c: CaptionEvent[] = [
      {
        startMs: 0,
        endMs: 1000,
        language: "en",
        text: "line1\r\n\r\n  \nline2\n",
        status: "final",
      },
    ];
    expect(toSrt(c)).toContain("00:00:00,000 --> 00:00:01,000\nline1\nline2\n");
    expect(toVtt(c)).toContain("00:00:00.000 --> 00:00:01.000\nline1\nline2");
  });
});

describe("CaptionStore", () => {
  it("keeps only final captions and writes SRT+VTT per language to storage (N-4)", async () => {
    const storage = new InMemoryObjectStorage();
    const store = new CaptionStore(storage, { eventId: "evt-1" });

    store.ingest(caps[0]!);
    store.ingest({ ...caps[1]! });
    store.ingest({ startMs: 0, endMs: 100, language: "en", text: "interim", status: "interim" });
    store.ingest({ startMs: 0, endMs: 100, language: "en", text: "Hello", status: "final" });

    const keys = await store.flushToStorage();
    expect(keys).toContain("captions/evt-1/ja.srt");
    expect(keys).toContain("captions/evt-1/en.vtt");
    // 暫定字幕は保存されない
    expect(store.captionsFor("en")).toHaveLength(1);
    expect(await storage.get("captions/evt-1/en.srt")).toContain("Hello");
  });
});
