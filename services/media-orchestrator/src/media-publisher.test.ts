import { describe, expect, it } from "vitest";
import type { EventMediaInfo } from "@stagecast/shared";
import { createMediaPublisher, type MediaResolver, type MediaStore } from "./media-publisher.js";

function fakeStore() {
  const map = new Map<string, EventMediaInfo>();
  const store: MediaStore = {
    get: async (id) => map.get(id),
    put: async (id, media) => {
      map.set(id, media);
    },
    clear: async (id) => {
      map.delete(id);
    },
  };
  return { map, store };
}

function fakeResolver(table: Record<string, string | undefined>): MediaResolver {
  return {
    resolveLivekitUrl: async (id) => table[id],
  };
}

const FIXED_NOW = 1_700_000_000_000;

describe("MediaPublisher (ADR 0008 D-1)", () => {
  it("URL が解決でき未保存なら updated を返し DynamoDB に書く", async () => {
    const { map, store } = fakeStore();
    const resolver = fakeResolver({ e1: "wss://1.2.3.4:7880" });
    const pub = createMediaPublisher({ resolver, store, now: () => FIXED_NOW });
    const result = await pub.publish("e1");
    expect(result).toEqual({
      eventId: "e1",
      status: "updated",
      media: { livekitUrl: "wss://1.2.3.4:7880", readyAt: FIXED_NOW },
    });
    expect(map.get("e1")?.livekitUrl).toBe("wss://1.2.3.4:7880");
  });

  it("URL が解決でき同じ値が既に保存済みなら unchanged (書き込み不発)", async () => {
    const { map, store } = fakeStore();
    map.set("e1", { livekitUrl: "wss://1.2.3.4:7880", readyAt: 1 });
    const resolver = fakeResolver({ e1: "wss://1.2.3.4:7880" });
    const pub = createMediaPublisher({ resolver, store, now: () => FIXED_NOW });
    const result = await pub.publish("e1");
    expect(result.status).toBe("unchanged");
    // readyAt は変えない (上書きしない)。
    expect(map.get("e1")?.readyAt).toBe(1);
  });

  it("URL が解決でき異なる値が保存済みなら updated (上書き)", async () => {
    const { map, store } = fakeStore();
    map.set("e1", { livekitUrl: "wss://OLD:7880", readyAt: 1 });
    const resolver = fakeResolver({ e1: "wss://NEW:7880" });
    const pub = createMediaPublisher({ resolver, store, now: () => FIXED_NOW });
    const result = await pub.publish("e1");
    expect(result.status).toBe("updated");
    expect(map.get("e1")?.livekitUrl).toBe("wss://NEW:7880");
    expect(map.get("e1")?.readyAt).toBe(FIXED_NOW);
  });

  it("task IP が取れない (起動中) なら not-ready", async () => {
    const { store } = fakeStore();
    const resolver = fakeResolver({}); // 何も返さない
    const pub = createMediaPublisher({ resolver, store, now: () => FIXED_NOW });
    const result = await pub.publish("e1");
    expect(result.status).toBe("not-ready");
  });

  it("resolver が throw したら error 結果 (catch する、reconcile を止めない)", async () => {
    const { store } = fakeStore();
    const resolver: MediaResolver = {
      resolveLivekitUrl: async () => {
        throw new Error("ECS API failed");
      },
    };
    const pub = createMediaPublisher({ resolver, store, now: () => FIXED_NOW });
    const result = await pub.publish("e1");
    expect(result.status).toBe("error");
  });

  it("clear で events 行の media が消える", async () => {
    const { map, store } = fakeStore();
    map.set("e1", { livekitUrl: "wss://x", readyAt: 1 });
    const resolver = fakeResolver({});
    const pub = createMediaPublisher({ resolver, store, now: () => FIXED_NOW });
    const result = await pub.clear("e1");
    expect(result).toEqual({ eventId: "e1", status: "cleared" });
    expect(map.has("e1")).toBe(false);
  });
});
