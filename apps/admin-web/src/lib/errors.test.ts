import { describe, expect, it } from "vitest";
import { toErrorMessage } from "./errors.js";

describe("toErrorMessage (admin-web)", () => {
  it("末尾 JSON ボディの error フィールドを抽出する", () => {
    const err = new Error('POST /events failed (400): {"error":"title is required"}');
    expect(toErrorMessage(err)).toBe("title is required");
  });

  it("JSON が無ければ素の message を返す", () => {
    expect(toErrorMessage(new Error("network down"))).toBe("network down");
  });

  it("error フィールドが無い JSON は素の message にフォールバック", () => {
    const err = new Error('failed (500): {"reason":"x"}');
    expect(toErrorMessage(err)).toBe('failed (500): {"reason":"x"}');
  });

  it("文字列/不明値も扱う", () => {
    expect(toErrorMessage("boom")).toBe("boom");
    expect(toErrorMessage(undefined)).toBe("予期しないエラーが発生しました");
  });
});
