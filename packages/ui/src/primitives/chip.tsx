import * as React from "react";
import { cn } from "../lib/cn.js";

export interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean;
}

/**
 * 絞り込み用のトグルチップ (「すべて / 下書き / …」「タグ」)。
 * 選択中の色が画面ごとに黒だったり brand だったりしたので、brand に揃えた。
 * 選択状態は aria-pressed で伝える。
 */
export function Chip({ selected = false, className, ...props }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium transition-colors",
        selected
          ? "bg-brand-600 text-white"
          : "bg-surface-2 text-text-secondary hover:bg-surface-3",
        className,
      )}
      {...props}
    />
  );
}
