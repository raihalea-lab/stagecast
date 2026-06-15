import { describe, expect, it, vi } from "vitest";
import { TimeoutError, withTimeout } from "./timeout.js";

// 発火しないタイマー (期限内に解決するケース用)。
const noFireTimer = (_cb: () => void, _ms: number) => 1;
// 即時発火タイマー (タイムアウトを決定的に起こすケース用)。
const fireNowTimer = (cb: () => void, _ms: number) => {
  cb();
  return 1;
};

describe("withTimeout", () => {
  it("期限内に解決すれば値を返し、タイマーは解除される", async () => {
    const clearTimer = vi.fn();
    const result = await withTimeout(async () => "ok", {
      timeoutMs: 1000,
      setTimer: noFireTimer,
      clearTimer,
    });
    expect(result).toBe("ok");
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });

  it("期限超過で TimeoutError を投げる", async () => {
    await expect(
      withTimeout(() => new Promise<string>(() => {}), {
        timeoutMs: 5,
        setTimer: fireNowTimer,
        message: "sink timed out",
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("timeoutMs <= 0 ならタイマーを使わずそのまま待つ", async () => {
    const setTimer = vi.fn(noFireTimer);
    expect(await withTimeout(async () => 42, { timeoutMs: 0, setTimer })).toBe(42);
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("タイムアウト後に work が遅れて reject しても unhandled にならない", async () => {
    let rejectWork: (e: unknown) => void = () => {};
    const work = new Promise<string>((_resolve, reject) => {
      rejectWork = reject;
    });
    const p = withTimeout(() => work, { timeoutMs: 5, setTimer: fireNowTimer });
    await expect(p).rejects.toBeInstanceOf(TimeoutError);
    // race を抜けた後に元の処理が失敗してもプロセスを汚さない (catch 済み)。
    rejectWork(new Error("late failure"));
    await Promise.resolve();
  });

  it("fn の失敗は期限内ならそのまま伝播する", async () => {
    await expect(
      withTimeout(
        async () => {
          throw new Error("boom");
        },
        { timeoutMs: 1000, setTimer: noFireTimer },
      ),
    ).rejects.toThrow("boom");
  });
});
