import { describe, expect, it } from "vitest";
import {
  isFinalCaption,
  isSupportedLanguage,
  isValidCaptionEvent,
  type CaptionEvent,
} from "./caption.js";

const base: CaptionEvent = {
  startMs: 1000,
  endMs: 2000,
  language: "ja",
  text: "こんにちは",
  status: "final",
  speakerId: "spk-1",
};

describe("caption", () => {
  it("isFinalCaption distinguishes interim vs final", () => {
    expect(isFinalCaption(base)).toBe(true);
    expect(isFinalCaption({ ...base, status: "interim" })).toBe(false);
  });

  it("isSupportedLanguage accepts ja/en only", () => {
    expect(isSupportedLanguage("ja")).toBe(true);
    expect(isSupportedLanguage("en")).toBe(true);
    expect(isSupportedLanguage("fr")).toBe(false);
  });

  it("isValidCaptionEvent validates shape and timeline", () => {
    expect(isValidCaptionEvent(base)).toBe(true);
    expect(isValidCaptionEvent({ ...base, endMs: 500 })).toBe(false); // end < start
    expect(isValidCaptionEvent({ ...base, language: "xx" })).toBe(false);
    expect(isValidCaptionEvent(null)).toBe(false);
    expect(isValidCaptionEvent({ startMs: 0 })).toBe(false);
  });
});
