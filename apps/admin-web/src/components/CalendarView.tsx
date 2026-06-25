import { useMemo } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import jaLocale from "@fullcalendar/core/locales/ja";
import type { EventClickArg } from "@fullcalendar/core";
import type { DateClickArg } from "@fullcalendar/interaction";
import type { EventDefinition, EventRequest } from "@stagecast/shared";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

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

export function CalendarView(props: {
  events: EventDefinition[];
  requests: EventRequest[];
  onEventClick: (eventId: string) => void;
  onDateTimeClick?: (dateTime: string) => void;
}) {
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

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-3 pb-2 text-xs text-text-secondary">
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
      </div>
      <div className="h-[520px]">
        <FullCalendar
          plugins={[
            dayGridPlugin,
            timeGridPlugin,
            interactionPlugin,
          ]}
          initialView="dayGridMonth"
          locale={jaLocale}
          firstDay={1}
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "dayGridMonth,timeGridWeek",
          }}
          slotMinTime="07:00:00"
          slotMaxTime="23:00:00"
          height="100%"
          events={calendarEvents}
          eventClick={(info: EventClickArg) => {
            const id = info.event.id;
            if (id.startsWith("req-")) return;
            props.onEventClick(id);
          }}
          dateClick={(info: DateClickArg) => {
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
      </div>
    </div>
  );
}
