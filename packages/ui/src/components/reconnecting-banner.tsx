import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/cn.js";
import { MonoNumber } from "./mono-number.js";

export type ReconnectingKind = "reconnecting" | "retry-progress";

export interface ReconnectingBannerProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "role"
> {
  kind: ReconnectingKind;
  /** retry-progress: 何回目の retry か (1-based)。 */
  attempt?: number;
  /** retry-progress: 次の retry までの残り秒数。 */
  nextWaitSec?: number;
  /** retry-progress: 経過秒数 (累計)。 */
  elapsedSec?: number;
  /** 上限 (retry-progress の母数)。 */
  maxSec?: number;
}

/**
 * 配信サーバ再接続 / 起動待ち retry の inline banner。 role="status" 付き。
 */
export function ReconnectingBanner({
  kind,
  attempt,
  nextWaitSec,
  elapsedSec,
  maxSec,
  className,
  ...props
}: ReconnectingBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning",
        className,
      )}
      {...props}
    >
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {kind === "reconnecting" ? (
        <span>配信サーバへ再接続中…</span>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>配信サーバ起動待ち</span>
          {attempt !== undefined && (
            <span className="text-text-tertiary">
              試行{" "}
              <MonoNumber value={attempt} width={2} tone="warn" align="left" className="inline" />
            </span>
          )}
          {nextWaitSec !== undefined && (
            <span className="text-text-tertiary">
              次回 <MonoNumber value={nextWaitSec} unit="s" width={3} />
            </span>
          )}
          {elapsedSec !== undefined && (
            <span className="text-text-tertiary">
              <MonoNumber value={elapsedSec} width={3} />
              {maxSec !== undefined && <span className="text-text-tertiary">/{maxSec}</span>}
              <span className="text-text-tertiary"> s</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
