import * as React from "react";
import { cn } from "../lib/cn.js";
import { MonoNumber } from "./mono-number.js";

export type DeviceMeterOrientation = "h" | "v";
export type DeviceMeterSize = "sm" | "md" | "lg";

export interface DeviceMeterProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "role"> {
  /** 0..1 の音量 level (オーバー時は clamp)。 */
  level: number;
  orientation?: DeviceMeterOrientation;
  showDb?: boolean;
  size?: DeviceMeterSize;
  label?: string;
}

const hSizeClass: Record<DeviceMeterSize, string> = {
  sm: "h-1",
  md: "h-1.5",
  lg: "h-2.5",
};
const vSizeClass: Record<DeviceMeterSize, string> = {
  sm: "w-1",
  md: "w-1.5",
  lg: "w-2.5",
};

function levelToDb(level: number): number {
  const clamped = Math.max(0.0001, Math.min(1, level));
  return Math.round(20 * Math.log10(clamped));
}

/**
 * マイク音量メーター。 緑→黄→赤のリニアグラデーション + 任意で mono dB 表示。
 */
export function DeviceMeter({
  level,
  orientation = "h",
  showDb = false,
  size = "md",
  label,
  className,
  ...props
}: DeviceMeterProps) {
  const pct = Math.max(0, Math.min(1, level)) * 100;
  const db = levelToDb(level);
  return (
    <div
      role="meter"
      aria-label={label ?? "マイク音量"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn("flex items-center gap-2", orientation === "v" && "flex-col h-full", className)}
      {...props}
    >
      <div
        className={cn(
          "overflow-hidden rounded-full bg-surface-3",
          orientation === "h"
            ? cn("flex-1", hSizeClass[size])
            : cn("flex-1 w-fit", vSizeClass[size]),
        )}
      >
        <div
          className="h-full w-full origin-left bg-gradient-to-r from-preview-500 via-warning to-error transition-transform duration-fast"
          style={
            orientation === "h"
              ? { transform: `scaleX(${pct / 100})` }
              : {
                  transformOrigin: "bottom",
                  transform: `scaleY(${pct / 100})`,
                }
          }
        />
      </div>
      {showDb && <MonoNumber value={db} unit="dB" width={3} tone="secondary" className="text-xs" />}
    </div>
  );
}
