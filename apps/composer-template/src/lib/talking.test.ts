import { describe, expect, it } from "vitest";
import { INITIAL_STATE, updateTalking } from "./talking.js";

describe("updateTalking", () => {
  it("audioLevel がしきい値を超えると talking=true", () => {
    const next = updateTalking(INITIAL_STATE, 0.3, 1000);
    expect(next.isTalking).toBe(true);
    expect(next.lastActiveMs).toBe(1000);
  });

  it("audioLevel がしきい値以下でも 500ms 以内なら talking 維持", () => {
    const active = { isTalking: true, lastActiveMs: 1000 };
    const next = updateTalking(active, 0.05, 1400);
    expect(next.isTalking).toBe(true);
  });

  it("500ms 経過後に audioLevel が低いと talking=false", () => {
    const active = { isTalking: true, lastActiveMs: 1000 };
    const next = updateTalking(active, 0.05, 1600);
    expect(next.isTalking).toBe(false);
  });

  it("初期状態で audioLevel が低いままなら talking=false を維持", () => {
    const next = updateTalking(INITIAL_STATE, 0.1, 500);
    expect(next.isTalking).toBe(false);
  });

  it("しきい値ちょうどは talking にならない (> で判定)", () => {
    const next = updateTalking(INITIAL_STATE, 0.2, 1000);
    expect(next.isTalking).toBe(false);
  });
});
