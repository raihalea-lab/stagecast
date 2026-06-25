import { useCallback, useEffect, useMemo, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import jaLocale from "@fullcalendar/core/locales/ja";
import type { DateSelectArg, EventDropArg } from "@fullcalendar/core";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";
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
const SELECTION_ID = "_selection_";

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

function computeDefaultEndsAt(startsAt: string): string {
  if (!startsAt) return "";
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) return "";
  return toDatetimeLocal(new Date(ms + TWO_HOURS_MS));
}

const STATUS_COLORS: Record<
  string,
  { backgroundColor: string; borderColor: string; textColor: string }
> = {
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
  draft: {
    backgroundColor: "#f3f4f6",
    borderColor: "#9ca3af",
    textColor: "#1f2937",
  },
};

const SELECTION_COLORS = {
  backgroundColor: "#fef3c7",
  borderColor: "#f59e0b",
  textColor: "#78350f",
};

const LEGEND_ITEMS = [
  { label: "予定", color: "#3b82f6" },
  { label: "配信中", color: "#ef4444" },
  { label: "終了", color: "#d1d5db" },
  { label: "選択中", color: "#f59e0b" },
];

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
  publicEvents: PublicEvent[];
  startsAt: string;
  endsAt: string;
  onTimeRangeSelect: (start: string, end: string) => void;
}) {
  const events = useMemo(() => {
    const items = props.publicEvents.map((e) => ({
      id: e.id,
      title: e.title,
      start: e.startsAt,
      end:
        e.endsAt ??
        new Date(
          Date.parse(e.startsAt) + TWO_HOURS_MS,
        ).toISOString(),
      editable: false,
      ...(STATUS_COLORS[e.status] ?? STATUS_COLORS.scheduled),
    }));

    if (props.startsAt && props.endsAt) {
      items.push({
        id: SELECTION_ID,
        title: "選択中",
        start: props.startsAt,
        end: props.endsAt,
        editable: true,
        ...SELECTION_COLORS,
      });
    }

    return items;
  }, [props.publicEvents, props.startsAt, props.endsAt]);

  const handleSelect = useCallback(
    (info: DateSelectArg) => {
      if (info.allDay) {
        const start = toDatetimeLocal(info.start, 9, 0);
        const end = toDatetimeLocal(info.start, 11, 0);
        props.onTimeRangeSelect(start, end);
      } else {
        const diffMs =
          info.end.getTime() - info.start.getTime();
        if (diffMs <= 60 * 60 * 1000) {
          props.onTimeRangeSelect(
            toDatetimeLocal(info.start),
            computeDefaultEndsAt(toDatetimeLocal(info.start)),
          );
        } else {
          props.onTimeRangeSelect(
            toDatetimeLocal(info.start),
            toDatetimeLocal(info.end),
          );
        }
      }
      info.view.calendar.unselect();
    },
    [props.onTimeRangeSelect],
  );

  const handleEventChange = useCallback(
    (info: EventDropArg | EventResizeDoneArg) => {
      if (info.event.id !== SELECTION_ID) {
        info.revert();
        return;
      }
      if (info.event.start && info.event.end) {
        props.onTimeRangeSelect(
          toDatetimeLocal(info.event.start),
          toDatetimeLocal(info.event.end),
        );
      }
    },
    [props.onTimeRangeSelect],
  );

  return (
    <div className="h-[520px] w-full">
      <FullCalendar
        plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
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
        slotDuration="01:00:00"
        snapDuration="00:10:00"
        height="100%"
        selectable
        selectMirror
        unselectAuto={false}
        events={events}
        select={handleSelect}
        eventDrop={handleEventChange}
        eventResize={handleEventChange}
      />
    </div>
  );
}

