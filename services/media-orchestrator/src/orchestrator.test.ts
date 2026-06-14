import { describe, expect, it, beforeEach } from "vitest";
import { ConcurrencyLimitError, MAX_CONCURRENT_EVENTS, MediaOrchestrator } from "./orchestrator.js";
import { FakeMediaStackProvisioner, type EventMediaSpec } from "./provisioner.js";
import { InMemorySharedStateStore } from "./shared-state.js";

function spec(eventId: string): EventMediaSpec {
  return { eventId, captionEngine: "transcribe", customCaptionApi: false };
}

describe("MediaOrchestrator", () => {
  let provisioner: FakeMediaStackProvisioner;
  let sharedState: InMemorySharedStateStore;
  let orch: MediaOrchestrator;

  beforeEach(() => {
    provisioner = new FakeMediaStackProvisioner();
    sharedState = new InMemorySharedStateStore();
    orch = new MediaOrchestrator(provisioner, sharedState, () => 1000);
  });

  it("starts up to 3 events concurrently with isolated resources (N-5, 7.3, F-9)", async () => {
    const a = await orch.startEvent(spec("evt-a"));
    const b = await orch.startEvent(spec("evt-b"));
    const c = await orch.startEvent(spec("evt-c"));

    expect(orch.activeCount).toBe(3);
    // 各イベントは独立した SFU / 字幕 / 名前空間を持つ
    const sfus = new Set([a.sfuUrl, b.sfuUrl, c.sfuUrl]);
    expect(sfus.size).toBe(3);
    expect(a.valkeyNamespace).toBe("evt-a");
    expect(b.captionPipelineId).not.toBe(c.captionPipelineId);
  });

  it("rejects the 4th concurrent event (DESIGN.md F-9, max 3)", async () => {
    await orch.startEvent(spec("evt-a"));
    await orch.startEvent(spec("evt-b"));
    await orch.startEvent(spec("evt-c"));
    expect(MAX_CONCURRENT_EVENTS).toBe(3);
    await expect(orch.startEvent(spec("evt-d"))).rejects.toBeInstanceOf(ConcurrencyLimitError);
  });

  it("isolates shared state per event namespace (no cross-talk)", async () => {
    await orch.startEvent(spec("evt-a"));
    await orch.startEvent(spec("evt-b"));
    await sharedState.set("evt-a", "speaker:spk-1", "live");

    expect(await sharedState.get("evt-a", "speaker:spk-1")).toBe("live");
    // 別イベントの名前空間からは見えない
    expect(await sharedState.get("evt-b", "speaker:spk-1")).toBeUndefined();
  });

  it("stop destroys the stack, clears the namespace and frees a slot", async () => {
    await orch.startEvent(spec("evt-a"));
    await orch.startEvent(spec("evt-b"));
    await orch.startEvent(spec("evt-c"));
    await sharedState.set("evt-a", "k", "v");

    await orch.stopEvent("evt-a");
    expect(provisioner.destroyed).toContain("evt-a");
    expect(orch.activeCount).toBe(2);
    expect(await sharedState.get("evt-a", "k")).toBeUndefined();
    // 'evt-b' の状態は残る (干渉しない)
    expect(orch.isActive("evt-b")).toBe(true);

    // スロットが空いたので 4 つ目を起動できる
    await orch.startEvent(spec("evt-d"));
    expect(orch.activeCount).toBe(3);
  });

  it("startEvent is idempotent for an already-running event", async () => {
    const first = await orch.startEvent(spec("evt-a"));
    const second = await orch.startEvent(spec("evt-a"));
    expect(second.stackId).toBe(first.stackId);
    expect(provisioner.provisioned.filter((e) => e === "evt-a")).toHaveLength(1);
  });

  it("stopEvent on an unknown event is a no-op", async () => {
    await expect(orch.stopEvent("nope")).resolves.toBeUndefined();
  });
});
