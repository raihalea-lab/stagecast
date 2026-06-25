import { useMemo } from "react";
import { ScheduleXCalendar, useCalendarApp } from "@schedule-x/react";
import { createViewWeek, createViewMonthGrid } from "@schedule-x/calendar";
import "@schedule-x/theme-default/dist/index.css";
import type { EventDefinition, EventRequest } from "@stagecast/shared";
import type { Temporal } from "temporal-polyfill";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function toCalendarDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDatetimeLocalFromZdt(zdt: Temporal.ZonedDateTime): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${zdt.year}-${pad(zdt.month)}-${pad(zdt.day)}T${pad(zdt.hour)}:${pad(zdt.minute)}`;
}

function toDatetimeLocalFromDate(pd: Temporal.PlainDate, hour = 9): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pd.year}-${pad(pd.month)}-${pad(pd.day)}T${pad(hour)}:00`;
}

const CALENDAR_DEFS = {
  draft: {
    colorName: "draft",
    label: "下書き",
    lightColors: { main: "#9ca3af", container: "#f3f4f6", onContainer: "#1f2937" },
    darkColors: { main: "#6b7280", container: "#374151", onContainer: "#f9fafb" },
  },
  scheduled: {
    colorName: "scheduled",
    label: "予定",
    lightColors: { main: "#3b82f6", container: "#dbeafe", onContainer: "#1e3a5f" },
    darkColors: { main: "#60a5fa", container: "#1e3a5f", onContainer: "#dbeafe" },
  },
  live: {
    colorName: "live",
    label: "配信中",
    lightColors: { main: "#ef4444", container: "#fee2e2", onContainer: "#7f1d1d" },
    darkColors: { main: "#f87171", container: "#7f1d1d", onContainer: "#fee2e2" },
  },
  ended: {
    colorName: "ended",
    label: "終了",
    lightColors: { main: "#d1d5db", container: "#f9fafb", onContainer: "#6b7280" },
    darkColors: { main: "#4b5563", container: "#1f2937", onContainer: "#d1d5db" },
  },
  request: {
    colorName: "request",
    label: "リクエスト",
    lightColors: { main: "#f59e0b", container: "#fef3c7", onContainer: "#78350f" },
    darkColors: { main: "#fbbf24", container: "#78350f", onContainer: "#fef3c7" },
  },
} as const;

export function CalendarView(props: {
  events: EventDefinition[];
  requests: EventRequest[];
  onEventClick: (eventId: string) => void;
  onDateTimeClick?: (dateTime: string) => void;
}) {
  const calendarEvents = useMemo(() => {
    const eventItems = props.events.map((e) => {
      const endFallback = e.endsAt ?? new Date(Date.parse(e.startsAt) + TWO_HOURS_MS).toISOString();
      return {
        id: e.id,
        title: e.title,
        start: toCalendarDateTime(e.startsAt),
        end: toCalendarDateTime(endFallback),
        _type: "event" as const,
        calendarId: e.status,
      };
    });
    const requestItems = props.requests
      .filter((r) => r.status === "pending")
      .map((r) => ({
        id: `req-${r.id}`,
        title: `[リクエスト] ${r.title}`,
        start: toCalendarDateTime(r.startsAt),
        end: toCalendarDateTime(r.endsAt),
        _type: "request" as const,
        calendarId: "request",
      }));
    return [...eventItems, ...requestItems];
  }, [props.events, props.requests]);

  const calendar = useCalendarApp({
    locale: "ja-JP",
    firstDayOfWeek: 1,
    views: [createViewWeek(), createViewMonthGrid()],
    defaultView: "month-grid",
    dayBoundaries: { start: "07:00", end: "23:00" },
    events: calendarEvents,
    calendars: CALENDAR_DEFS,
    callbacks: {
      onEventClick(calendarEvent) {
        const id = String(calendarEvent.id);
        if (id.startsWith("req-")) return;
        props.onEventClick(id);
      },
      onClickDateTime(dateTime) {
        props.onDateTimeClick?.(toDatetimeLocalFromZdt(dateTime));
      },
      onClickDate(date) {
        props.onDateTimeClick?.(toDatetimeLocalFromDate(date));
      },
    },
  });

  return (
    <div className="sx-calendar-wrapper w-full">
      <div className="flex flex-wrap items-center gap-3 pb-2 text-xs text-text-secondary">
        {Object.entries(CALENDAR_DEFS).map(([key, cal]) => (
          <span key={key} className="flex items-center gap-1.5">
            <span
              className="inline-block size-3 rounded-full"
              style={{ backgroundColor: cal.lightColors.main }}
            />
            {cal.label}
          </span>
        ))}
      </div>
      <div className="h-[520px]">
        <ScheduleXCalendar calendarApp={calendar} />
      </div>
    </div>
  );
}