export function App(props: { controlApiUrl: string }) {
  const [publicEvents, setPublicEvents] = useState<
    PublicEvent[] | null
  >(null);
  const [localRequests, setLocalRequests] = useState<
    LocalRequest[]
  >([]);
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
      const res = await fetch(
        `${props.controlApiUrl}/events/public`,
      );
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

  const setTimeRange = (start: string, end: string) => {
    setStartsAt(start);
    setEndsAt(end);
    setFormOpen(true);
    setSubmitted(false);
    setError(undefined);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !title.trim() ||
      !requesterName.trim() ||
      !startsAt ||
      !endsAt
    ) {
      setError("必須項目を入力してください");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const res = await fetch(
        `${props.controlApiUrl}/event-requests`,
        {
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
        },
      );
      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({ error: "送信に失敗しました" }));
        throw new Error(
          (body as { error?: string }).error ??
            "送信に失敗しました",
        );
      }
      setLocalRequests((prev) => [
        ...prev,
        { title: title.trim(), startsAt, endsAt },
      ]);
      setSubmitted(true);
      setStartsAt("");
      setEndsAt("");
      setTitle("");
      setDescription("");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "送信に失敗しました",
      );
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
        <h1 className="text-lg font-semibold text-text-primary">
          Stagecast イベントリクエスト
        </h1>
        <p className="text-sm text-text-secondary">
          カレンダーの空き時間をクリックまたは週表示でドラッグして、イベントをリクエストできます
        </p>
      </header>
      <div className="flex flex-col gap-6 p-6 lg:flex-row">
        <div className="flex-1">
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
          {publicEvents === null ? (
            <div className="flex h-[520px] items-center justify-center text-sm text-text-secondary">
              読み込み中…
            </div>
          ) : (
            <CalendarDisplay
              publicEvents={publicEvents}
              startsAt={startsAt}
              endsAt={endsAt}
              onTimeRangeSelect={setTimeRange}
            />
          )}
          {localRequests.length > 0 && (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
              <p className="mb-2 text-xs font-medium text-amber-800">
                送信済みリクエスト
              </p>
              <ul className="flex flex-col gap-1">
                {localRequests.map((r, i) => (
                  <li key={i} className="text-xs text-amber-700">
                    {r.title}（
                    {formatLocalDateTime(r.startsAt)} 〜{" "}
                    {formatLocalDateTime(r.endsAt)}）
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
                  <form
                    onSubmit={submit}
                    className="flex flex-col gap-3"
                  >
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
                        onChange={(e) =>
                          setRequesterName(e.target.value)
                        }
                        placeholder="山田太郎"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="rw-contact">
                        連絡先（メール / Slack / X など）
                      </Label>
                      <Input
                        id="rw-contact"
                        value={contactInfo}
                        onChange={(e) =>
                          setContactInfo(e.target.value)
                        }
                        placeholder="例: user@example.com, @slack_id"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="rw-title">
                        イベントタイトル *
                      </Label>
                      <Input
                        id="rw-title"
                        value={title}
                        onChange={(e) =>
                          setTitle(e.target.value)
                        }
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="rw-starts">
                        開始日時
                      </Label>
                      <Input
                        id="rw-starts"
                        type="datetime-local"
                        value={startsAt}
                        onChange={(e) => {
                          setStartsAt(e.target.value);
                          setEndsAt(
                            computeDefaultEndsAt(
                              e.target.value,
                            ),
                          );
                        }}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="rw-ends">終了日時</Label>
                      <Input
                        id="rw-ends"
                        type="datetime-local"
                        value={endsAt}
                        onChange={(e) =>
                          setEndsAt(e.target.value)
                        }
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="rw-desc">説明</Label>
                      <textarea
                        id="rw-desc"
                        value={description}
                        onChange={(e) =>
                          setDescription(e.target.value)
                        }
                        className="rounded-md border border-line-2 bg-surface-1 px-3 py-2 text-sm text-text-primary"
                        rows={3}
                        maxLength={1000}
                      />
                    </div>
                    <Button type="submit" disabled={submitting}>
                      {submitting
                        ? "送信中…"
                        : "リクエストを送信"}
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
