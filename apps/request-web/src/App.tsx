import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScheduleXCalendar, useCalendarApp } from "@schedule-x/react";
import { createViewWeek, createViewMonthGrid } from "@schedule-x/calendar";
import "@schedule-x/theme-default/dist/index.css";
import type { Temporal } from "temporal-polyfill";

// Schedule-X v4.6.0 uses the global Temporal for instanceof checks.
// Module-imported Temporal creates a different prototype chain, so we
// must use the same global instance to pass event validation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T = (globalThis as any).Temporal as typeof Temporal;
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Toaster,
} from "@stagecast/ui";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

function toTemporalZdt(iso: string): Temporal.ZonedDateTime {
  const d = new Date(iso);
  const epochMs = d.getTime();
  if (Number.isNaN(epochMs)) {
    return T.PlainDateTime.from(iso.replace(" ", "T")).toZonedDateTime(
      T.Now.timeZoneId(),
    );
  }
  return T.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(
    T.Now.timeZoneId(),
  );
}

function snapTo10Min(zdt: Temporal.ZonedDateTime): Temporal.ZonedDateTime {
  const rounded = Math.round(zdt.minute / 10) * 10;
  return zdt.with({ minute: rounded % 60, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })
    .add({ minutes: rounded >= 60 ? 10 : 0 });
}

function toDatetimeLocalFromZdt(zdt: Temporal.ZonedDateTime): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${zdt.year}-${pad(zdt.month)}-${pad(zdt.day)}T${pad(zdt.hour)}:${pad(zdt.minute)}`;
}

function toDatetimeLocalFromDate(pd: Temporal.PlainDate, hour = 9): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pd.year}-${pad(pd.month)}-${pad(pd.day)}T${pad(hour)}:00`;
}

function computeDefaultEndsAt(startsAt: string): string {
  if (!startsAt) return "";
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms + TWO_HOURS_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const SELECTION_EVENT_ID = "_selection_";

const LEGEND_DEFS = {
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
  selection: {
    colorName: "selection",
    label: "選択中",
    lightColors: { main: "#f59e0b", container: "#fef3c7", onContainer: "#78350f" },
    darkColors: { main: "#fbbf24", container: "#78350f", onContainer: "#fef3c7" },
  },
} as const;

interface CalendarEvent {
  id: string;
  title: string;
  start: Temporal.ZonedDateTime;
  end: Temporal.ZonedDateTime;
  calendarId: string;
}

interface PublicEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  status: string;
}

interface LocalRequest {
  title: string;
  startsAt: string;
  endsAt: string;
}

const DAY_START = 7;
const DAY_END = 23;
const DAY_SPAN = DAY_END - DAY_START;

