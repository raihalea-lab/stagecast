import * as React from "react";
import type { EventStatus } from "@stagecast/shared";
import { cn } from "../lib/cn.js";
import { TallyIndicator } from "./tally-indicator.js";
import { MonoNumber } from "./mono-number.js";

export interface EventListItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  title: string;
  startsAt: string;
  status: EventStatus;
  active?: boolean;
}

function formatStartsAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const m = (d.getMonth() + 1).toString().padStart(2, "0");
    const day = d.getDate().toString().padStart(2, "0");
    const h = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${m}/${day} ${h}:${mm}`;
  } catch {
    return iso;
  }
}

/**
 * admin-web Sidebar の 1 行。 active 行は左端 2px tally バー (背景塗らない節制)。
 * live 中の event は右端に Tally on-air dot。
 */
export const EventListItem = React.forwardRef<HTMLButtonElement, EventListItemProps>(
  ({ title, startsAt, status, active, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-current={active ? "true" : undefined}
      className={cn(
        "group relative flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-fast",
        "hover:bg-surface-2",
        active && "bg-surface-2",
        className,
      )}
      {...props}
    >
      {active && <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-tally-500" />}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-text-primary">{title}</span>
        <MonoNumber
          value={formatStartsAt(startsAt)}
          tone="tertiary"
          align="left"
          className="text-xs"
        />
      </span>
      {status === "live" && <TallyIndicator state="on-air" size="sm" label="配信中" />}
      {status === "ended" && <TallyIndicator state="idle" size="sm" label="終了" />}
    </button>
  ),
);
EventListItem.displayName = "EventListItem";
