import { describe, expect, it } from "vitest";
import { computeCols } from "./Grid.js";

describe("computeCols (R15: Grid layout 自動カラム数)", () => {
  it("1 人なら 1 カラム (full screen)", () => {
    expect(computeCols(1)).toBe(1);
  });

  it("2 人なら 2 カラム (1x2 並び)", () => {
    expect(computeCols(2)).toBe(2);
  });

  it("3-4 人なら 2 カラム (2x2 並び)", () => {
    expect(computeCols(3)).toBe(2);
    expect(computeCols(4)).toBe(2);
  });

  it("5-6 人なら 3 カラム (2x3 並び)", () => {
    expect(computeCols(5)).toBe(3);
    expect(computeCols(6)).toBe(3);
  });

  it("7-9 人なら 3 カラム (3x3 並び)", () => {
    expect(computeCols(7)).toBe(3);
    expect(computeCols(9)).toBe(3);
  });

  it("0 人 (待機画面に切替わるので Grid が呼ばれない想定だが防御的に 1 を返す)", () => {
    expect(computeCols(0)).toBe(1);
  });
});
