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
 * 配信統計を mono numerics で表示。 計測機器感の中核。
 *
 * 値の無い指標は出さない (STAGE_UX_PLAN U-5)。「-」が並ぶと「壊れている」と読まれる。
 * 字幕遅延などは届く経路ができたら (U-13) 値を渡すだけで戻る。
 */
export function LiveStats({ stats, className }: LiveStatsProps) {
  const items: { label: string; value: React.ReactNode }[] = [];
  if (stats.bitrateKbps !== undefined) {
    items.push({
      label: "ビットレート",
      value: <MonoNumber value={stats.bitrateKbps} unit="kbps" width={5} align="left" />,
    });
  }
  if (stats.droppedFrames !== undefined) {
    items.push({
      label: "ドロップ",
      value: (
        <MonoNumber
          value={stats.droppedFrames}
          width={4}
          tone={stats.droppedFrames > 0 ? "warn" : "primary"}
          align="left"
        />
      ),
    });
  }
  if (stats.captionLagMs !== undefined) {
    items.push({
      label: "字幕遅延",
      value: (
        <MonoNumber
          value={stats.captionLagMs}
          unit="ms"
          width={4}
          tone={stats.captionLagMs > 3000 ? "warn" : "primary"}
          align="left"
        />
      ),
    });
  }
  if (stats.participantCount !== undefined) {
    items.push({
      label: "参加者",
      value: <MonoNumber value={stats.participantCount} width={2} align="left" />,
    });
  }
  if (stats.elapsedSec !== undefined) {
    items.push({
      label: "経過",
      value: <MonoNumber value={stats.elapsedSec} unit="s" width={5} align="left" />,
    });
  }
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
