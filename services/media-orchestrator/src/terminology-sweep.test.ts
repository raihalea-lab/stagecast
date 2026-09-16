import { describe, expect, it } from "vitest";
import {
  eventIdFromTerminologyName,
  shouldKeepTerminology,
  sweepTerminologies,
  type EventLifecycle,
  type TerminologySweepDeps,
} from "./reconcile-handler.js";

const EVT_A = "0db29687-30e0-454d-880d-92ab4f0e99af";
const EVT_B = "96af9c01-10eb-46e3-8579-21f30c436d72";

function deps(names: string[], events: Record<string, EventLifecycle>) {
  const removed: string[] = [];
  const looked: string[][] = [];
  const d: TerminologySweepDeps = {
    listNames: async () => names,
    lookupEvents: async (ids) => {
      looked.push(ids);
      return new Map(ids.map((id) => [id, events[id]]));
    },
    remove: async (name) => {
      removed.push(name);
    },
  };
  return { d, removed, looked };
}

describe("eventIdFromTerminologyName (ADR 0021 D-3)", () => {
  it("target に `-` が入っていても UUID を切り出せる", () => {
    expect(eventIdFromTerminologyName(`stagecast-${EVT_A}-zh-TW`)).toBe(EVT_A);
    expect(eventIdFromTerminologyName(`stagecast-${EVT_A}-en`)).toBe(EVT_A);
  });

  it("大文字の UUID は作らないので拾わない (生成側と厳密に対にする)", () => {
    expect(eventIdFromTerminologyName(`stagecast-${EVT_A.toUpperCase()}-en`)).toBeUndefined();
  });

  it("stagecast の用語集でなければ undefined (他システムのものを消さない)", () => {
    expect(eventIdFromTerminologyName("someone-elses-glossary")).toBeUndefined();
    expect(eventIdFromTerminologyName("stagecast-not-a-uuid-en")).toBeUndefined();
    // 接頭辞が一致しても UUID の形でなければ触らない。
    expect(eventIdFromTerminologyName(`stagecast-${EVT_A}`)).toBeUndefined();
  });
});

describe("shouldKeepTerminology (ADR 0021 D-3)", () => {
  it("配信前 (draft / scheduled) は残す。資料は何日も前に登録されうる", () => {
    expect(shouldKeepTerminology({ status: "draft" })).toBe(true);
    expect(shouldKeepTerminology({ status: "scheduled" })).toBe(true);
    expect(shouldKeepTerminology({ status: "live" })).toBe(true);
  });

  it("ended と行ごと削除済みは回収する", () => {
    expect(shouldKeepTerminology({ status: "ended" })).toBe(false);
    expect(shouldKeepTerminology(undefined)).toBe(false);
  });

  it("status が読めない行は残す (誤削除より残留を選ぶ)", () => {
    expect(shouldKeepTerminology({ status: "unknown" })).toBe(true);
  });
});

describe("sweepTerminologies (ADR 0021 D-3)", () => {
  it("終了したイベントの用語集を全言語分消す", async () => {
    const { d, removed } = deps([`stagecast-${EVT_A}-en`, `stagecast-${EVT_A}-zh-TW`], {
      [EVT_A]: { status: "ended" },
    });
    expect(await sweepTerminologies(d)).toHaveLength(2);
    expect(removed).toEqual([`stagecast-${EVT_A}-en`, `stagecast-${EVT_A}-zh-TW`]);
  });

  it("配信せずに終わったイベントも回収できる (スタックの有無で判定しない)", async () => {
    // 下書きのまま資料だけ登録され、その後イベントごと消えたケース。
    // 旧実装はメディアスタック基準だったのでこれを取りこぼしていた。
    const { d, removed } = deps([`stagecast-${EVT_A}-en`], {});
    expect(await sweepTerminologies(d)).toEqual([`stagecast-${EVT_A}-en`]);
    expect(removed).toEqual([`stagecast-${EVT_A}-en`]);
  });

  it("配信前のイベントの用語集は残す", async () => {
    const { d, removed } = deps([`stagecast-${EVT_A}-en`], {
      [EVT_A]: { status: "scheduled" },
    });
    expect(await sweepTerminologies(d)).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("stagecast 以外の用語集には触らない", async () => {
    const { d, removed, looked } = deps(["someone-elses-glossary"], {});
    expect(await sweepTerminologies(d)).toEqual([]);
    expect(removed).toEqual([]);
    // 引くイベントが無いので DynamoDB も叩かない。
    expect(looked).toEqual([]);
  });

  it("照会できなかったイベントの用語集は消さない (スロットリングで誤削除しない)", async () => {
    // BatchGetItem の UnprocessedKeys は「行が無い」と区別がつかない。
    // 判定不能として status:"unknown" を返す実装に合わせ、残ることを確認する。
    const { d, removed } = deps([`stagecast-${EVT_A}-en`], {
      [EVT_A]: { status: "unknown" },
    });
    expect(await sweepTerminologies(d)).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("イベントの照会は 1 回にまとめる (用語集ごとに引かない)", async () => {
    const { d, looked } = deps(
      [`stagecast-${EVT_A}-en`, `stagecast-${EVT_A}-ko`, `stagecast-${EVT_B}-en`],
      { [EVT_A]: { status: "ended" }, [EVT_B]: { status: "live" } },
    );
    await sweepTerminologies(d);
    expect(looked).toEqual([[EVT_A, EVT_B]]);
  });
});
