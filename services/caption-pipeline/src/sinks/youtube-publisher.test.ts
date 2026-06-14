import { describe, expect, it, vi } from "vitest";
import type { CaptionEvent } from "@stagecast/shared";
import { HttpYouTubeCaptionPublisher, formatYouTubeTimestamp } from "./youtube-publisher.js";

const final: CaptionEvent = {
  startMs: 1500,
  endMs: 2500,
  language: "ja",
  text: "こんにちは",
  status: "final",
};

describe("HttpYouTubeCaptionPublisher (DESIGN.md 6.3.1)", () => {
  it("formats timestamps relative to the stream base time", () => {
    expect(formatYouTubeTimestamp(Date.UTC(2026, 0, 1, 0, 0, 1, 500))).toBe(
      "2026-01-01T00:00:01.500",
    );
  });

  it("POSTs timestamped body with an incrementing sequence", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const pub = new HttpYouTubeCaptionPublisher({
      ingestionUrl: "https://upload.youtube.com/closedcaption?cid=abc",
      baseEpochMs: Date.UTC(2026, 0, 1, 0, 0, 0, 0),
      fetchFn,
    });
    await pub.publish(final);
    await pub.publish({ ...final, startMs: 3000, text: "さようなら" });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][0]).toContain("seq=1");
    expect(fetchFn.mock.calls[1][0]).toContain("seq=2");
    expect(fetchFn.mock.calls[0][1].body).toBe("2026-01-01T00:00:01.500\nこんにちは\n");
  });

  it("throws when ingestion fails", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const pub = new HttpYouTubeCaptionPublisher({
      ingestionUrl: "https://upload.youtube.com/cc",
      baseEpochMs: 0,
      fetchFn,
    });
    await expect(pub.publish(final)).rejects.toThrow(/403/);
  });
});