function CalendarDisplay(props: {
  events: CalendarEvent[];
  onTimeRangeSelect: (start: string, end: string) => void;
}) {
  const dragStartRef = useRef<string | null>(null);
  const calRef = useRef<ReturnType<typeof useCalendarApp>>(null);
  const isDraggingRef = useRef(false);

  const upsertSelectionBlock = (startDt: string, endDt: string) => {
    const cal = calRef.current;
    if (!cal) return;
    const existing = cal.events.get(SELECTION_EVENT_ID);
    const evt = {
      id: SELECTION_EVENT_ID,
      title: "選択中",
      start: toTemporalZdt(startDt),
      end: toTemporalZdt(endDt),
      calendarId: "selection",
    };
    if (existing) {
      cal.events.update(evt);
    } else {
      cal.events.add(evt);
    }
  };

  const calcTimeFromY = (
    clientY: number,
    startZdt: Temporal.ZonedDateTime,
    dayCol: HTMLElement,
  ): string => {
    const relY = clientY - dayCol.getBoundingClientRect().top;
    const fraction = Math.max(0, Math.min(1, relY / dayCol.offsetHeight));
    const totalMin = DAY_START * 60 + fraction * DAY_SPAN * 60;
    const rounded = Math.round(totalMin / 10) * 10;
    const h = Math.min(DAY_END, Math.max(DAY_START, Math.floor(rounded / 60)));
    const m = rounded % 60;
    const zdt = startZdt.with({
      hour: h,
      minute: m,
      second: 0,
      millisecond: 0,
      microsecond: 0,
      nanosecond: 0,
    });
    return toDatetimeLocalFromZdt(zdt);
  };

  const calendar = useCalendarApp({
    locale: "ja-JP",
    firstDayOfWeek: 1,
    timezone: "Asia/Tokyo",
    views: [createViewWeek(), createViewMonthGrid()],
    defaultView: "month-grid",
    dayBoundaries: { start: "07:00", end: "23:00" },
    weekOptions: { gridStep: 60 },
    events: props.events,
    calendars: LEGEND_DEFS,
    callbacks: {
      onMouseDownDateTime(dateTime, mouseDownEvent) {
        const snapped = snapTo10Min(dateTime);
        const startDt = toDatetimeLocalFromZdt(snapped);
        dragStartRef.current = startDt;

        const target = mouseDownEvent.target as HTMLElement | null;
        const dayCol = target?.closest(".sx__time-grid-day") as HTMLElement | null;
        if (!dayCol) return;

        isDraggingRef.current = true;
        const initialEnd = toDatetimeLocalFromZdt(snapped.add({ minutes: 30 }));
        upsertSelectionBlock(startDt, initialEnd);

        const onMove = (e: MouseEvent) => {
          if (!isDraggingRef.current) return;
          const currentDt = calcTimeFromY(e.clientY, snapped, dayCol);
          const [s, en] =
            startDt < currentDt
              ? [startDt, currentDt]
              : [currentDt, startDt];
          if (s !== en) upsertSelectionBlock(s, en);
        };

        const onUp = () => {
          isDraggingRef.current = false;
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      },
      onClickDateTime(dateTime) {
        const clickedDt = toDatetimeLocalFromZdt(snapTo10Min(dateTime));
        const dragStart = dragStartRef.current;
        dragStartRef.current = null;

        let start: string;
        let end: string;
        if (dragStart && dragStart !== clickedDt) {
          [start, end] =
            dragStart < clickedDt
              ? [dragStart, clickedDt]
              : [clickedDt, dragStart];
        } else {
          start = clickedDt;
          end = computeDefaultEndsAt(clickedDt);
        }
        upsertSelectionBlock(start, end);
        props.onTimeRangeSelect(start, end);
      },
      onClickDate(date) {
        dragStartRef.current = null;
        const dt = toDatetimeLocalFromDate(date);
        const endDt = computeDefaultEndsAt(dt);
        upsertSelectionBlock(dt, endDt);
        props.onTimeRangeSelect(dt, endDt);
      },
    },
  });
  calRef.current = calendar;

  return (
    <div className="h-[520px] w-full">
      <ScheduleXCalendar calendarApp={calendar} />
    </div>
  );
}

export function App(props: { controlApiUrl: string }) {
  const [publicEvents, setPublicEvents] = useState<PublicEvent[] | null>(null);
  const [localRequests, setLocalRequests] = useState<LocalRequest[]>([]);
  const [formOpen, setFormOpen] = useState(true);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [title, setTitle] = useState("");
  const [requesterName, setRequesterName] = useState("");
  const [contactInfo, setContactInfo] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();

  const fetchPublicEvents = useCallback(async () => {
    try {
      const res = await fetch(`${props.controlApiUrl}/events/public`);
      if (res.ok) {
        setPublicEvents(await res.json());
        return;
      }
    } catch {
      // API未接続
    }
    setPublicEvents([]);
  }, [props.controlApiUrl]);

  useEffect(() => {
    void fetchPublicEvents();
  }, [fetchPublicEvents]);

  const calendarEvents = useMemo(() => {
    if (!publicEvents) return [];
    return publicEvents.map((e) => {
      const endFallback = e.endsAt ?? new Date(Date.parse(e.startsAt) + TWO_HOURS_MS).toISOString();
      return {
        id: e.id,
        title: e.title,
        start: toTemporalZdt(e.startsAt),
        end: toTemporalZdt(endFallback),
        calendarId: e.status,
      };
    });
  }, [publicEvents]);

  const setTimeRange = (start: string, end: string) => {
    setStartsAt(start);
    setEndsAt(end);
    setFormOpen(true);
    setSubmitted(false);
    setError(undefined);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !requesterName.trim() || !startsAt || !endsAt) {
      setError("必須項目を入力してください");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const res = await fetch(`${props.controlApiUrl}/event-requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requesterName: requesterName.trim(),
          contactInfo: contactInfo.trim() || undefined,
          title: title.trim(),
          startsAt,
          endsAt,
          description: description.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "送信に失敗しました" }));
        throw new Error((body as { error?: string }).error ?? "送信に失敗しました");
      }
      setLocalRequests((prev) => [...prev, { title: title.trim(), startsAt, endsAt }]);
      setSubmitted(true);
      setStartsAt("");
      setEndsAt("");
      setTitle("");
      setDescription("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  const formatLocalDateTime = (dt: string) => {
    const d = new Date(dt);
    if (Number.isNaN(d.getTime())) return dt;
    return d.toLocaleString("ja-JP", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="min-h-dvh bg-surface-0">
      <header className="border-b border-line-1 px-6 py-4">
        <h1 className="text-lg font-semibold text-text-primary">Stagecast イベントリクエスト</h1>
        <p className="text-sm text-text-secondary">
          カレンダーの空き時間をクリックまたは週表示でドラッグして、イベントをリクエストできます
        </p>
      </header>
      <div className="flex flex-col gap-6 p-6 lg:flex-row">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-3 pb-2 text-xs text-text-secondary">
            {Object.entries(LEGEND_DEFS).map(([key, cal]) => (
              <span key={key} className="flex items-center gap-1.5">
                <span
                  className="inline-block size-3 rounded-full"
                  style={{ backgroundColor: cal.lightColors.main }}
                />
                {cal.label}
              </span>
            ))}
          </div>
          {publicEvents === null ? (
            <div className="flex h-[520px] items-center justify-center text-sm text-text-secondary">
              読み込み中…
            </div>
          ) : (
            <CalendarDisplay events={calendarEvents} onTimeRangeSelect={setTimeRange} />
          )}
          {localRequests.length > 0 && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="mb-2 text-xs font-medium text-amber-800">送信済みリクエスト</p>
              <ul className="flex flex-col gap-1">
                {localRequests.map((r, i) => (
                  <li key={i} className="text-xs text-amber-700">
                    {r.title}（{formatLocalDateTime(r.startsAt)} 〜 {formatLocalDateTime(r.endsAt)}
                    ）
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {formOpen && (
          <div className="w-full lg:w-96">
            <Card>
              <CardHeader>
                <CardTitle>イベントリクエスト</CardTitle>
              </CardHeader>
              <CardContent>
                {submitted ? (
                  <div className="flex flex-col gap-3">
                    <p className="text-sm text-emerald-600">
                      リクエストを送信しました！管理者の承認をお待ちください。
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSubmitted(false);
                      }}
                    >
                      続けてリクエスト
                    </Button>
                  </div>
                ) : (
                  <form onSubmit={submit} className="flex flex-col gap-3">
                    {error && (
                      <p className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
                        {error}
                      </p>
                    )}
                    <div className="grid gap-1.5">
                      <Label htmlFor="rw-name">お名前 *</Label>
                      <Input
                        id="rw-name"
                        value={requesterName}
                        onChange={(e) => setRequesterName(e.target.value)}
                        placeholder="山田太郎"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="rw-contact">連絡先（メール / Slack / X など）</Label>
                      <Input
                        id="rw-contact"
                        value={contactInfo}
                        onChange={(e) => setContactInfo(e.target.value)}
                        placeholder="例: user@example.com, @slack_id"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="rw-title">イベントタイトル *</Label>
                      <Input
                        id="rw-title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="rw-starts">開始日時</Label>
                      <Input
                        id="rw-starts"
                        type="datetime-local"
                        value={startsAt}
                        onChange={(e) => {
                          setStartsAt(e.target.value);
                          setEndsAt(computeDefaultEndsAt(e.target.value));
                        }}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="rw-ends">終了日時</Label>
                      <Input
                        id="rw-ends"
                        type="datetime-local"
                        value={endsAt}
                        onChange={(e) => setEndsAt(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="rw-desc">説明</Label>
                      <textarea
                        id="rw-desc"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="rounded-md border border-line-2 bg-surface-1 px-3 py-2 text-sm text-text-primary"
                        rows={3}
                        maxLength={1000}
                      />
                    </div>
                    <Button type="submit" disabled={submitting}>
                      {submitting ? "送信中…" : "リクエストを送信"}
                    </Button>
                  </form>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
      <Toaster />
    </div>
  );
}
