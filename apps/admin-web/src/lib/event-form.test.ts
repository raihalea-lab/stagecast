import { describe, expect, it } from "vitest";
import {
  computeDefaultEndsAt,
  defaultFormValues,
  toCreateEventInput,
  toFormValues,
  validateForm,
} from "./event-form.js";
import type { EventDefinition } from "@stagecast/shared";

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

  it("computeDefaultEndsAt adds 2 hours", () => {
    expect(computeDefaultEndsAt("2026-07-01T09:00")).toBe("2026-07-01T11:00");
    expect(computeDefaultEndsAt("2026-07-01T23:00")).toBe("2026-07-02T01:00");
  });

  it("computeDefaultEndsAt returns empty for invalid input", () => {
    expect(computeDefaultEndsAt("")).toBe("");
    expect(computeDefaultEndsAt("not-a-date")).toBe("");
  });

  it("validates endsAt < startsAt", () => {
    const r = validateForm({
      ...defaultFormValues(),
      title: "x",
      startsAt: "2026-07-01T11:00",
      endsAt: "2026-07-01T09:00",
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("終了日時は開始日時より後にしてください");
  });

  it("passes when endsAt >= startsAt", () => {
    const r = validateForm({
      ...defaultFormValues(),
      title: "x",
      startsAt: "2026-07-01T09:00",
      endsAt: "2026-07-01T11:00",
    });
    expect(r.ok).toBe(true);
  });

  it("toCreateEventInput omits endsAt when empty", () => {
    const input = toCreateEventInput({
      ...defaultFormValues(),
      title: "Conf",
      startsAt: "2026-07-01T09:00",
      endsAt: "",
    });
    expect(input.endsAt).toBeUndefined();
  });
});

describe("字幕オフ (ADR 0017 D-2 / D14)", () => {
  const base = { ...defaultFormValues("2026-07-01T09:00"), title: "E" };

  it("オフなら caption.enabled=false を送る", () => {
    const input = toCreateEventInput({ ...base, captionEnabled: false });
    expect(input.caption.enabled).toBe(false);
  });

  it("オフなら独自字幕 API も落とす (字幕が無いのに API だけ有効は意味がない)", () => {
    const input = toCreateEventInput({
      ...base,
      captionEnabled: false,
      customApiEnabled: true,
    });
    expect(input.caption.customApiEnabled).toBe(false);
  });

  it("オフなら言語の整合を問わない (設定は残しつつ作成できる)", () => {
    const v = {
      ...base,
      captionEnabled: false,
      languages: [] as never[],
      youtubeLanguage: "ja" as const,
    };
    expect(validateForm(v).ok).toBe(true);
  });

  it("オンなら従来どおり言語を検証する", () => {
    const v = { ...base, captionEnabled: true, languages: [] as never[] };
    expect(validateForm(v).ok).toBe(false);
  });
});

describe("toFormValues (イベントの複製)", () => {
  const base: EventDefinition = {
    id: "evt-1",
    title: "第12回 勉強会",
    startsAt: "2026-07-01T00:00:00.000Z",
    endsAt: "2026-07-01T02:00:00.000Z",
    status: "ended",
    caption: {
      languages: ["ja", "en"],
      youtubeLanguage: "en",
      engine: "llm",
      customApiEnabled: true,
    },
    createdAtMs: 1,
    updatedAtMs: 2,
  };

  it("設定を写し、タイトルにコピーの印を付ける", () => {
    const v = toFormValues(base);
    expect(v.title).toBe("第12回 勉強会 のコピー");
    expect(v.languages).toEqual(["ja", "en"]);
    expect(v.youtubeLanguage).toBe("en");
    expect(v.engine).toBe("llm");
    expect(v.customApiEnabled).toBe(true);
  });

  it("ISO の日時を datetime-local 形式に直す (そのままだと入力欄が空になる)", () => {
    const v = toFormValues(base);
    // 既存の整形 (2 時間後) と同じローカル表記になることで、TZ 非依存に形を確かめる。
    expect(v.startsAt).toBe(computeDefaultEndsAt("2026-06-30T22:00:00.000Z"));
    expect(v.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(v.endsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("**caption.enabled 未指定は有効**として写す (複製で字幕が黙って止まらない)", () => {
    expect(toFormValues(base).captionEnabled).toBe(true);
    expect(
      toFormValues({ ...base, caption: { ...base.caption, enabled: false } }).captionEnabled,
    ).toBe(false);
  });

  it("そのまま作成できる値になっている (id/status は入らない)", () => {
    const input = toCreateEventInput(toFormValues(base));
    expect(validateForm(toFormValues(base)).ok).toBe(true);
    expect(input).not.toHaveProperty("id");
    expect(input).not.toHaveProperty("status");
  });

  it("YouTube 設定があれば引き継ぐ", () => {
    const v = toFormValues({ ...base, youtube: { rtmpUrl: "rtmp://x", streamKeyRef: "key-a" } });
    expect(toCreateEventInput(v).youtube).toEqual({ rtmpUrl: "rtmp://x", streamKeyRef: "key-a" });
  });
});
