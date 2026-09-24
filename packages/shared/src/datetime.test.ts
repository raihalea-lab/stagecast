import { describe, expect, it } from "vitest";
import { computeDefaultEndsAt, formatEventTime, pad2, toDatetimeLocal } from "./datetime.js";

describe("datetime helpers (admin-web / request-web / ui で共有)", () => {
  it("pad2 は 2 桁ゼロ埋め", () => {
    expect(pad2(7)).toBe("07");
    expect(pad2(12)).toBe("12");
  });

  it("toDatetimeLocal は Date をローカル時刻の datetime-local 形式にする", () => {
    expect(toDatetimeLocal(new Date(2026, 6, 1, 9, 5))).toBe("2026-07-01T09:05");
  });

  it("toDatetimeLocal は時・分を上書きできる (カレンダーの日付クリック用)", () => {
    expect(toDatetimeLocal(new Date(2026, 6, 1, 15, 45), 9, 0)).toBe("2026-07-01T09:00");
  });

  it("toDatetimeLocal は ISO 文字列 (Z 付き) も受け、壊れた値は空にする", () => {
    const local = new Date("2026-07-01T00:00:00Z");
    expect(toDatetimeLocal("2026-07-01T00:00:00Z")).toBe(toDatetimeLocal(local));
    expect(toDatetimeLocal("not-a-date")).toBe("");
    expect(toDatetimeLocal(undefined)).toBe("");
  });

  it("computeDefaultEndsAt は開始 + 2 時間", () => {
    expect(computeDefaultEndsAt("2026-07-01T09:00")).toBe("2026-07-01T11:00");
    expect(computeDefaultEndsAt("2026-07-01T23:00")).toBe("2026-07-02T01:00");
    expect(computeDefaultEndsAt("")).toBe("");
    expect(computeDefaultEndsAt("garbage")).toBe("");
  });

  it("formatEventTime は日本語ロケールの M/D HH:mm", () => {
    expect(formatEventTime(new Date(2026, 6, 1, 9, 5))).toBe("7/1 09:05");
  });
});
