import { describe, expect, it } from "vitest";
import type { PresentationState } from "@stagecast/shared";
import { computeLayout } from "./layout.js";

function state(partial: Partial<PresentationState>): PresentationState {
  return { eventId: "evt-a", speakers: [], ...partial };
}

describe("computeLayout (DESIGN.md 5.1)", () => {
  it("shows only live speakers, not standby ones (F-4)", () => {
    const s = state({
      speakers: [
        { speakerId: "a", visibility: "live", updatedAtMs: 1 },
        { speakerId: "b", visibility: "standby", updatedAtMs: 1 },
      ],
    });
    const layout = computeLayout(s);
    expect(layout.speakers.map((t) => t.speakerId)).toEqual(["a"]);
  });

  it("places a slide region and a speaker column when a slide is projected (5.2)", () => {
    const s = state({
      slideSource: "screen-share",
      speakers: [{ speakerId: "a", visibility: "live", updatedAtMs: 1 }],
    });
    const layout = computeLayout(s);
    expect(layout.slide).not.toBeNull();
    expect(layout.slide?.source).toBe("screen-share");
    // 登壇者はスライド右側カラム (x > 0.5)
    expect(layout.speakers[0]!.region.x).toBeGreaterThan(0.5);
  });

  it("uses a full grid when there is no slide", () => {
    const s = state({
      speakers: [
        { speakerId: "a", visibility: "live", updatedAtMs: 1 },
        { speakerId: "b", visibility: "live", updatedAtMs: 1 },
      ],
    });
    const layout = computeLayout(s);
    expect(layout.slide).toBeNull();
    expect(layout.speakers).toHaveLength(2);
  });

  it("adds QR overlay and title lower-third from branding (F-5)", () => {
    const layout = computeLayout(state({}), { title: "My Event", showQr: true });
    expect(layout.qr).not.toBeNull();
    expect(layout.title?.text).toBe("My Event");
  });

  it("passes through the uploaded slide page (5.2 事前アップロード)", () => {
    const s = state({ slideSource: "uploaded", slidePage: 7 });
    expect(computeLayout(s).slide?.page).toBe(7);
  });
});
