import { describe, expect, it } from "vitest";
import type { EventProvisioningInfo } from "@stagecast/shared";
import {
  computePhase,
  computeProvisioning,
  createProvisioningPublisher,
  sameProvisioning,
  type ProvisioningInput,
  type ProvisioningStore,
} from "./provisioning.js";

const running = (desired: number, run: number) => [
  { name: "sfu-evt-1", desiredCount: desired, runningCount: run },
  { name: "captionworker-evt-1", desiredCount: desired, runningCount: run },
];

function input(over: Partial<ProvisioningInput> = {}): ProvisioningInput {
  return { services: running(1, 1), mediaReady: true, wantTasks: true, ...over };
}

describe("computePhase (ADR 0023 D-3)", () => {
  it("スタックが無ければ none", () => {
    expect(computePhase(input({ stack: undefined }))).toBe("none");
  });

  it("CREATE_IN_PROGRESS は creating", () => {
    expect(computePhase(input({ stack: { kind: "in_progress" } }))).toBe("creating");
  });

  it("スタック完成でもタスクが RUNNING でなければ starting (Express モードの本質)", () => {
    expect(computePhase(input({ stack: { kind: "running" }, services: running(1, 0) }))).toBe(
      "starting",
    );
  });

  it("タスクは RUNNING でも LiveKit URL 未確定なら starting", () => {
    expect(computePhase(input({ stack: { kind: "running" }, mediaReady: false }))).toBe("starting");
  });

  it("タスク RUNNING + LiveKit URL 確定で ready", () => {
    expect(computePhase(input({ stack: { kind: "running" } }))).toBe("ready");
  });

  it("サービスがまだ無い (missing) 間は ready にならない", () => {
    expect(
      computePhase(
        input({
          stack: { kind: "running" },
          services: [{ name: "sfu-evt-1", desiredCount: 0, runningCount: 0, missing: true }],
        }),
      ),
    ).toBe("starting");
  });

  it("事前プロビジョニング (wantTasks=false) はスタック完成をもって ready", () => {
    expect(
      computePhase(
        input({
          stack: { kind: "running" },
          services: running(0, 0),
          mediaReady: false,
          wantTasks: false,
        }),
      ),
    ).toBe("ready");
  });

  it("failed / deleting はそのまま伝える", () => {
    expect(computePhase(input({ stack: { kind: "failed" } }))).toBe("failed");
    expect(computePhase(input({ stack: { kind: "deleting" } }))).toBe("deleting");
  });
});

describe("computeProvisioning", () => {
  it("CFN の生ステータスと観測時刻を載せる", () => {
    const info = computeProvisioning(
      input({ stack: { kind: "in_progress", status: "CREATE_IN_PROGRESS" } }),
      1234,
    );
    expect(info).toEqual({
      phase: "creating",
      stackStatus: "CREATE_IN_PROGRESS",
      services: running(1, 1),
      mediaReady: true,
      observedAtMs: 1234,
    });
  });
});

describe("sameProvisioning", () => {
  it("キーの並び順が違っても同じ観測値とみなす (DynamoDB の項目は順序を保証しない)", () => {
    const a = computeProvisioning(input({ stack: { kind: "running" } }), 1);
    // DocumentClient から戻ってくる項目のようにキー順を入れ替えて復元する。
    const shuffled = JSON.parse(
      JSON.stringify({
        observedAtMs: 999,
        mediaReady: a.mediaReady,
        services: a.services.map((s) => ({
          runningCount: s.runningCount,
          name: s.name,
          desiredCount: s.desiredCount,
        })),
        phase: a.phase,
      }),
    ) as EventProvisioningInfo;
    expect(sameProvisioning(shuffled, a)).toBe(true);
  });

  it("サービスの running 数が違えば別物とみなす", () => {
    const a = computeProvisioning(input({ stack: { kind: "running" } }), 1);
    const b = computeProvisioning(
      input({ stack: { kind: "running" }, services: running(1, 0) }),
      1,
    );
    expect(sameProvisioning(a, b)).toBe(false);
  });
});

