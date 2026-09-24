import * as React from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn.js";
import { CALENDAR_EVENT_COLORS } from "../lib/calendar-colors.js";

/**
 * FullCalendar の周辺部品。admin-web の CalendarView と request-web が同じものを
 * 別々に書いていたので寄せた (UI 統一化 第 6 弾)。FullCalendar 本体は各アプリが持つ。
 */

export interface CalendarLegendItem {
  label: string;
  color: string;
}

export const DEFAULT_CALENDAR_LEGEND: readonly CalendarLegendItem[] = [
  { label: "下書き", color: CALENDAR_EVENT_COLORS.draft.borderColor },
  { label: "予定", color: CALENDAR_EVENT_COLORS.scheduled.borderColor },
  { label: "配信中", color: CALENDAR_EVENT_COLORS.live.borderColor },
  { label: "終了", color: CALENDAR_EVENT_COLORS.ended.borderColor },
  { label: "リクエスト", color: CALENDAR_EVENT_COLORS.request.borderColor },
];

export interface CalendarLegendProps {
  items?: readonly CalendarLegendItem[];
  /** 右端に置くもの (JST バッジや件数)。 */
  children?: React.ReactNode;
  className?: string;
}

export function CalendarLegend({
  items = DEFAULT_CALENDAR_LEGEND,
  children,
  className,
}: CalendarLegendProps) {
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-3 pb-2 text-xs text-text-secondary",
        className,
      )}
    >
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5">
          <span
            className="inline-block size-3 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </span>
      ))}
      {children}
    </div>
  );
}

export interface CalendarEventPopoverProps {
  title: string;
  startStr: string;
  endStr: string;
  /** 画面座標 (px)。呼び出し側が FullCalendar の要素位置から決める。 */
  top: number;
  left: number;
  onClose: () => void;
  /** 「詳細を見る」のような 1 つだけのアクション。 */
  action?: { label: string; onClick: () => void };
}

/**
 * カレンダーのイベントをクリックしたときの小さな吹き出し。
 * 背面の全画面 div で外側クリックを拾って閉じる。
 */
export function CalendarEventPopover({
  title,
  startStr,
  endStr,
  top,
  left,
  onClose,
  action,
}: CalendarEventPopoverProps) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        role="dialog"
        aria-label={title}
        className="fixed z-50 w-64 rounded-lg border border-line-1 bg-surface-0 p-3 shadow-overlay"
        style={{ top, left }}
      >
        <div className="flex items-start justify-between">
          <h3 className="text-sm font-medium text-text-primary">{title}</h3>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="ml-2 text-text-tertiary hover:text-text-primary"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="mt-1 text-xs text-text-secondary">
          {startStr} &ndash; {endStr} JST
        </p>
        {action && (
          <button
            type="button"
            className="mt-2 text-xs font-medium text-brand-text hover:underline"
            onClick={action.onClick}
          >
            {action.label} <span aria-hidden>&rarr;</span>
          </button>
        )}
      </div>
    </>
  );
}
