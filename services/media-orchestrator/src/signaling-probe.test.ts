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
  it("LiveKit 自身の応答 (200/401) なら ok", async () => {
    // LiveKit はルートに 200、/rtc/validate に 401 を返す。どちらも「生きている」。
    const fake = vi.fn(async (_url: string) => new Response("", { status: 401 }));
    expect(await probeSignaling("wss://x.example.com", fake as never)).toEqual({ ok: true });
    expect(fake.mock.calls[0]?.[0]).toBe("https://x.example.com");
  });

  it("5xx は ok にしない (Caddy は生きているが LiveKit に繋がっていない)", async () => {
    // Caddy と LiveKit は同一タスクの sidecar で起動順の保証が無い。LiveKit がまだ
    // listen していない窓では Caddy が 502 を返す。ここを ok にすると
    // 「タスクはあるのに誰も入れない」という、この probe が拾いたい状態を取り逃がす。
    const fake = vi.fn(async (_url: string) => new Response("", { status: 502 }));
    const res = await probeSignaling("wss://x.example.com", fake as never);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("502");
  });

  it("接続できなければ理由付きで ok:false を返す (投げない)", async () => {
    const fake = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const res = await probeSignaling("wss://x.example.com", fake as never);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("fetch failed");
  });

  it("undici の cause を展開する (でないと何が起きても fetch failed になる)", async () => {
    // 証明書切れも SG 閉塞も DNS 未反映も、undici は一律 "TypeError: fetch failed" にする。
    // 実際の原因は cause にしか入っていないので、そこを出さないと画面から切り分けられない。
    const cause = Object.assign(new Error("certificate has expired"), {
      code: "CERT_HAS_EXPIRED",
    });
    const fake = vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause });
    });
    const res = await probeSignaling("wss://x.example.com", fake as never);
    expect(res.error).toContain("CERT_HAS_EXPIRED");
    expect(res.error).toContain("certificate has expired");
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
