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
    // **await せずに投げっぱなしにすると Lambda が凍結して削除が完走しない**。
    // ここで待たずに検証することで、その退行を捕まえる。
    expect(cleanedMaterials).toEqual([e.id]);
  });

  it("ended 以外の遷移では消さない (配信中に資料が消えたら字幕の文脈が失われる)", async () => {
    const { events, cleanedMaterials } = build();
    const e = await newEvent(events);
    await events.setStatus(e.id, "live");
    expect(cleanedMaterials).toEqual([]);
  });

  it("終了では録画・字幕を消す cleanupStorage は呼ばない (成果物として残す)", async () => {
    const { events, cleanedStorage } = build();
    const e = await newEvent(events);
    await events.setStatus(e.id, "live");
    await events.setStatus(e.id, "ended");
    expect(cleanedStorage).toEqual([]);
  });

  it("イベント削除では cleanupStorage が呼ばれる", async () => {
    const { events, cleanedStorage } = build();
    const e = await newEvent(events);
    await events.remove(e.id);
    expect(cleanedStorage).toEqual([e.id]);
  });
});

describe("削除の完了を待つこと (Lambda の凍結対策)", () => {
  // 投げっぱなしにすると Lambda が応答を返した時点で実行環境を凍結し、S3 の削除が
  // 完走しない。実機でこれを踏んだ (状態は ended になるのに資料が残った)。
  it("削除に時間がかかっても setStatus はその完了後に返る", async () => {
    let done = false;
    const events = createEventService({
      repo: new MemoryEventRepository(),
      newId: () => "evt-slow",
      now: () => 1_000_000,
      cleanupMaterials: async () => {
        await new Promise((r) => setTimeout(r, 20));
        done = true;
      },
    });
    const e = await newEvent(events);
    await events.setStatus(e.id, "live");
    await events.setStatus(e.id, "ended");
    expect(done).toBe(true);
  });

  it("削除が失敗しても配信終了は成功する", async () => {
    const events = createEventService({
      repo: new MemoryEventRepository(),
      newId: () => "evt-fail",
      now: () => 1_000_000,
      cleanupMaterials: async () => {
        throw new Error("S3 down");
      },
    });
    const e = await newEvent(events);
    await events.setStatus(e.id, "live");
    const ended = await events.setStatus(e.id, "ended");
    expect(ended.status).toBe("ended");
  });
});

describe("live / scheduled の副作用も完了を待つ", () => {
  // onGoLive も onWarmupSchedule も動的 import + SDK 呼び出しなので、投げっぱなしだと
  // cold start では特に完走しない。落ちても静かに遅延するだけなので気づけない。
  it("onGoLive の完了後に setStatus が返る", async () => {
    let done = false;
    const events = createEventService({
      repo: new MemoryEventRepository(),
      newId: () => "evt-live",
      now: () => 1_000_000,
      onGoLive: async () => {
        await new Promise((r) => setTimeout(r, 20));
        done = true;
      },
    });
    const e = await newEvent(events);
    await events.setStatus(e.id, "live");
    expect(done).toBe(true);
  });

  it("onWarmupSchedule の完了後に setStatus が返る", async () => {
    let done = false;
    const events = createEventService({
      repo: new MemoryEventRepository(),
      newId: () => "evt-sched",
      now: () => 1_000_000,
      onWarmupSchedule: async () => {
        await new Promise((r) => setTimeout(r, 20));
        done = true;
      },
    });
    const e = await newEvent(events);
    await events.setStatus(e.id, "scheduled");
    expect(done).toBe(true);
  });

  it("副作用が失敗しても遷移は成功する", async () => {
    const events = createEventService({
      repo: new MemoryEventRepository(),
      newId: () => "evt-boom",
      now: () => 1_000_000,
      onGoLive: async () => {
        throw new Error("lambda down");
      },
    });
    const e = await newEvent(events);
    expect((await events.setStatus(e.id, "live")).status).toBe("live");
  });
});
