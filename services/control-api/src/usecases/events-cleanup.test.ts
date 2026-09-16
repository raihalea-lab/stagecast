import { describe, expect, it } from "vitest";
import { createEventService } from "./events.js";
import { MemoryEventRepository } from "../repo/memory.js";

function build() {
  const cleanedMaterials: string[] = [];
  const cleanedStorage: string[] = [];
  const events = createEventService({
    repo: new MemoryEventRepository(),
    newId: () => "evt-1",
    now: () => 1_000_000,
    cleanupMaterials: async (id) => {
      cleanedMaterials.push(id);
    },
    cleanupStorage: async (id) => {
      cleanedStorage.push(id);
    },
  });
  return { events, cleanedMaterials, cleanedStorage };
}

async function newEvent(events: ReturnType<typeof build>["events"]) {
  return events.create({
    title: "t",
    startsAt: "2026-01-01T00:00:00Z",
    caption: {
      languages: ["ja"],
      youtubeLanguage: "ja",
      engine: "transcribe",
      customApiEnabled: false,
    },
  });
}

describe("イベント終了時の翻訳参考資料の削除", () => {
  it("ended に遷移したら資料を消す", async () => {
    const { events, cleanedMaterials } = build();
    const e = await newEvent(events);
    await events.setStatus(e.id, "live");
    await events.setStatus(e.id, "ended");
    // 投げっぱなしなので 1 tick 待つ。
    await new Promise((r) => setImmediate(r));
    expect(cleanedMaterials).toEqual([e.id]);
  });

  it("ended 以外の遷移では消さない (配信中に資料が消えたら字幕の文脈が失われる)", async () => {
    const { events, cleanedMaterials } = build();
    const e = await newEvent(events);
    await events.setStatus(e.id, "live");
    await new Promise((r) => setImmediate(r));
    expect(cleanedMaterials).toEqual([]);
  });

  it("終了では録画・字幕を消す cleanupStorage は呼ばない (成果物として残す)", async () => {
    const { events, cleanedStorage } = build();
    const e = await newEvent(events);
    await events.setStatus(e.id, "live");
    await events.setStatus(e.id, "ended");
    await new Promise((r) => setImmediate(r));
    expect(cleanedStorage).toEqual([]);
  });

  it("イベント削除では cleanupStorage が呼ばれる", async () => {
    const { events, cleanedStorage } = build();
    const e = await newEvent(events);
    await events.remove(e.id);
    expect(cleanedStorage).toEqual([e.id]);
  });
});
