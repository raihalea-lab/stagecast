import { describe, expect, it } from "vitest";
import { ValkeySharedStateStore, type ValkeyClient } from "./valkey-store.js";

class FakeValkey implements ValkeyClient {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keysByPrefix(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}

describe("ValkeySharedStateStore (DESIGN.md 3.2, N-5)", () => {
  it("namespaces keys per event and isolates events", async () => {
    const client = new FakeValkey();
    const store = new ValkeySharedStateStore(client);
    await store.set("evt-a", "speaker:1", "live");
    await store.set("evt-b", "speaker:1", "standby");

    expect(await store.get("evt-a", "speaker:1")).toBe("live");
    expect(await store.get("evt-b", "speaker:1")).toBe("standby");
    // 実キーは名前空間付き
    expect([...client.map.keys()]).toContain("stagecast:evt-a:speaker:1");
  });

  it("clearNamespace removes only that event keys", async () => {
    const client = new FakeValkey();
    const store = new ValkeySharedStateStore(client);
    await store.set("evt-a", "x", "1");
    await store.set("evt-a", "y", "2");
    await store.set("evt-b", "x", "3");

    await store.clearNamespace("evt-a");
    expect(await store.get("evt-a", "x")).toBeUndefined();
    expect(await store.get("evt-b", "x")).toBe("3");
  });
});
