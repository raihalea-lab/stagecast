import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import type { EventClickArg } from "@fullcalendar/core";
import type { DateClickArg } from "@fullcalendar/interaction";
import type { EventDefinition, EventRequest } from "@stagecast/shared";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const VIEW_STORAGE_KEY = "stagecast-admin-cal-view";

function toDatetimeLocal(
  d: Date,
  hour?: number,
  minute?: number,
): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = hour ?? d.getHours();
  const m = minute ?? d.getMinutes();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(h)}:${pad(m)}`;
}

function formatEventTime(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const STATUS_COLORS: Record<
  string,
  { backgroundColor: string; borderColor: string; textColor: string }
> = {
  draft: {
    backgroundColor: "#f3f4f6",
    borderColor: "#9ca3af",
    textColor: "#1f2937",
  },
  scheduled: {
    backgroundColor: "#dbeafe",
    borderColor: "#3b82f6",
    textColor: "#1e3a5f",
  },
  live: {
    backgroundColor: "#fee2e2",
    borderColor: "#ef4444",
    textColor: "#7f1d1d",
  },
  ended: {
    backgroundColor: "#f9fafb",
    borderColor: "#d1d5db",
    textColor: "#6b7280",
  },
  request: {
    backgroundColor: "#fef3c7",
    borderColor: "#f59e0b",
    textColor: "#78350f",
  },
};

const LEGEND_ITEMS = [
  { label: "下書き", color: "#9ca3af" },
  { label: "予定", color: "#3b82f6" },
  { label: "配信中", color: "#ef4444" },
  { label: "終了", color: "#d1d5db" },
  { label: "リクエスト", color: "#f59e0b" },
];

interface EventPopover {
  title: string;
  startStr: string;
  endStr: string;
  top: number;
  left: number;
  eventId: string | null;
}

export function CalendarView(props: {
  events: EventDefinition[];
  requests: EventRequest[];
  onEventClick: (eventId: string) => void;
  onDateTimeClick?: (dateTime: string) => void;
}) {
  const [popover, setPopover] = useState<EventPopover | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [calHeight, setCalHeight] = useState(500);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h && h > 0) setCalHeight(Math.floor(h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const calendarEvents = useMemo(() => {
    const eventItems = props.events.map((e) => ({
      id: e.id,
      title: e.title,
      start: e.startsAt,
      end:
        e.endsAt ??
        new Date(
          Date.parse(e.startsAt) + TWO_HOURS_MS,
        ).toISOString(),
      ...(STATUS_COLORS[e.status] ?? STATUS_COLORS.scheduled),
    }));
    const requestItems = props.requests
      .filter((r) => r.status === "pending")
      .map((r) => ({
        id: `req-${r.id}`,
        title: `[リクエスト] ${r.title}`,
        start: r.startsAt,
        end: r.endsAt,
        ...STATUS_COLORS.request,
      }));
    return [...eventItems, ...requestItems];
  }, [props.events, props.requests]);

  const handleEventClick = useCallback(
    (info: EventClickArg) => {
      const id = info.event.id;
      const isReq = id.startsWith("req-");
      const rect = info.el.getBoundingClientRect();
      setPopover({
        title: info.event.title,
        startStr: info.event.start
          ? formatEventTime(info.event.start)
          : "",
        endStr: info.event.end
          ? formatEventTime(info.event.end)
          : "",
        top: Math.min(
          rect.bottom + 4,
          window.innerHeight - 140,
        ),
        left: Math.min(rect.left, window.innerWidth - 280),
        eventId: isReq ? null : id,
      });
      info.jsEvent.stopPropagation();
    },
    [],
  );

  return (
    <div className="flex w-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 pb-2 text-xs text-text-secondary">
        {LEGEND_ITEMS.map((item) => (
          <span
            key={item.label}
            className="flex items-center gap-1.5"
          >
            <span
              className="inline-block size-3 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            {item.label}
          </span>
        ))}
        <span className="ml-auto rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary">
          JST (UTC+9)
        </span>
      </div>
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1"
      >
        <FullCalendar
          plugins={[
            dayGridPlugin,
            timeGridPlugin,
            interactionPlugin,
          ]}
          initialView={localStorage.getItem(VIEW_STORAGE_KEY) || "dayGridMonth"}
          datesSet={(arg) => localStorage.setItem(VIEW_STORAGE_KEY, arg.view.type)}
          firstDay={1}
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "dayGridMonth,timeGridWeek",
          }}
          allDaySlot={false}
          slotMinTime="07:00:00"
          slotMaxTime="23:00:00"
          slotLabelFormat={{
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }}
          height={calHeight}
          events={calendarEvents}
          eventClick={handleEventClick}
          dateClick={(info: DateClickArg) => {
            setPopover(null);
            if (info.allDay) {
              props.onDateTimeClick?.(
                toDatetimeLocal(info.date, 9, 0),
              );
            } else {
              props.onDateTimeClick?.(
                toDatetimeLocal(info.date),
              );
            }
          }}
        />
        {popover && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setPopover(null)}
            />
            <div
              className="fixed z-50 w-64 rounded-lg border border-line-1 bg-surface-0 p-3 shadow-lg"
              style={{ top: popover.top, left: popover.left }}
            >
              <div className="flex items-start justify-between">
                <h3 className="text-sm font-medium text-text-primary">
                  {popover.title}
                </h3>
                <button
                  type="button"
                  onClick={() => setPopover(null)}
                  className="ml-2 text-text-tertiary hover:text-text-primary"
                >
                  &times;
                </button>
              </div>
              <p className="mt-1 text-xs text-text-secondary">
                {popover.startStr} &ndash; {popover.endStr}{" "}
                JST
              </p>
              {popover.eventId && (
                <button
                  type="button"
                  className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-800"
                  onClick={() => {
                    const id = popover.eventId!;
                    setPopover(null);
                    props.onEventClick(id);
                  }}
                >
                  詳細を見る &rarr;
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
