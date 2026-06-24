import * as React from "react";
import { cn } from "../lib/cn.js";

export type TallyState = "idle" | "preview" | "on-air";
export type TallySize = "sm" | "md" | "lg";

export interface TallyIndicatorProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "role"> {
  state: TallyState;
  size?: TallySize;
  pulse?: boolean;
  label?: string;
}

const sizeMap: Record<TallySize, string> = {
  sm: "size-2",
  md: "size-3",
  lg: "size-4",
};

const stateLabel: Record<TallyState, string> = {
  idle: "待機",
  preview: "プレビュー",
  "on-air": "オンエア",
};

/**
 * 放送機材の Tally Light を再解釈した 8/12/16px 発光 dot。
 * "on-air" は赤 + 脈動、"preview" は緑 (静的)、"idle" は無彩色。
 * 状態は ARIA Live Region として screen reader にも伝わる。
 */
export const TallyIndicator = React.forwardRef<HTMLSpanElement, TallyIndicatorProps>(
  ({ state, size = "md", pulse = true, label, className, ...props }, ref) => {
    const stateClasses =
      state === "on-air"
        ? cn("bg-tally-500", pulse && "animate-tally-pulse")
        : state === "preview"
          ? "bg-preview-500 shadow-preview"
          : "bg-surface-4";
    return (
      <span
        ref={ref}
        role="status"
        aria-label={label ?? `Tally: ${stateLabel[state]}`}
        className={cn(
          "inline-block rounded-full ring-1 ring-line-2",
          sizeMap[size],
          stateClasses,
          className,
        )}
        {...props}
      />
    );
  },
);
TallyIndicator.displayName = "TallyIndicator";
