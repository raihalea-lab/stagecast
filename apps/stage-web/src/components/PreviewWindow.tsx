/**
 * PreviewWindow - 配信中の合成画面 (composer-template) を main 領域に大きく表示
 * (R17-Phase3 / P-13-followup-2, ADR 0012 D-6)。
 *
 * D7: tally 枠 (赤=on-air / 緑=preview) で囲み、Card + Button で再構成。
 */
import { useEffect, useState } from "react";
import type { PreviewTokenResponse, StageClient } from "../api/stage-client.js";
import { Button, Card, CardContent, CardHeader, CardTitle, StatusPill } from "@stagecast/ui";
import { Eye, EyeOff } from "@stagecast/ui/icons";

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
    return null;
  }

  const iframeSrc =
    open && token
      ? `${composerTemplateUrl}?layout=grid&token=${encodeURIComponent(token.livekitToken)}&url=${encodeURIComponent(token.livekitUrl)}`
      : undefined;

  return (
    <Card className="overflow-hidden" aria-label="配信プレビュー">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2">
          <CardTitle className="text-base">配信プレビュー</CardTitle>
          <StatusPill variant="live" className="text-xs">
            ON AIR
          </StatusPill>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setOpen((p) => !p)}>
          {open ? (
            <>
              <EyeOff className="size-4" />
              <span className="ml-1.5">閉じる</span>
            </>
          ) : (
            <>
              <Eye className="size-4" />
              <span className="ml-1.5">開く</span>
            </>
          )}
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 pt-0">
          {error && (
            <div
              role="alert"
              className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-sm text-error"
            >
              エラー: {error}
            </div>
          )}
          {!error && !iframeSrc && (
            <p className="py-4 text-center text-sm text-text-secondary">接続中…</p>
          )}
          {iframeSrc && (
            <div className="overflow-hidden rounded-lg border-2 border-tally-500 shadow-[0_0_12px_rgba(220,38,38,0.25)]">
              <iframe
                title="配信プレビュー (composer-template)"
                src={iframeSrc}
                className="block w-full bg-black"
                style={{ aspectRatio: "16/9" }}
                allow="autoplay"
              />
            </div>
          )}
          <p className="text-xs text-text-tertiary">
            ※ Egress と同じ composer-template を viewer role で表示しています。
            帯域消費を抑えるため不要時は「閉じる」を押してください。
          </p>
        </CardContent>
      )}
    </Card>
  );
}
