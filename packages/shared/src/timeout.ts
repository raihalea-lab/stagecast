/**
 * 非同期処理のタイムアウト (耐ハング)。
 *
 * 外部呼び出し (YouTube ingest・WebSocket 配信など) が応答せず固まると、`withRetry` は
 * 「失敗」を観測できないので永遠に待ってしまう。字幕パイプラインの `drain()` は配信完了を
 * 待ち合わせるため、固まった Sink 1 つが音声取り込み全体を止めてしまう。本ユーティリティは
 * 一定時間で `TimeoutError` を投げて呼び出し側 (リトライ等) に制御を返す。
 *
 * `setTimer` を注入できるので、単体テストは実時間を待たずに完結する (CLAUDE.md テスト方針)。
 */

/** 制限時間内に解決しなかったときに投げるエラー。`withRetry` の再試行対象にできる。 */
export class TimeoutError extends Error {
  constructor(message = "operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export interface TimeoutOptions {
  /** 制限時間 (ms)。0 以下なら無効 (そのまま待つ)。 */
  timeoutMs: number;
  /** TimeoutError のメッセージ。 */
  message?: string;
  /** タイマー登録 (テスト差し替え可)。既定は globalThis.setTimeout。 */
  setTimer?: (cb: () => void, ms: number) => unknown;
  /** タイマー解除 (テスト差し替え可)。既定は globalThis.clearTimeout。 */
  clearTimer?: (handle: unknown) => void;
}

// shared は node/dom 非依存なのでタイマーは globalThis 越しに参照する。
const defaultSetTimer = (cb: () => void, ms: number): unknown => {
  const t = (globalThis as { setTimeout?: (cb: () => void, ms: number) => unknown }).setTimeout;
  return t ? t(cb, ms) : undefined;
};
const defaultClearTimer = (handle: unknown): void => {
  const c = (globalThis as { clearTimeout?: (h: unknown) => void }).clearTimeout;
  if (c && handle !== undefined) c(handle);
};

/**
 * `fn()` を最大 `timeoutMs` だけ待つ。超過したら `TimeoutError` で reject する。
 * タイムアウト後に `fn` が遅れて解決/失敗しても unhandled rejection にはしない。
 */
export async function withTimeout<T>(fn: () => Promise<T>, options: TimeoutOptions): Promise<T> {
  const work = fn();
  if (!(options.timeoutMs > 0)) return work;

  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;
  let handle: unknown;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimer(() => reject(new TimeoutError(options.message)), options.timeoutMs);
  });
  // タイムアウトで race を抜けた後に work が遅れて reject しても握っておく。
  work.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimer(handle);
  }
}
