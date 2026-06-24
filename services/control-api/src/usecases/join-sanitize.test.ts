import { describe, expect, it } from "vitest";
import { MAX_DISPLAY_NAME_LENGTH, sanitizeDisplayName } from "./join.js";

describe("sanitizeDisplayName (公開 /join の untrusted 入力)", () => {
  it("通常の名前はそのまま (前後空白は除去)", () => {
    expect(sanitizeDisplayName("  Alice  ")).toBe("Alice");
  });

  it("制御文字 (改行・タブ) は空白化して畳む", () => {
    expect(sanitizeDisplayName("Ali\nce\t\tBob")).toBe("Ali ce Bob");
  });

  it("最大長で切り詰める", () => {
    const long = "a".repeat(200);
    expect(sanitizeDisplayName(long)).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
  });

  it("空・空白のみ・undefined は undefined", () => {
    expect(sanitizeDisplayName("   ")).toBeUndefined();
    expect(sanitizeDisplayName("")).toBeUndefined();
    expect(sanitizeDisplayName(undefined)).toBeUndefined();
  });

  it("マルチバイト文字を壊さない", () => {
    expect(sanitizeDisplayName("田中さん")).toBe("田中さん");
  });
});
