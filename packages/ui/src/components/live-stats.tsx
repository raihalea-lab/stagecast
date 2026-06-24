import * as React from "react";
import { cn } from "../lib/cn.js";
import { MonoNumber } from "./mono-number.js";

export interface LiveStatsData {
  /** kbps */
  bitrateKbps?: number;
  /** 直近秒のフレームドロップ累計。 */
  droppedFrames?: number;
  /** 字幕の確定遅延 (ミリ秒)。 */
  captionLagMs?: number;
  /** room の総 participant 数。 */
  participantCount?: number;
  /** 配信開始からの経過秒。 */
  elapsedSec?: number;
}

export interface LiveStatsProps {
  stats: LiveStatsData;
  className?: string;
}

/**
 * 配信統計を 5 指標 mono numerics で表示。 計測機器感の中核。
 */
export function LiveStats({ stats, className }: LiveStatsProps) {
  const items: { label: string; value: React.ReactNode }[] = [
    {
      label: "ビットレート",
      value:
        stats.bitrateKbps !== undefined ? (
          <MonoNumber value={stats.bitrateKbps} unit="kbps" width={5} align="left" />
        ) : (
          <MonoNumber value="-" tone="tertiary" align="left" />
        ),
    },
    {
      label: "ドロップ",
      value:
        stats.droppedFrames !== undefined ? (
          <MonoNumber
            value={stats.droppedFrames}
            width={4}
            tone={stats.droppedFrames > 0 ? "warn" : "primary"}
            align="left"
          />
        ) : (
          <MonoNumber value="-" tone="tertiary" align="left" />
        ),
    },
    {
      label: "字幕遅延",
      value:
        stats.captionLagMs !== undefined ? (
          <MonoNumber
            value={stats.captionLagMs}
            unit="ms"
            width={4}
            tone={stats.captionLagMs > 3000 ? "warn" : "primary"}
            align="left"
          />
        ) : (
          <MonoNumber value="-" tone="tertiary" align="left" />
        ),
    },
    {
      label: "参加者",
      value:
        stats.participantCount !== undefined ? (
          <MonoNumber value={stats.participantCount} width={2} align="left" />
        ) : (
          <MonoNumber value="-" tone="tertiary" align="left" />
        ),
    },
    {
      label: "経過",
      value:
        stats.elapsedSec !== undefined ? (
          <MonoNumber value={stats.elapsedSec} unit="s" width={5} align="left" />
        ) : (
          <MonoNumber value="-" tone="tertiary" align="left" />
        ),
    },
  ];
  return (
    <section
      aria-label="配信統計"
      className={cn(
        "grid grid-cols-2 gap-3 rounded-md border border-line-1 bg-surface-1 p-4",
        className,
      )}
    >
      {items.map((it) => (
        <div key={it.label} className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-text-tertiary">{it.label}</span>
          {it.value}
        </div>
      ))}
    </section>
  );
}
