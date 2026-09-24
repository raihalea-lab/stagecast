/**
 * 日時の表示・変換ヘルパー。admin-web / request-web / packages/ui で同じものを
 * 別々に持っていたので 1 本にした (UI 統一化 第 1 弾)。
 *
 * フォームの値は `<input type="datetime-local">` と同じ `YYYY-MM-DDTHH:mm` (ローカル時刻)。
 * 保存済みの startsAt は `Z` 付き ISO なので、フォームに戻すときは必ず toDatetimeLocal を通す。
 */
import { DEFAULT_EVENT_DURATION_MS } from "./event.js";

/** 開始・終了日時の刻み (分)。DateTimeField の選択肢と、複製時の検証の両方で使う。 */
export const EVENT_TIME_STEP_MIN = 10;

export const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Date か ISO 文字列 → `YYYY-MM-DDTHH:mm` (ローカル時刻)。壊れた入力は `""`。
 * `hour` / `minute` を渡すと時刻を上書きする (カレンダーの日付クリックで 09:00 にする用)。
 */
export function toDatetimeLocal(
  input: Date | string | undefined,
  hour?: number,
  minute?: number,
): string {
  if (input === undefined || input === "") return "";
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  const h = hour ?? d.getHours();
  const m = minute ?? d.getMinutes();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(h)}:${pad2(m)}`;
}

/** 終了日時の既定値 (開始 + DEFAULT_EVENT_DURATION_MS)。 */
export function computeDefaultEndsAt(startsAt: string): string {
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) return "";
  return toDatetimeLocal(new Date(ms + DEFAULT_EVENT_DURATION_MS));
}

/** カレンダーのポップオーバー等で使う短い日時表示。`7/1 09:05`。 */
export function formatEventTime(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
