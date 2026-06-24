import * as React from "react";
import type { LayoutKind } from "@stagecast/shared";
import { ALL_LAYOUTS, LAYOUT_LABELS } from "@stagecast/shared";
import { cn } from "../lib/cn.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../primitives/tooltip.js";

export interface LayoutPickerProps {
  value: LayoutKind;
  onChange: (next: LayoutKind) => void;
  disabled?: boolean;
}

/** Layout 種別ごとの 32x18 の SVG 線図 (Tile 構成の縮図)。 */
function LayoutThumb({ layout }: { layout: LayoutKind }) {
  const rectClass = "fill-none stroke-current stroke-[1.2]";
  switch (layout) {
    case "grid":
      return (
        <svg viewBox="0 0 32 18" className="size-full">
          <rect x="1" y="1" width="14" height="7" className={rectClass} />
          <rect x="17" y="1" width="14" height="7" className={rectClass} />
          <rect x="1" y="10" width="14" height="7" className={rectClass} />
          <rect x="17" y="10" width="14" height="7" className={rectClass} />
        </svg>
      );
    case "spotlight":
      return (
        <svg viewBox="0 0 32 18" className="size-full">
          <rect x="1" y="1" width="30" height="11" className={rectClass} />
          <rect x="1" y="13" width="9" height="4" className={rectClass} />
          <rect x="12" y="13" width="9" height="4" className={rectClass} />
          <rect x="23" y="13" width="8" height="4" className={rectClass} />
        </svg>
      );
    case "pip":
      return (
        <svg viewBox="0 0 32 18" className="size-full">
          <rect x="1" y="1" width="30" height="16" className={rectClass} />
          <rect x="22" y="11" width="8" height="5" className={rectClass} />
        </svg>
      );
    case "screen-share-main":
      return (
        <svg viewBox="0 0 32 18" className="size-full">
          <rect x="1" y="1" width="22" height="16" className={rectClass} />
          <rect x="24" y="1" width="7" height="5" className={rectClass} />
          <rect x="24" y="7" width="7" height="5" className={rectClass} />
          <rect x="24" y="13" width="7" height="4" className={rectClass} />
        </svg>
      );
    default:
      return null;
  }
}

/**
 * 4 layout を SVG サムネ付きで横並びに切替。
 * キーボード: ←→ で循環移動 / 1〜4 で直接選択。
 */
export function LayoutPicker({ value, onChange, disabled }: LayoutPickerProps) {
  function handleKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const idx = ALL_LAYOUTS.indexOf(value);
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = ALL_LAYOUTS[(idx + 1) % ALL_LAYOUTS.length];
      if (next) onChange(next);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = ALL_LAYOUTS[(idx - 1 + ALL_LAYOUTS.length) % ALL_LAYOUTS.length];
      if (next) onChange(next);
    } else if (/^[1-4]$/.test(e.key)) {
      e.preventDefault();
      const next = ALL_LAYOUTS[Number(e.key) - 1];
      if (next) onChange(next);
    }
  }
  return (
    <div role="radiogroup" aria-label="配信レイアウト" onKeyDown={handleKey} className="flex gap-2">
      {ALL_LAYOUTS.map((l, i) => {
        const selected = l === value;
        return (
          <Tooltip key={l}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={LAYOUT_LABELS[l]}
                disabled={disabled}
                onClick={() => onChange(l)}
                tabIndex={selected ? 0 : -1}
                className={cn(
                  "group relative flex flex-col items-center gap-1 rounded-md border bg-surface-1 px-2.5 py-2 transition-colors duration-fast",
                  selected
                    ? "border-preview-500 text-text-primary shadow-preview"
                    : "border-line-2 text-text-secondary hover:border-line-3 hover:text-text-primary",
                  disabled && "opacity-40 cursor-not-allowed",
                )}
              >
                <span className="block h-[36px] w-[60px] text-current">
                  <LayoutThumb layout={l} />
                </span>
                <span className="font-mono text-[10px] text-text-tertiary">{i + 1}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{LAYOUT_LABELS[l]}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
