import * as React from "react";
import { cn } from "../lib/cn.js";

export type BadgeVariant = "neutral" | "secondary" | "brand" | "success" | "warning" | "error";

const variantClass: Record<BadgeVariant, string> = {
  neutral: "bg-surface-2 text-text-secondary",
  secondary: "bg-surface-3 text-text-secondary",
  brand: "bg-brand-600 text-white",
  success: "bg-success/15 text-success",
  warning: "bg-warning text-white",
  error: "bg-error/15 text-error",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

/**
 * 小さなラベル (タグ、件数、「カレンダーに公開」など)。
 * 各アプリが `text-[10px]` の span を手書きしていたので 1 つにした。文字サイズは `text-2xs`。
 * 状態 (下書き / 配信中 …) は StatusPill を使う。
 */
export function Badge({ variant = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-2xs font-medium",
        variantClass[variant],
        className,
      )}
      {...props}
    />
  );
}
