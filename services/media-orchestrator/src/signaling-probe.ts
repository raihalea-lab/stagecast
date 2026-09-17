/**
 * シグナリングの到達性 probe (ADR 0027 D-1)。
 *
 * ECS の RUNNING は**コンテナが起動したこと**しか意味しない。LiveKit の初期化・Caddy の
 * 証明書ロード・DNS 反映はその後に起こるので、外から実際に叩いて確かめる。
 *
 * ブラウザが最初に叩くのと同じ経路・同じ TLS 検証を通すのが肝。HTTP ステータスは問わない
 * (LiveKit はルートに 200、`/rtc/validate` に 401 を返す)。**応答が返ること**が
 * 「シグナリングが生きている」の定義。
 */

/** probe のタイムアウト。reconcile の tick (60 秒) を塞がない範囲で短く取る。 */
export const SIGNALING_PROBE_TIMEOUT_MS = 3000;

export interface SignalingProbeResult {
  ok: boolean;
  /** 到達できなかった理由 (接続拒否 / TLS 失敗 / タイムアウト)。ok のときは undefined。 */
  error?: string;
}

/** `wss://host` / `ws://host` を HTTP(S) に読み替える。LiveKit と Caddy は同じポートで話す。 */
export function toHttpUrl(livekitUrl: string): string {
  return livekitUrl.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
}

/**
 * シグナリングに到達できるか確かめる。**投げない** — 失敗は戻り値で表す。
 * probe の失敗で reconcile 全体を止めると、進捗表示そのものが更新されなくなる。
 */
export async function probeSignaling(
  livekitUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = SIGNALING_PROBE_TIMEOUT_MS,
): Promise<SignalingProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(toHttpUrl(livekitUrl), {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
    });
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // AbortError はタイムアウト。そのままだと "This operation was aborted" で読みにくい。
    return {
      ok: false,
      error: controller.signal.aborted ? `timeout after ${timeoutMs}ms` : reason,
    };
  } finally {
    clearTimeout(timer);
  }
}
