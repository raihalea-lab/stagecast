import * as React from "react";
import { cn } from "../lib/cn.js";

export type MonoNumberTone = "primary" | "secondary" | "tertiary" | "warn";

export interface MonoNumberProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: number | string;
  unit?: string;
  /** ch 単位の最小幅 (右寄せ揃え用)。 例: 4 で "0000" 相当の幅を確保。 */
  width?: number;
  tone?: MonoNumberTone;
  /** 数値を右寄せに (デフォルト true)。 false なら左寄せ。 */
  align?: "left" | "right";
}

const toneClass: Record<MonoNumberTone, string> = {
  primary: "text-text-primary",
  secondary: "text-text-secondary",
  tertiary: "text-text-tertiary",
  warn: "text-warning",
};

/**
 * 等幅・tabular-numerics で数値を表示する。
 * dB / ms / fps / kbps / 参加者数 など、 「計測値らしさ」を出す要素全般に使う。
 */
export const MonoNumber = React.forwardRef<HTMLSpanElement, MonoNumberProps>(
  ({ value, unit, width, tone = "primary", align = "right", className, style, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "font-mono tabular-nums inline-flex items-baseline gap-1",
        align === "right" ? "justify-end text-right" : "text-left",
        toneClass[tone],
        className,
      )}
      style={{
        ...(width !== undefined ? { minWidth: `${width}ch` } : null),
        ...style,
      }}
      {...props}
    >
      <span>{value}</span>
      {unit && <span className="text-xs text-text-tertiary">{unit}</span>}
    </span>
  ),
);
MonoNumber.displayName = "MonoNumber";
