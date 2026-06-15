import { describe, expect, it, vi } from "vitest";
import { withRetry } from "./retry.js";

const noSleep = async () => {};

describe("withRetry", () => {
  it("初回成功ならそのまま返す", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn, { sleep: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("一過性失敗の後に成功すれば再試行で回復する", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("transient");
      return "recovered";
    });
    const result = await withRetry(fn, { sleep: noSleep });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("全試行失敗で最後のエラーを throw する (retries 回 + 初回)", async () => {
    const fn = vi.fn(async () => {
      throw new Error("always");
    });
    await expect(withRetry(fn, { retries: 2, sleep: noSleep })).rejects.toThrow("always");
    expect(fn).toHaveBeenCalledTimes(3); // 初回 + 2 再試行
  });

  it("shouldRetry が false を返したら即 throw する", async () => {
    const fn = vi.fn(async () => {
      throw new Error("permanent");
    });
    await expect(
      withRetry(fn, { retries: 5, sleep: noSleep, shouldRetry: () => false }),
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("指数バックオフで待機し onRetry に遅延を渡す", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 4) throw new Error("x");
        return 0;
      },
      {
        baseDelayMs: 10,
        factor: 2,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    expect(delays).toEqual([10, 20, 40]);
  });

  it("maxDelayMs でバックオフを頭打ちにする", async () => {
    const delays: number[] = [];
    await withRetry(
      async () => {
        if (delays.length < 3) throw new Error("x");
        return 0;
      },
      {
        baseDelayMs: 100,
        factor: 10,
        maxDelayMs: 250,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    expect(delays).toEqual([100, 250, 250]);
  });
});
