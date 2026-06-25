import { describe, expect, it } from "vitest";
import {
  enforceMaxParallel,
  executePlan,
  findStaleStacks,
  planReconcile,
  type ActualStack,
  type DesiredEvent,
  type ReconcileExecutor,
} from "./reconcile.js";
import type { EventMediaSpec } from "./provisioner.js";

function desired(eventId: string): DesiredEvent {
  return { eventId, captionEngine: "transcribe", customCaptionApi: false };
}

describe("planReconcile (T4, ADR 0003 D-2)", () => {
  it("live なのにスタックが無いなら provision", () => {
    const plan = planReconcile([desired("a")], []);
    expect(plan.actions).toEqual([
      {
        type: "provision",
        spec: expect.objectContaining({ eventId: "a" }),
        reason: expect.any(String),
      },
    ]);
  });

  it("running なら何もしない (目的達成)", () => {
    const actual: ActualStack[] = [{ eventId: "a", kind: "running" }];
    const plan = planReconcile([desired("a")], actual);
    expect(plan.actions).toEqual([]);
  });

  it("failed なら destroy (次の tick で provision に進む)", () => {
    const plan = planReconcile([desired("a")], [{ eventId: "a", kind: "failed" }]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ type: "destroy", eventId: "a" });
  });

  it("in_progress / deleting なら wait (二重起動・競合を避ける)", () => {
    const a = planReconcile([desired("x")], [{ eventId: "x", kind: "in_progress" }]);
    expect(a.actions[0]).toMatchObject({ type: "wait", eventId: "x" });

    const b = planReconcile([desired("y")], [{ eventId: "y", kind: "deleting" }]);
    expect(b.actions[0]).toMatchObject({ type: "wait", eventId: "y" });
  });

  it("desired に無くて actual が残っていれば destroy", () => {
    const plan = planReconcile([], [{ eventId: "old", kind: "running" }]);
    expect(plan.actions).toEqual([{ type: "destroy", eventId: "old", reason: expect.any(String) }]);
  });

  it("desired に無くて actual が deleting ならスキップ (既に消し中)", () => {
    const plan = planReconcile([], [{ eventId: "going", kind: "deleting" }]);
    expect(plan.actions).toEqual([]);
  });

  it("複数イベントで遷移が並ぶ", () => {
    const plan = planReconcile(
      [desired("new"), desired("ok"), desired("bad")],
      [
        { eventId: "ok", kind: "running" },
        { eventId: "bad", kind: "failed" },
        { eventId: "stale", kind: "running" },
      ],
    );
    const types = plan.actions.map((a) => a.type).sort();
    expect(types).toEqual(["destroy", "destroy", "provision"]);
  });
});

describe("findStaleStacks (L3 コスト暴走検知)", () => {
  const hour = 60 * 60 * 1000;

  it("maxAgeMs 超過のスタックを抽出し desired 判定を付ける", () => {
    const actual: ActualStack[] = [
      { eventId: "runaway", kind: "running", ageMs: 25 * hour },
      { eventId: "fresh", kind: "running", ageMs: 1 * hour },
      { eventId: "stuck", kind: "failed", ageMs: 30 * hour },
    ];
    const stale = findStaleStacks(actual, [desired("runaway")], { maxAgeMs: 24 * hour });
    expect(stale).toEqual([
      { eventId: "runaway", ageMs: 25 * hour, desired: true, kind: "running" },
      { eventId: "stuck", ageMs: 30 * hour, desired: false, kind: "failed" },
    ]);
  });

  it("削除中・年齢不明・閾値以下は対象外", () => {
    const actual: ActualStack[] = [
      { eventId: "deleting", kind: "deleting", ageMs: 99 * hour },
      { eventId: "unknown-age", kind: "running" },
      { eventId: "young", kind: "running", ageMs: 23 * hour },
    ];
    expect(findStaleStacks(actual, [], { maxAgeMs: 24 * hour })).toEqual([]);
  });
});

describe("executePlan (T4)", () => {
  it("provision / destroy を実行し件数を返す", async () => {
    const provisioned: string[] = [];
    const destroyed: string[] = [];
    const executor: ReconcileExecutor = {
      provision: async (spec: EventMediaSpec) => {
        provisioned.push(spec.eventId);
      },
      destroy: async (eventId: string) => {
        destroyed.push(eventId);
      },
    };
    const plan = planReconcile([desired("a"), desired("b")], [{ eventId: "z", kind: "running" }]);
    const result = await executePlan(plan, executor);
    expect(result.done).toBe(3);
    expect(provisioned.sort()).toEqual(["a", "b"]);
    expect(destroyed).toEqual(["z"]);
  });

  it("個別エラーは握り込むが、件数は errors に集計される", async () => {
    const executor: ReconcileExecutor = {
      provision: async () => {
        throw new Error("provision boom");
      },
      destroy: async () => {},
    };
    const plan = planReconcile([desired("a")], []);
    const result = await executePlan(plan, executor);
    expect(result.errors).toBe(1);
    expect(result.done).toBe(0);
  });

  it("wait アクションは副作用を起こさず skipped に集計", async () => {
    const executor: ReconcileExecutor = {
      provision: async () => {
        throw new Error("should not be called");
      },
      destroy: async () => {
        throw new Error("should not be called");
      },
    };
    const plan = planReconcile([desired("x")], [{ eventId: "x", kind: "in_progress" }]);
    const result = await executePlan(plan, executor);
    expect(result.skipped).toBe(1);
    expect(result.done).toBe(0);
    expect(result.errors).toBe(0);
  });
});

describe("enforceMaxParallel (ADR 0008 D-6)", () => {
  it("desired が上限以下なら全件 allowed (skipped 空)", () => {
    const r = enforceMaxParallel([desired("a"), desired("b")], [], 3);
    expect(r.allowed.map((d) => d.eventId)).toEqual(["a", "b"]);
    expect(r.skipped).toEqual([]);
  });

  it("上限を超えると超過分が skipped に入る (eventId 順)", () => {
    const r = enforceMaxParallel([desired("c"), desired("a"), desired("b"), desired("d")], [], 2);
    expect(r.allowed.map((d) => d.eventId)).toEqual(["a", "b"]);
    expect(r.skipped.map((d) => d.eventId)).toEqual(["c", "d"]);
  });

  it("既に running / in_progress なものを優先して allowed に残す", () => {
    const r = enforceMaxParallel(
      [desired("a"), desired("b"), desired("c")],
      [
        { eventId: "c", kind: "running" },
        { eventId: "b", kind: "running" },
      ],
      2,
    );
    // 稼働中の b, c が残り、新規の a が skipped。
    expect(r.allowed.map((d) => d.eventId).sort()).toEqual(["b", "c"]);
    expect(r.skipped.map((d) => d.eventId)).toEqual(["a"]);
  });

  it("maxParallel <= 0 は無効化扱いで全件 allowed", () => {
    const r = enforceMaxParallel([desired("a"), desired("b")], [], 0);
    expect(r.allowed).toHaveLength(2);
    expect(r.skipped).toEqual([]);
  });
});
