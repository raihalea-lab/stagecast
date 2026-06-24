import * as React from "react";
import { cn } from "../lib/cn.js";

export type TensionState = "offline" | "connecting" | "live" | "reconnecting" | "ended";

export interface LiveTensionBarProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "role"> {
  state: TensionState;
  metrics?: {
    latencyMs?: number;
    bitrateKbps?: number;
  };
}

const stateClass: Record<TensionState, string> = {
  offline: "bg-surface-3",
  connecting: "bg-info/80 animate-pulse",
  live: "bg-tally-500 animate-tally-pulse",
  reconnecting: "bg-warning/80 animate-pulse",
  ended: "bg-text-tertiary",
};

const stateLabel: Record<TensionState, string> = {
  offline: "オフライン",
  connecting: "接続中",
  live: "配信中",
  reconnecting: "再接続中",
  ended: "終了",
};

/**
 * 画面最上部に固定する 2px の極細インジケータ。 配信中のテンションを常時画面に滲ませる。
 * latency / bitrate などの metrics を将来 tooltip で見せる前提で props を受けるが、 D2 では未描画。
 */
export const LiveTensionBar = React.forwardRef<HTMLDivElement, LiveTensionBarProps>(
  ({ state, metrics: _metrics, className, ...props }, ref) => (
    <div
      ref={ref}
      role="status"
      aria-label={`配信状態: ${stateLabel[state]}`}
      className={cn(
        "fixed inset-x-0 top-0 z-50 h-[2px] w-full transition-colors duration-base ease-standard",
        stateClass[state],
        className,
      )}
      {...props}
    />
  ),
);
LiveTensionBar.displayName = "LiveTensionBar";
