import * as React from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button, type ButtonProps } from "../primitives/button.js";

export interface AdminStageTokenResult {
  token: string;
  livekitUrl: string;
  expiresAt: number;
  stageUrl?: string;
}

export interface OpenStageButtonProps extends Omit<ButtonProps, "onClick" | "children"> {
  eventId: string;
  /** control-api を叩いて admin token を取得する callback。 */
  fetcher: (eventId: string) => Promise<AdminStageTokenResult>;
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
        const url = new URL(result.stageUrl ?? window.location.origin);
        url.searchParams.set("token", result.token);
        url.searchParams.set("url", result.livekitUrl);
        url.searchParams.set("eventId", eventId);
        window.open(url.toString(), "_blank", "noopener,noreferrer");
      }
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
