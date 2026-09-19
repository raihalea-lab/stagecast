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
  draft: { backgroundColor: "#e6eff5", borderColor: "#8fa3ae", textColor: "#33414a" },
  scheduled: { backgroundColor: "#dbeaf2", borderColor: "#509ab7", textColor: "#1f4a5e" },
  live: { backgroundColor: "#fde8e8", borderColor: "#dc2626", textColor: "#7f1d1d" },
  ended: { backgroundColor: "#f1f6f9", borderColor: "#b8d3e2", textColor: "#607684" },
  request: { backgroundColor: "#fdf0e0", borderColor: "#c2740a", textColor: "#7c2d12" },
  selection: { backgroundColor: "#fff4d6", borderColor: "#b45309", textColor: "#78350f" },
} as const satisfies Record<string, CalendarEventColors>;
