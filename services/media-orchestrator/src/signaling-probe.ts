/**
 * シグナリングの到達性 probe (ADR 0027 D-1)。
 *
 * ECS の RUNNING は**コンテナが起動したこと**しか意味しない。LiveKit の初期化・Caddy の
 * 証明書ロード・DNS 反映はその後に起こるので、外から実際に叩いて確かめる。
 *
 * ブラウザが最初に叩くのと同じ経路・同じ TLS 検証を通すのが肝。LiveKit 自身が返す
 * 200 / 401 は「生きている」、5xx は Caddy が上流 (LiveKit) に繋げていない印なので
 * 「配信できない」とみなす。
 */

/** probe のタイムアウト。reconcile の tick (60 秒) を塞がない範囲で短く取る。 */
export const SIGNALING_PROBE_TIMEOUT_MS = 1500;

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
    const res = await fetchImpl(toHttpUrl(livekitUrl), {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
    });
    // undici はボディを読むまでソケットをプールに返さない。warm な Lambda で毎分
    // 積み上がると、次の probe が ECONNRESET で偽の「応答なし」になる。
    await res.body?.cancel().catch(() => {});
    // **5xx は「応答あり」にしない。** Caddy と LiveKit は同一タスクの sidecar で起動順の
    // 保証が無く、LiveKit がまだ listen していない窓では Caddy が 502 を返す。これを ok に
    // すると「タスクはあるのに誰も入れない」という、本 ADR が拾いたい状態を取り逃がす。
    // LiveKit 自身はルートに 200、`/rtc/validate` に 401 を返すので 5xx は上流断だけ。
    if (res.status >= 500) {
      return { ok: false, error: `upstream not ready (HTTP ${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    // AbortError はタイムアウト。そのままだと "This operation was aborted" で読みにくい。
    return {
      ok: false,
      error: controller.signal.aborted ? `timeout after ${timeoutMs}ms` : describeError(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch の失敗理由を運用者が読める形にする。
 *
 * undici はタイムアウト以外のあらゆる失敗を `TypeError: fetch failed` にまとめ、実際の原因
 * (ECONNREFUSED / ENOTFOUND / CERT_HAS_EXPIRED 等) は `cause` にしか入らない。そのまま出すと
 * 証明書切れも SG 閉塞も DNS 未反映も全部「fetch failed」になり、画面から切り分けられない。
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return code ? `${err.message}: ${code} (${cause.message})` : `${err.message}: ${cause.message}`;
  }
  return err.message;
}
