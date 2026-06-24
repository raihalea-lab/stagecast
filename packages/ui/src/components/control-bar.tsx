import * as React from "react";
import { cn } from "../lib/cn.js";

export interface ControlBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 圧縮 mode (Moderator サブビュー右カラム用)。 */
  compact?: boolean;
}

/**
 * sticky bottom の IconButton 群コンテナ (stage-web の Mic/Camera/Screen + Slides + Leave)。
 * top hairline + surface-1 背景で「コックピットの操作パネル」感を出す。
 */
export const ControlBar = React.forwardRef<HTMLDivElement, ControlBarProps>(
  ({ compact, className, children, ...props }, ref) => (
    <div
      ref={ref}
      role="toolbar"
      className={cn(
        "sticky bottom-0 z-30 border-t border-line-2 bg-surface-1/95 backdrop-blur",
        compact ? "px-3 py-2" : "px-4 py-3",
        "flex flex-wrap items-center gap-3",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  ),
);
ControlBar.displayName = "ControlBar";
