/**
 * AWS SDK エラーの再試行可否分類 (ADR 0007 D-2)。
 *
 * AWS SDK v3 を import せずダックタイピングで判定するため、外部接続なしに単体テストできる。
 * 判定結果を `retryable` として元エラーに付け、共有 `withRetry` (retryable マーカー) が
 * 恒久エラー (認証・バリデーション・非対応言語など) を即断念できるようにする。
 */

/** AWS SDK v3 のサービス例外が持ちうるフィールド (必要分だけ duck-type)。 */
interface AwsLikeError {
  name?: string;
  $retryable?: unknown;
  $metadata?: { httpStatusCode?: number };
}

/** AWS SDK が再試行不能と分類する代表的な恒久エラー名。 */
const PERMANENT_ERROR_NAMES = new Set([
  "ValidationException",
  "AccessDeniedException",
  "UnrecognizedClientException",
  "UnsupportedLanguagePairException",
  "UnsupportedDisplayLanguageCodeException",
  "DetectedLanguageLowConfidenceException",
  "ResourceNotFoundException",
  "InvalidRequestException",
  "SerializationException",
]);

/**
 * AWS SDK エラーが一過性 (再試行する価値がある) か判定する。
 * 不明な形のエラーは「再試行寄り」に倒す (既定挙動の維持)。
 */
export function isRetryableAwsError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return true;
  const e = err as AwsLikeError;
  // SDK 自身が再試行可能と判定済み (スロットリング等) なら再試行。
  if (e.$retryable) return true;
  const status = e.$metadata?.httpStatusCode;
  if (typeof status === "number") {
    if (status === 429 || status === 408 || status >= 500) return true;
    if (status >= 400) return false; // その他 4xx は恒久
  }
  if (e.name && PERMANENT_ERROR_NAMES.has(e.name)) return false;
  return true;
}

/**
 * エラーに `retryable` フラグを付けて返す (オブジェクトのみ)。throw 前に通すことで
 * `withRetry` が恒久エラーを即断念できる。非オブジェクトはそのまま返す。
 */
export function tagAwsRetryable(err: unknown): unknown {
  if (typeof err !== "object" || err === null) return err;
  return Object.assign(err, { retryable: isRetryableAwsError(err) });
}
