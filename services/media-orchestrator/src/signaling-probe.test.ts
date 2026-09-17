/**
 * シグナリング probe (ADR 0027 D-1)。
 *
 * ここで守りたいのは「probe が失敗しても投げない」こと。投げると reconcile が途中で止まり、
 * 進捗表示そのものが更新されなくなる (= 画面が古い状態で固まる)。
 */
import { describe, expect, it, vi } from "vitest";
import { probeSignaling, toHttpUrl } from "./signaling-probe.js";

describe("toHttpUrl", () => {
  it("wss / ws を http(s) に読み替える", () => {
    expect(toHttpUrl("wss://event-abc.media.example.com")).toBe(
      "https://event-abc.media.example.com",
    );
    expect(toHttpUrl("ws://10.0.0.1:7880")).toBe("http://10.0.0.1:7880");
  });
});

describe("probeSignaling", () => {
  it("応答が返れば ok (ステータスは問わない)", async () => {
    // LiveKit はルートに 200、/rtc/validate に 401 を返す。見たいのは到達性だけ。
    const fake = vi.fn(async (_url: string) => new Response("", { status: 401 }));
    expect(await probeSignaling("wss://x.example.com", fake as never)).toEqual({ ok: true });
    expect(fake.mock.calls[0]?.[0]).toBe("https://x.example.com");
  });

  it("接続できなければ理由付きで ok:false を返す (投げない)", async () => {
    const fake = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const res = await probeSignaling("wss://x.example.com", fake as never);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("fetch failed");
  });

  it("応答が返らなければタイムアウトとして打ち切る", async () => {
    // 証明書切れや SG 閉塞では応答が返らない。ここで待ち続けると tick を塞ぐ。
    const fake = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const res = await probeSignaling("wss://x.example.com", fake as never, 10);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("timeout after 10ms");
  });
});
