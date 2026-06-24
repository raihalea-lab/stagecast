/**
 * API/操作エラーをユーザー表示用メッセージに正規化する (admin-web)。
 * control-api クライアントは `${method} ${path} failed (status): {body}` 形式の Error を投げるため、
 * 可能なら body の `error` フィールドを抽出して読みやすくする。
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    // 末尾の JSON ボディから { "error": "..." } を取り出せれば、それを優先表示する。
    const match = err.message.match(/\{.*\}\s*$/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { error?: unknown };
        if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
      } catch {
        // JSON でなければ素の message を使う。
      }
    }
    return err.message;
  }
  if (typeof err === "string" && err.trim()) return err;
  return "予期しないエラーが発生しました";
}
