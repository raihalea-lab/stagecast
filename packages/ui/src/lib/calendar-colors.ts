/**
 * FullCalendar のイベント塗り。 admin-web と request-web で同じ表を使う。
 *
 * FullCalendar 本体の CSS はライト前提なので、ここもライト固定の直値。
 * 値は tokens.css の brand (予定) / tally (配信中) / warning (リクエスト) と揃えてある (ADR 0029)。
 */
export interface CalendarEventColors {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
}

export const CALENDAR_EVENT_COLORS = {
  draft: { backgroundColor: "#ececf5", borderColor: "#9a9aab", textColor: "#3a3a46" },
  scheduled: { backgroundColor: "#e4e3f6", borderColor: "#817dd4", textColor: "#3c3878" },
  live: { backgroundColor: "#fde8e8", borderColor: "#dc2626", textColor: "#7f1d1d" },
  ended: { backgroundColor: "#f4f4f8", borderColor: "#c9c7e8", textColor: "#6b6b7c" },
  request: { backgroundColor: "#fdf0e0", borderColor: "#c2740a", textColor: "#7c2d12" },
  selection: { backgroundColor: "#fff4d6", borderColor: "#b45309", textColor: "#78350f" },
} as const satisfies Record<string, CalendarEventColors>;
