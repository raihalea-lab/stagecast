import * as React from "react";
import { cn } from "../lib/cn.js";
import { TallyIndicator } from "./tally-indicator.js";

export type StatusVariant = "draft" | "live" | "ended" | "ok" | "warn" | "loading" | "muted";

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant: StatusVariant;
  /** dot を表示するか (デフォルト true)。 */
  showDot?: boolean;
}

const variantClass: Record<StatusVariant, string> = {
  draft: "border-line-2 text-text-secondary bg-surface-2",
  live: "border-tally-500 text-tally-50 bg-tally-700/30",
  ended: "border-line-1 text-text-tertiary bg-surface-2",
  ok: "border-preview-500 text-preview-500 bg-surface-2",
  warn: "border-warning text-warning bg-surface-2",
  loading: "border-line-2 text-text-tertiary bg-surface-2",
  muted: "border-line-1 text-text-tertiary bg-surface-2",
};

const variantLabel: Record<StatusVariant, string> = {
  draft: "下書き",
  live: "配信中",
  ended: "終了",
  ok: "OK",
  warn: "要確認",
  loading: "読み込み中",
  muted: "未設定",
};

/**
 * 配信状態 / 設定状態を示す小さな badge。 旧 .badge-* CSS class の置換。
 * live のみ Tally on-air dot で脈動。
 */
export function StatusPill({
  variant,
  showDot = true,
  className,
  children,
  ...props
}: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium leading-tight",
        variantClass[variant],
        className,
      )}
      {...props}
    >
      {showDot && (
        <TallyIndicator
          size="sm"
          state={variant === "live" ? "on-air" : variant === "ok" ? "preview" : "idle"}
        />
      )}
      <span>{children ?? variantLabel[variant]}</span>
    </span>
  );
}