describe("createProvisioningPublisher", () => {
  /** DynamoDB 往復を模して、書いた値とは別のオブジェクトを返す。 */
  function fakeStore(): ProvisioningStore & { written: EventProvisioningInfo[] } {
    let current: EventProvisioningInfo | undefined;
    const written: EventProvisioningInfo[] = [];
    return {
      written,
      get: async () =>
        current ? (JSON.parse(JSON.stringify(current)) as EventProvisioningInfo) : undefined,
      put: async (_id, info) => {
        current = info;
        written.push(info);
      },
      clear: async () => {
        current = undefined;
      },
    };
  }

  it("初回は書き込む", async () => {
    const store = fakeStore();
    const pub = createProvisioningPublisher({ store, now: () => 1 });
    const out = await pub.publish("evt-1", input({ stack: { kind: "running" } }));
    expect(out.status).toBe("updated");
    expect(store.written).toHaveLength(1);
  });

  it("observedAtMs だけが違う再観測では書き込まない (N-1 書き込みコスト)", async () => {
    const store = fakeStore();
    let t = 1;
    const pub = createProvisioningPublisher({ store, now: () => t });
    await pub.publish("evt-1", input({ stack: { kind: "running" } }));
    t = 61_000;
    const out = await pub.publish("evt-1", input({ stack: { kind: "running" } }));
    expect(out.status).toBe("unchanged");
    expect(store.written).toHaveLength(1);
  });

  it("running 数が変われば書き込む", async () => {
    const store = fakeStore();
    const pub = createProvisioningPublisher({ store, now: () => 1 });
    await pub.publish("evt-1", input({ stack: { kind: "running" }, services: running(1, 0) }));
    const out = await pub.publish("evt-1", input({ stack: { kind: "running" } }));
    expect(out.status).toBe("updated");
    expect(store.written).toHaveLength(2);
  });

  it("store の失敗は error として返し、例外を投げない", async () => {
    const store: ProvisioningStore = {
      get: async () => undefined,
      put: async () => {
        throw new Error("dynamo down");
      },
      clear: async () => {},
    };
    const pub = createProvisioningPublisher({ store });
    const out = await pub.publish("evt-1", input({ stack: { kind: "running" } }));
    expect(out.status).toBe("error");
  });
});

describe("provision 失敗を管理画面に出す (NEXT_WORK D16)", () => {
  // スタックがまだ無い状態で失敗し続けるのが一番タチが悪い。2026-09-16 はこれで
  // 13 分間「未作成」と出続けた (PR #236)。
  const base = { services: [], mediaReady: false, wantTasks: true };

  it("スタックが無くても失敗理由があれば failed にする", () => {
    expect(computePhase({ ...base, error: "provision: render template failed" })).toBe("failed");
  });

  it("失敗理由が無ければ従来どおり none", () => {
    expect(computePhase(base)).toBe("none");
  });

  it("失敗理由を書き戻す情報に載せる", () => {
    const info = computeProvisioning({ ...base, error: "provision: boom" }, 1000);
    expect(info.error).toBe("provision: boom");
  });

  it("失敗していないときは error を持たせない", () => {
    expect(computeProvisioning(base, 1000).error).toBeUndefined();
  });

  it("失敗理由が変わったら差分として検出する (古い理由を出し続けない)", () => {
    const a = computeProvisioning({ ...base, error: "provision: A" }, 1000);
    const b = computeProvisioning({ ...base, error: "provision: B" }, 2000);
    expect(sameProvisioning(a, b)).toBe(false);
  });

  it("復旧したら差分として検出する (エラー表示が消える)", () => {
    const failed = computeProvisioning({ ...base, error: "provision: A" }, 1000);
    const ok = computeProvisioning(base, 2000);
    expect(sameProvisioning(failed, ok)).toBe(false);
  });
});

describe("シグナリングが応答しなければ ready にしない (ADR 0027 D-2)", () => {
  const up = { stack: { kind: "running" as const }, services: running(1, 1), mediaReady: true };

  it("タスクが RUNNING でもシグナリングが応答しなければ starting", () => {
    // 2026-09-17 の事故: SFU が再起動した直後、ECS は RUNNING・media も確定済みなので
    // 画面は ready を出し続けたが、誰も入室できなかった。
    expect(computePhase(input({ ...up, signalingReady: false }))).toBe("starting");
  });

  it("応答があれば ready", () => {
    expect(computePhase(input({ ...up, signalingReady: true }))).toBe("ready");
  });

  it("probe 未実施 (undefined) は従来どおり ready", () => {
    expect(computePhase(input(up))).toBe("ready");
  });

  it("事前プロビジョニング中はシグナリングを問わない (タスクを動かしていない)", () => {
    expect(computePhase(input({ ...up, wantTasks: false, signalingReady: false }))).toBe("ready");
  });

  it("応答なしの理由は observedAt の差分と違って書き戻される", () => {
    const a = computeProvisioning(input({ ...up, signalingReady: true }), 1000);
    const b = computeProvisioning(
      input({ ...up, signalingReady: false, signalingError: "timeout after 3000ms" }),
      2000,
    );
    expect(sameProvisioning(a, b)).toBe(false);
    expect(b.signalingError).toBe("timeout after 3000ms");
  });
});
