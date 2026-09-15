import { describe, expect, it } from "vitest";
import type { EventProvisioningInfo } from "@stagecast/shared";
import {
  computePhase,
  computeProvisioning,
  createProvisioningPublisher,
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

describe("computePhase (ADR 0020 D-3)", () => {
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

describe("createProvisioningPublisher", () => {
  function fakeStore(): ProvisioningStore & { written: EventProvisioningInfo[] } {
    let current: EventProvisioningInfo | undefined;
    const written: EventProvisioningInfo[] = [];
    return {
      written,
      get: async () => current,
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
