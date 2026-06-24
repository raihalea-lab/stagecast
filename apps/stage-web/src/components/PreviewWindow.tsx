/**
 * PreviewWindow - 配信中の合成画面 (composer-template) を main 領域に大きく表示
 * (R17-Phase3 / P-13-followup-2, ADR 0012 D-6)。
 *
 * 当初は右下 picture-in-picture 風小窓 (240px) だったが、 ユーザー要望で
 * **登壇者ビューのメイン領域に配置** + **見切れなし** に変更 (P-13-followup-2)。
 *
 * 配置: コントロールバーや header の下に inline で挿入される。 16:9 aspect-ratio
 * で max-width 制限 (CSS 側) を持ち、 iframe の中身が常に完全表示される。
 *
 * 流れ:
 *  1. mount + open のタイミングで `/preview-token` を **招待トークン** で叩いて viewer-role token を取得
 *  2. composer-template URL に token / url を query param で渡して iframe で開く
 *  3. composer-template は subscriber-only で room.connect → 合成画面を描画
 *
 * 帯域コスト: iframe 表示中は LiveKit から subscriber として受信 (~1 Mbps)。
 * 「閉じる」ボタンで非表示にして帯域節約できる (再表示用ボタンが残る)。
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

  const iframeSrc =
    open && token
      ? `${composerTemplateUrl}?layout=grid&token=${encodeURIComponent(token.livekitToken)}&url=${encodeURIComponent(token.livekitUrl)}`
      : undefined;

  return (
    <section className="preview-section" aria-label="配信プレビュー">
      <div className="preview-section-header">
        <h2>配信プレビュー (配信中の合成画面)</h2>
        <button type="button" onClick={() => setOpen((p) => !p)} className="preview-section-toggle">
          {open ? "閉じる" : "開く"}
        </button>
      </div>
      {open && (
        <div className="preview-section-body">
          {error && <p className="preview-section-error">エラー: {error}</p>}
          {!error && !iframeSrc && <p className="preview-section-loading">接続中…</p>}
          {iframeSrc && (
            <iframe
              title="配信プレビュー (composer-template)"
              src={iframeSrc}
              className="preview-section-iframe"
              allow="autoplay"
            />
          )}
          <p className="preview-section-hint">
            ※ Egress と同じ composer-template を viewer role で表示しています。
            帯域消費を抑えるため不要時は「閉じる」を押してください。
          </p>
        </div>
      )}
    </section>
  );
}
