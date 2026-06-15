/**
 * 汎用リトライ (指数バックオフ)。
 *
 * 配信中の一過性エラー (クラウド API の瞬断・スロットリング等) を握りつぶさず、
 * 短い指数バックオフで数回だけ再試行するための共通ユーティリティ。`sleep` を注入できるため、
 * 単体テストは実時間を待たずに完結する (CLAUDE.md テスト方針)。
 */

export interface RetryOptions {
  /** 初回失敗後の最大再試行回数 (既定 3 = 計 4 回試行)。 */
  retries?: number;
  /** 初回バックオフ (ms, 既定 50)。 */
  baseDelayMs?: number;
  /** バックオフ倍率 (既定 2)。 */
  factor?: number;
  /** バックオフ上限 (ms, 既定 2000)。 */
  maxDelayMs?: number;
  /** false を返すと即座に throw (恒久的エラーを無駄に再試行しない)。 */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** 再試行直前のフック (ログ等)。 */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** 待機関数 (テストで差し替え可能)。 */
  sleep?: (ms: number) => Promise<void>;
}

// shared は node/dom 非依存なので setTimeout は globalThis 越しに参照する。
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = (globalThis as { setTimeout?: (cb: () => void, ms: number) => unknown })
      .setTimeout;
    if (timer) timer(() => resolve(), ms);
    else resolve();
  });

/**
 * `fn` を成功するまで最大 `retries` 回再試行する。全試行が失敗したら最後のエラーを throw。
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const base = options.baseDelayMs ?? 50;
  const factor = options.factor ?? 2;
  const maxDelay = options.maxDelayMs ?? 2000;
  const sleep = options.sleep ?? defaultSleep;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const canRetry = attempt < retries && (options.shouldRetry?.(err, attempt + 1) ?? true);
      if (!canRetry) throw err;
      const delay = Math.min(maxDelay, base * factor ** attempt);
      options.onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
      attempt += 1;
    }
  }
}
