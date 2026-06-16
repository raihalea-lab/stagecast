/**
 * HttpStageClient の 503 retry (ADR 0008 D-3) のテスト。
 * 実際の fetch は stub し、sleep は即時 resolve。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { HttpStageClient } from "./stage-client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(responses: Array<{ status: number; body?: object }>) {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return {
      status: r.status,
      json: async () => r.body ?? {},
    } as Response;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

const okResponse = {
  status: 200,
  body: {
    ok: true,
    eventId: "e1",
    role: "speaker",
    room: "e1",
    identity: "speaker-1",
    livekitUrl: "wss://1.2.3.4:7880",
    livekitToken: "tok",
  },
};

describe("HttpStageClient.join (ADR 0008 D-3)", () => {
  it("200 が返ったらそのまま返す (リトライしない)", async () => {
    const fetchMock = stubFetch([okResponse]);
    const client = new HttpStageClient("http://api");
    const sleep = vi.fn(async () => {});
    const result = await client.join("token", undefined, { sleep });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("503 が続いた後に 200 が返ったらリトライ成功する", async () => {
    const fetchMock = stubFetch([
      { status: 503 },
      { status: 503 },
      okResponse,
    ]);
    const client = new HttpStageClient("http://api");
    const sleep = vi.fn(async () => {});
    const onRetry = vi.fn();
    const result = await client.join("token", undefined, { sleep, onRetry });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 1s, 2s の 2 回 sleep。
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      nextWaitSec: 1,
      elapsedSec: 0,
    });
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 2,
      nextWaitSec: 2,
      elapsedSec: 1,
    });
  });

  it("maxRetryWaitSec=60 で 503 が永続するなら諦めて media-unavailable を返す", async () => {
    stubFetch([{ status: 503 }]);
    const client = new HttpStageClient("http://api");
    const sleep = vi.fn(async () => {});
    const result = await client.join("token", undefined, {
      sleep,
      maxRetryWaitSec: 60,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("media-unavailable");
    // Backoff: 1+2+4+8+16+30=61 → 30 を入れる前に止まる。1+2+4+8+16=31 までは入れる。
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("maxRetryWaitSec=0 でリトライ無効、即 media-unavailable を返す", async () => {
    const fetchMock = stubFetch([{ status: 503 }]);
    const client = new HttpStageClient("http://api");
    const sleep = vi.fn(async () => {});
    const result = await client.join("token", undefined, {
      sleep,
      maxRetryWaitSec: 0,
    });
    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("401 等のリトライ対象外ステータスはそのまま返す", async () => {
    const fetchMock = stubFetch([{ status: 401, body: { ok: false, reason: "invalid" } }]);
    const client = new HttpStageClient("http://api");
    const sleep = vi.fn(async () => {});
    const result = await client.join("token", undefined, { sleep });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
