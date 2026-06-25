import { useCallback, useEffect, useMemo, useState } from "react";
import { ScheduleXCalendar, useCalendarApp } from "@schedule-x/react";
import { createViewWeek, createViewMonthGrid } from "@schedule-x/calendar";
import "@schedule-x/theme-default/dist/index.css";
import type { Temporal } from "temporal-polyfill";
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

function computeDefaultEndsAt(startsAt: string): string {
  if (!startsAt) return "";
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms + TWO_HOURS_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const CALENDAR_DEFS = {
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

interface PublicEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  status: string;
}

export function App(props: { controlApiUrl: string }) {
  const [publicEvents, setPublicEvents] = useState<PublicEvent[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [title, setTitle] = useState("");
  const [requesterName, setRequesterName] = useState("");
  const [requesterEmail, setRequesterEmail] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();

  const fetchPublicEvents = useCallback(async () => {
    try {
      const res = await fetch(`${props.controlApiUrl}/events/public`);
      if (res.ok) setPublicEvents(await res.json());
    } catch {
      // API未接続
    }
  }, [props.controlApiUrl]);

  useEffect(() => {
    void fetchPublicEvents();
  }, [fetchPublicEvents]);

  const calendarEvents = useMemo(
    () =>
      publicEvents.map((e) => {
        const endFallback =
          e.endsAt ?? new Date(Date.parse(e.startsAt) + TWO_HOURS_MS).toISOString();
        return {
          id: e.id,
          title: e.title,
          start: toCalendarDateTime(e.startsAt),
          end: toCalendarDateTime(endFallback),
          calendarId: e.status,
        };
      }),
    [publicEvents],
  );

  const openForm = (dt: string) => {
    setStartsAt(dt);
    setEndsAt(computeDefaultEndsAt(dt));
    setFormOpen(true);
    setSubmitted(false);
    setError(undefined);
  };

  const calendar = useCalendarApp({
    locale: "ja-JP",
    firstDayOfWeek: 1,
    views: [createViewWeek(), createViewMonthGrid()],
    defaultView: "month-grid",
    dayBoundaries: { start: "07:00", end: "23:00" },
    events: calendarEvents,
    calendars: CALENDAR_DEFS,
    callbacks: {
      onClickDateTime(dateTime) {
        openForm(toDatetimeLocalFromZdt(dateTime));
      },
      onClickDate(date) {
        openForm(toDatetimeLocalFromDate(date));
      },
    },
  });

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
          requesterEmail: requesterEmail.trim() || undefined,
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
      setSubmitted(true);
      setTitle("");
      setDescription("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-dvh bg-surface-0">
      <header className="border-b border-line-1 px-6 py-4">
        <h1 className="text-lg font-semibold text-text-primary">Stagecast イベントリクエスト</h1>
        <p className="text-sm text-text-secondary">
          カレンダーの空き時間をクリックして、イベントをリクエストできます
        </p>
      </header>
      <div className="flex flex-col gap-6 p-6 lg:flex-row">
        <div className="flex-1">
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
          <div className="h-[520px] w-full">
            <ScheduleXCalendar calendarApp={calendar} />
          </div>
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
                    <Button variant="outline" onClick={() => setFormOpen(false)}>
                      閉じる
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
                      <Label htmlFor="rw-email">メールアドレス</Label>
                      <Input
                        id="rw-email"
                        type="email"
                        value={requesterEmail}
                        onChange={(e) => setRequesterEmail(e.target.value)}
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
