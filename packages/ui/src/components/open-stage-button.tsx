import * as React from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button, type ButtonProps } from "../primitives/button.js";

export interface AdminStageTokenResult {
  token: string;
  livekitUrl: string;
  expiresAt: number;
  /** 開く stage-web の origin。 サーバが必ず返す (admin-web とは別 origin)。 */
  stageUrl: string;
  /** プレビュー iframe 用の viewer token。 親ページと identity を分けるため別建てで受け取る。 */
  previewToken: string;
  /** stage-web が `/stage/*` を叩くための招待トークン (ADR 0025 D-3)。 */
  inviteToken: string;
}

export interface OpenStageButtonProps extends Omit<ButtonProps, "onClick" | "children"> {
  eventId: string;
  /** control-api を叩いて admin token を取得する callback。 */
  fetcher: (eventId: string) => Promise<AdminStageTokenResult>;
  /** 取得先の取得・URL 組み立てが失敗したときの通知。 未指定だと無言で終わる。 */
  onError?: (err: unknown) => void;
  /** 取得後に開く URL の組み立て。 デフォルトは stageUrl + ?token=...&url=... */
  open?: (result: AdminStageTokenResult) => void;
  label?: string;
}

/**
 * admin が stage-web の Admin サブビューに入るための入口ボタン。
 * クリックで control-api `/admin/events/:id/stage-token` を呼び、 新タブで stage-web を開く。
 * D7-backend で fetcher の実体が用意される。
 */
export function OpenStageButton({
  eventId,
  fetcher,
  open,
  onError,
  label = "配信画面を開く",
  ...buttonProps
}: OpenStageButtonProps) {
  const [busy, setBusy] = React.useState(false);
  async function handleClick() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await fetcher(eventId);
      if (open) {
        open(result);
      } else {
        const url = new URL(result.stageUrl);
        url.searchParams.set("token", result.token);
        url.searchParams.set("url", result.livekitUrl);
        url.searchParams.set("eventId", eventId);
        // 旧 Lambda は返さない。 set すると文字列 "undefined" が載り、 壊れた token で
        // iframe が描画される (型は必須でも実 API は追いついていない)。
        if (result.previewToken) url.searchParams.set("previewToken", result.previewToken);
        if (result.inviteToken) url.searchParams.set("inviteToken", result.inviteToken);
        window.open(url.toString(), "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      // async な onClick の例外は unhandledrejection に消えるだけで画面に何も出ない。
      onError?.(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button onClick={handleClick} disabled={busy || buttonProps.disabled} {...buttonProps}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
      {label}
    </Button>
  );
}
