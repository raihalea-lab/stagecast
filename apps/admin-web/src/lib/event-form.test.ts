import { describe, expect, it } from "vitest";
import { defaultFormValues, toCreateEventInput, validateForm } from "./event-form.js";

describe("event form", () => {
  it("accepts valid defaults plus required fields", () => {
    const values = { ...defaultFormValues(), title: "Conf", startsAt: "2026-07-01T09:00" };
    expect(validateForm(values).ok).toBe(true);
  });

  it("requires title, date and a YouTube language within supported languages", () => {
    const r = validateForm({ ...defaultFormValues(), title: "", startsAt: "" });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(2);

    const mismatch = validateForm({
      ...defaultFormValues(),
      title: "x",
      startsAt: "x",
      languages: ["en"],
      youtubeLanguage: "ja",
    });
    expect(mismatch.ok).toBe(false);
  });

  it("maps form values to a CreateEventInput with youtube target when provided", () => {
    const input = toCreateEventInput({
      ...defaultFormValues(),
      title: "  Conf  ",
      startsAt: "2026-07-01T09:00",
      rtmpUrl: "rtmp://a/live",
      streamKeyRef: "secret/yt-key",
    });
    expect(input.title).toBe("Conf");
    expect(input.caption.youtubeLanguage).toBe("ja");
    expect(input.youtube).toEqual({ rtmpUrl: "rtmp://a/live", streamKeyRef: "secret/yt-key" });
  });
});
