/**
 * PreviewWindow - 登壇者ビュー右下に「現在の配信」を picture-in-picture 風小窓で表示
 * (R17-Phase3, ADR 0012 D-6 受け入れ基準 6)。
 *
 * 流れ:
 *  1. mount 時に control-api `/preview-token` を **招待トークン** で叩いて viewer-role token を取得
 *  2. composer-template URL に token / url を query param で渡して iframe で開く
 *  3. composer-template は subscriber-only で room.connect → 合成画面を描画
 *
 * admin-web 側の LivePreview (R17-Phase2, `apps/admin-web/src/components/LivePreview.tsx`)
 * と機能は同じだが、 stage-web 専用に **右下小窓 (PiP 風)** UI + **招待トークン認証** を使う。
 *
 * 帯域コスト: iframe 表示中は LiveKit から subscriber として受信 (~1 Mbps)。 デフォルトは
 * 開いた状態で表示するが、 ✕ ボタンで非表示にできる (再表示は「プレビュー」ボタン)。
 */
import { useEffect, useState } from "react";
import type { PreviewTokenResponse, StageClient } from "../api/stage-client.js";

interface Props {
  client: StageClient;
  inviteToken: string;
  composerTemplateUrl: string | undefined;
}

export function PreviewWindow(props: Props) {
  const { client, inviteToken, composerTemplateUrl } = props;
  const [open, setOpen] = useState(true);
  const [token, setToken] = useState<PreviewTokenResponse | undefined>();
  const [error, setError] = useState<string | undefined>();

  // mount + open のタイミングで preview-token を取得 (閉じてる間は subscribe しない = 帯域節約)。
  useEffect(() => {
    if (!open || token) return;
    let cancelled = false;
    setError(undefined);
    client
      .issuePreviewToken(inviteToken)
      .then((t) => {
        if (!cancelled) setToken(t);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, token, client, inviteToken]);

  if (!composerTemplateUrl) {
    // composer-template URL が未設定の環境 (ローカル等) では何も表示しない。
    return null;
  }

  // 折りたたみ時の小さな「プレビュー」ボタン (再表示用)。
  if (!open) {
    return (
      <button
        type="button"
        className="preview-window-reopen"
        onClick={() => setOpen(true)}
        aria-label="プレビューを開く"
      >
        プレビュー
      </button>
    );
  }

  const iframeSrc = token
    ? `${composerTemplateUrl}?layout=grid&token=${encodeURIComponent(token.livekitToken)}&url=${encodeURIComponent(token.livekitUrl)}`
    : undefined;

  return (
    <aside className="preview-window" aria-label="配信プレビュー">
      <header className="preview-window-header">
        <span>配信プレビュー</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="プレビューを閉じる"
          className="preview-window-close"
        >
          ×
        </button>
      </header>
      {error ? (
        <p className="preview-window-error">エラー: {error}</p>
      ) : iframeSrc ? (
        <iframe
          title="配信プレビュー (composer-template)"
          src={iframeSrc}
          className="preview-window-iframe"
          allow="autoplay"
        />
      ) : (
        <p className="preview-window-loading">接続中…</p>
      )}
    </aside>
  );
}
