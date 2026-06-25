import * as React from "react";
import { cn } from "../lib/cn.js";
import { TallyIndicator } from "./tally-indicator.js";

export type StatusVariant =
  | "draft"
  | "scheduled"
  | "warmup"
  | "live"
  | "ended"
  | "ok"
  | "warn"
  | "loading"
  | "muted";

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant: StatusVariant;
  /** dot を表示するか (デフォルト true)。 */
  showDot?: boolean;
}

const variantClass: Record<StatusVariant, string> = {
  draft: "border-line-2 text-text-secondary bg-surface-2",
  scheduled: "border-blue-500 text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-950/30",
  warmup: "border-amber-500 text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-950/30",
  live: "border-tally-500 text-tally-50 bg-tally-700/30",
  ended: "border-line-1 text-text-tertiary bg-surface-2",
  ok: "border-preview-500 text-preview-500 bg-surface-2",
  warn: "border-warning text-warning bg-surface-2",
  loading: "border-line-2 text-text-tertiary bg-surface-2",
  muted: "border-line-1 text-text-tertiary bg-surface-2",
};

const variantLabel: Record<StatusVariant, string> = {
  draft: "下書き",
  scheduled: "予定",
  warmup: "準備中",
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
          state={
            variant === "live"
              ? "on-air"
              : variant === "ok"
                ? "preview"
                : variant === "warmup"
                  ? "preview"
                  : "idle"
          }
        />
      )}
      <span>{children ?? variantLabel[variant]}</span>
    </span>
  );
}
