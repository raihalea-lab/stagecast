import * as React from "react";
import { cn } from "../lib/cn.js";

export type SwitchProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "role">;

/**
 * オン / オフのトグル。中身はネイティブ checkbox (`role="switch"`) で、見た目だけ CSS で作る。
 * 「字幕を出す」「独自字幕 API を有効化する」のような設定の ON/OFF に使う。
 * 複数選択 (対応言語など) は Checkbox。
 */
export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, checked, ...props }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      role="switch"
      aria-checked={checked}
      checked={checked}
      className={cn(
        "relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-surface-3 transition-colors duration-fast",
        "before:absolute before:left-0.5 before:top-0.5 before:size-4 before:rounded-full before:bg-white before:shadow before:transition-transform before:duration-fast",
        "checked:bg-brand-600 checked:before:translate-x-4",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Switch.displayName = "Switch";
