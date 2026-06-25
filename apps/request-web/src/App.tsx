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

function CalendarDisplay(props: {
  events: CalendarEvent[];
  onTimeRangeSelect: (start: string, end: string) => void;
}) {
  const dragStartRef = useRef<string | null>(null);

  const calendar = useCalendarApp({
    locale: "ja-JP",
    firstDayOfWeek: 1,
    timezone: "Asia/Tokyo",
    views: [createViewWeek(), createViewMonthGrid()],
    defaultView: "month-grid",
    dayBoundaries: { start: "07:00", end: "23:00" },
    weekOptions: { gridStep: 15 },
    events: props.events,
    calendars: LEGEND_DEFS,
    callbacks: {
      onMouseDownDateTime(dateTime) {
        dragStartRef.current = toDatetimeLocalFromZdt(dateTime);
      },
      onClickDateTime(dateTime) {
        const clickedDt = toDatetimeLocalFromZdt(dateTime);
        const dragStart = dragStartRef.current;
        dragStartRef.current = null;

        if (dragStart && dragStart !== clickedDt) {
          const [start, end] =
            dragStart < clickedDt ? [dragStart, clickedDt] : [clickedDt, dragStart];
          props.onTimeRangeSelect(start, end);
        } else {
          props.onTimeRangeSelect(clickedDt, computeDefaultEndsAt(clickedDt));
        }
      },
      onClickDate(date) {
        dragStartRef.current = null;
        const dt = toDatetimeLocalFromDate(date);
        props.onTimeRangeSelect(dt, computeDefaultEndsAt(dt));
      },
    },
  });

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
