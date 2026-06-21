/**
 * LivePreview - composer-template を iframe で開いて配信中の合成画面をプレビュー (R17, ADR 0012 D-6)。
 *
 * 流れ:
 *  1. control-api `/events/{id}/preview-token` で viewer role の LiveKit token を取得
 *  2. composer-template URL に token / url を query param で渡して iframe で開く
 *  3. composer-template は token で room に subscriber として join → 全 publisher の合成画面を描画
 *
 * Egress と完全に同じテンプレート (= 同じ React app) を表示するので、 layout 切替・待機画面・
 * カメラ+画面共有同時表示も即座に admin-web から見える (sub-second)。
 *
 * 帯域コスト: iframe 表示中は LiveKit から subscriber として受信するため約 1 Mbps/視聴者。
 * デフォルト非表示 (toggle ボタンで開閉) にして必要時のみ subscribe する。
 */
import { useCallback, useEffect, useState } from "react";
import type { ControlApiClient, PreviewTokenResult } from "../api/types.js";
import { toErrorMessage } from "../lib/errors.js";

interface Props {
  eventId: string;
  client: ControlApiClient;
  composerTemplateUrl: string | undefined;
}

export function LivePreview(props: Props) {
  const { eventId, client, composerTemplateUrl } = props;
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<PreviewTokenResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  // 開いたタイミングで token を取得 (閉じるまで再利用)。 token TTL は 1 時間。
  useEffect(() => {
    if (!open || token) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    client
      .issuePreviewToken(eventId)
      .then((t) => {
        if (!cancelled) setToken(t);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, token, eventId, client]);

  const toggle = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  if (!composerTemplateUrl) {
    return (
      <section className="live-preview">
        <h3>ライブプレビュー</h3>
        <p className="error">composer-template URL が未設定です (runtime config を確認)。</p>
      </section>
    );
  }

  // iframe src: composer-template の URL に token/url を query param で渡す。
  // composer-template 側 main.tsx が URL params から token/url を読んで Room.connect する。
  const iframeSrc = token
    ? `${composerTemplateUrl}?layout=grid&token=${encodeURIComponent(token.livekitToken)}&url=${encodeURIComponent(token.livekitUrl)}`
    : undefined;

  return (
    <section className="live-preview">
      <h3>
        ライブプレビュー (配信中の合成画面){" "}
        <button type="button" onClick={toggle}>
          {open ? "閉じる" : "開く"}
        </button>
      </h3>
      {open && (
        <div className="live-preview-content">
          {loading && <p>プレビュー接続中…</p>}
          {error && <p className="error">エラー: {error}</p>}
          {iframeSrc && (
            <iframe
              title="配信プレビュー"
              src={iframeSrc}
              className="live-preview-iframe"
              // sandbox は付けない (LiveKit Client の getUserMedia/WebSocket が必要、 同オリジン扱い)。
              allow="autoplay; microphone; camera"
            />
          )}
          <p className="live-preview-hint">
            ※ Egress と同じ composer-template を viewer role で表示しています。 layout 切替も
            sub-second でこの画面に反映されます。 帯域消費を抑えるため不要時は閉じてください。
          </p>
        </div>
      )}
    </section>
  );
}
