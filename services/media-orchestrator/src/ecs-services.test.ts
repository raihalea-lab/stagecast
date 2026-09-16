import { describe, expect, it } from "vitest";
import {
  captionWorkerServiceName,
  clusterName,
  eventServiceNames,
  readServiceStatuses,
  scaleUpServices,
  sfuServiceName,
  type EcsLike,
} from "./ecs-services.js";

/** DescribeServices が failures を返す (= 例外にならない) 挙動を写したフェイク。 */
function fakeEcs(
  services: { name: string; desiredCount: number; runningCount: number }[],
  /** UpdateService を拒否するサービス名 (ECS 側のエラーを模す)。 */
  rejecting: string[] = [],
): EcsLike & { updates: { service: string; desiredCount: number }[] } {
  const updates: { service: string; desiredCount: number }[] = [];
  return {
    updates,
    describeServices: async (_cluster, names) =>
      services.filter((s) => names.includes(s.name)).map((s) => ({ ...s })),
    updateDesiredCount: async (_cluster, service, desiredCount) => {
      if (rejecting.includes(service)) throw new Error(`cannot update ${service}`);
      updates.push({ service, desiredCount });
      const found = services.find((s) => s.name === service);
      if (found) found.desiredCount = desiredCount;
    },
  };
}

describe("サービス名の解決 (ADR 0015 Phase 3 / ADR 0023 D-2)", () => {
  it("共有 Cluster では eventId 付きの名前になる", () => {
    expect(clusterName("evt-1", "shared")).toBe("shared");
    expect(sfuServiceName("evt-1", "shared")).toBe("sfu-evt-1");
    expect(captionWorkerServiceName("evt-1", "shared")).toBe("captionworker-evt-1");
  });

  it("per-event Cluster では固定名になる", () => {
    expect(clusterName("evt-1")).toBe("stagecast-event-evt-1");
    expect(sfuServiceName("evt-1")).toBe("sfu");
    expect(captionWorkerServiceName("evt-1")).toBe("captionworker");
  });

  it("ADR 0017 で sidecar 化した valkey は観測対象に含めない", () => {
    const names = eventServiceNames("evt-1", "shared");
    expect(names.services).toEqual(["sfu-evt-1", "captionworker-evt-1"]);
  });
});

describe("readServiceStatuses", () => {
  it("要求順を保ち、見つからないサービスは missing として残す", async () => {
    const ecs = fakeEcs([{ name: "sfu-evt-1", desiredCount: 0, runningCount: 0 }]);
    const statuses = await readServiceStatuses(ecs, eventServiceNames("evt-1", "shared"));
    expect(statuses).toEqual([
      { name: "sfu-evt-1", desiredCount: 0, runningCount: 0 },
      { name: "captionworker-evt-1", desiredCount: 0, runningCount: 0, missing: true },
    ]);
  });
});

describe("scaleUpServices (ADR 0016 D-6)", () => {
  const names = eventServiceNames("evt-1", "shared");
  /** 字幕ありイベントの目標値。 */
  const allOne = { [names.sfu]: 1, [names.captionWorker]: 1 };

  it("desiredCount=0 のサービスをすべて 1 に引き上げる", async () => {
    const ecs = fakeEcs([
      { name: "sfu-evt-1", desiredCount: 0, runningCount: 0 },
      { name: "captionworker-evt-1", desiredCount: 0, runningCount: 0 },
    ]);
    const statuses = await readServiceStatuses(ecs, names);
    const result = await scaleUpServices(ecs, names, statuses, allOne);

    expect(result.scaled).toEqual(["sfu-evt-1", "captionworker-evt-1"]);
    expect(ecs.updates).toEqual([
      { service: "sfu-evt-1", desiredCount: 1 },
      { service: "captionworker-evt-1", desiredCount: 1 },
    ]);
    expect(result.statuses.map((s) => s.desiredCount)).toEqual([1, 1]);
  });

  it("ADR 0017 D-2: 目標 0 の CaptionWorker は引き上げない (字幕なしのコスト削減を壊さない)", async () => {
    const ecs = fakeEcs([
      { name: "sfu-evt-1", desiredCount: 0, runningCount: 0 },
      { name: "captionworker-evt-1", desiredCount: 0, runningCount: 0 },
    ]);
    const statuses = await readServiceStatuses(ecs, names);
    const result = await scaleUpServices(ecs, names, statuses, {
      [names.sfu]: 1,
      [names.captionWorker]: 0,
    });

    expect(result.scaled).toEqual(["sfu-evt-1"]);
    expect(ecs.updates).toEqual([{ service: "sfu-evt-1", desiredCount: 1 }]);
    expect(result.statuses.map((s) => s.desiredCount)).toEqual([1, 0]);
  });

  it("既に 1 以上のサービスは触らない (冪等)", async () => {
    const ecs = fakeEcs([{ name: "sfu-evt-1", desiredCount: 1, runningCount: 1 }]);
    const statuses = await readServiceStatuses(ecs, names);
    const result = await scaleUpServices(ecs, names, statuses, allOne);

    expect(result.scaled).toEqual([]);
    expect(ecs.updates).toEqual([]);
  });

  it("1 サービスの引き上げ失敗が他のサービスと観測結果を巻き添えにしない", async () => {
    const ecs = fakeEcs(
      [
        { name: "sfu-evt-1", desiredCount: 0, runningCount: 0 },
        { name: "captionworker-evt-1", desiredCount: 0, runningCount: 0 },
      ],
      ["sfu-evt-1"],
    );
    const statuses = await readServiceStatuses(ecs, names);
    const result = await scaleUpServices(ecs, names, statuses, allOne);

    expect(result.failures.map((f) => f.name)).toEqual(["sfu-evt-1"]);
    expect(result.scaled).toEqual(["captionworker-evt-1"]);
    // 観測結果は 2 件とも残る (管理画面の進捗カードが空にならない)。
    expect(result.statuses.map((s) => s.desiredCount)).toEqual([0, 1]);
  });

  it("まだ存在しないサービス (CFN 作成途中) は次 tick に持ち越す", async () => {
    const ecs = fakeEcs([]);
    const statuses = await readServiceStatuses(ecs, names);
    const result = await scaleUpServices(ecs, names, statuses, allOne);

    expect(result.scaled).toEqual([]);
    expect(ecs.updates).toEqual([]);
    expect(result.statuses.every((s) => s.missing)).toBe(true);
  });
});
