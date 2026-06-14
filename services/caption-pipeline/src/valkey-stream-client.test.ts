import { describe, expect, it } from "vitest";
import { ValkeyStreamClient, type RedisClientLike } from "./valkey-stream-client.js";
import { ValkeyStreamsCaptionBus } from "./valkey-bus.js";
import type { CaptionEvent } from "@stagecast/shared";

/** 最小限のインメモリ Redis 互換クライアント。 */
class MemoryRedis implements RedisClientLike {
  readonly streams = new Map<string, { id: string; payload: string }[]>();
  private waiters: (() => void)[] = [];
  private seq = 0;
  readonly xaddCalls: { stream: string; maxLen: number; payload: string }[] = [];

  async xadd(
    stream: string,
    _maxlenOp: "MAXLEN",
    _approx: "~",
    n: number,
    _star: "*",
    _field: string,
    value: string,
  ): Promise<string> {
    const id = `${++this.seq}-0`;
    const list = this.streams.get(stream) ?? [];
    list.push({ id, payload: value });
    // 近似トリム (テスト用に厳密に上限 n に絞る)。
    if (list.length > n) list.splice(0, list.length - n);
    this.streams.set(stream, list);
    this.xaddCalls.push({ stream, maxLen: n, payload: value });
    for (const wake of this.waiters) wake();
    this.waiters = [];
    return id;
  }

  async xread(...args: (string | number)[]): Promise<[string, [string, string[]][]][] | null> {
    // 引数: COUNT n BLOCK ms STREAMS stream lastId
    const blockMs = Number(args[3]);
    const stream = String(args[5]);
    const lastId = String(args[6]);
    const all = this.streams.get(stream) ?? [];
    const fresh = all.filter((e) => idGreater(e.id, lastId));
    if (fresh.length > 0) {
      return [[stream, fresh.map((e) => [e.id, ["payload", e.payload]])]];
    }
    // ブロック (短いタイムアウト)。
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.min(blockMs, 50));
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
    const after = (this.streams.get(stream) ?? []).filter((e) => idGreater(e.id, lastId));
    if (after.length === 0) return null;
    return [[stream, after.map((e) => [e.id, ["payload", e.payload]])]];
  }

  async quit(): Promise<unknown> {
    return null;
  }
}

function idGreater(a: string, b: string): boolean {
  if (b === "$" || b === "0-0") return true;
  return Number(a.split("-")[0]) > Number(b.split("-")[0]);
}

function caption(text: string): CaptionEvent {
  return { startMs: 0, endMs: 1000, language: "ja", text, status: "final" };
}

describe("ValkeyStreamClient (T3, ADR 0002)", () => {
  it("xadd は MAXLEN ~ N で近似トリミングを指定する", async () => {
    const redis = new MemoryRedis();
    const client = new ValkeyStreamClient({ client: redis, maxLen: 50, blockMs: 10 });
    await client.xadd("s:captions", '{"text":"hi"}');
    expect(redis.xaddCalls[0]).toMatchObject({
      stream: "s:captions",
      maxLen: 50,
      payload: '{"text":"hi"}',
    });
  });

  it("read は xadd で追加された分を順序保証で返す", async () => {
    const redis = new MemoryRedis();
    const client = new ValkeyStreamClient({ client: redis, blockMs: 50 });
    const signal = { aborted: false };
    const seen: { id: string; payload: string }[] = [];
    const iter = (async () => {
      for await (const msg of client.read("s", "$", signal)) {
        seen.push(msg);
        if (seen.length === 2) {
          signal.aborted = true;
          break;
        }
      }
    })();
    await client.xadd("s", "first");
    await client.xadd("s", "second");
    await iter;
    expect(seen.map((m) => m.payload)).toEqual(["first", "second"]);
  });

  it("ValkeyStreamsCaptionBus と組み合わせて publish/subscribe が往復する", async () => {
    const redis = new MemoryRedis();
    const client = new ValkeyStreamClient({ client: redis, blockMs: 30 });
    const bus = new ValkeyStreamsCaptionBus({ eventId: "evt-x", client });
    const got: CaptionEvent[] = [];
    const off = bus.subscribe((c) => got.push(c));
    // 購読ループが先に走るのを待ってから publish
    await new Promise((r) => setTimeout(r, 5));
    bus.publish(caption("こんにちは"));
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(got[0]?.text).toBe("こんにちは");
    off();
  });
});
