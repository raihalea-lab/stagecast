import { useState } from "react";
import { EVENT_TIME_STEP_MIN, type LanguageCode } from "@stagecast/shared";
import {
  shiftEndsAt,
  defaultFormValues,
  ENGINE_OPTIONS,
  LANGUAGE_OPTIONS,
  toCreateEventInput,
  validateForm,
  type EventFormValues,
} from "../lib/event-form.js";
import type { CreateEventInput } from "@stagecast/control-api";
import { Button, DateTimeField, Input, Label } from "@stagecast/ui";

export function EventForm(props: {
  onCreate: (input: CreateEventInput) => void;
  busy?: boolean;
  initialStartsAt?: string;
  /** 複製時の初期値。全項目を埋める (呼び出し側は key でフォームを作り直すこと)。 */
  initialValues?: EventFormValues;
}) {
  const [values, setValues] = useState<EventFormValues>(
    props.initialValues ?? defaultFormValues(props.initialStartsAt),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [endsAtManual, setEndsAtManual] = useState(false);

  const set = <K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const setStartsAt = (v: string) => {
    setValues((prev) => {
      const next = { ...prev, startsAt: v };
      if (!endsAtManual) next.endsAt = shiftEndsAt(prev, v);
      return next;
    });
  };

  const setEndsAt = (v: string) => {
    setEndsAtManual(true);
    set("endsAt", v);
  };

  const toggleLanguage = (lang: LanguageCode) =>
    setValues((v) => ({
      ...v,
      languages: v.languages.includes(lang)
        ? v.languages.filter((l) => l !== lang)
        : [...v.languages, lang],
    }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const validation = validateForm(values);
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    setErrors([]);
    props.onCreate(toCreateEventInput(values));
    setValues(defaultFormValues());
    setEndsAtManual(false);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {errors.length > 0 && (
        <ul className="space-y-1 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
          {errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      )}
      <div className="grid gap-2">
        <Label htmlFor="ef-title">タイトル</Label>
        <Input id="ef-title" value={values.title} onChange={(e) => set("title", e.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="ef-starts">開始日時</Label>
        <DateTimeField
          id="ef-starts"
          value={values.startsAt}
          onChange={setStartsAt}
          stepMinutes={EVENT_TIME_STEP_MIN}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="ef-ends">終了日時</Label>
        <DateTimeField
          id="ef-ends"
          value={values.endsAt ?? ""}
          onChange={setEndsAt}
          stepMinutes={EVENT_TIME_STEP_MIN}
        />
        <p className="text-xs text-text-tertiary">
          未入力の場合、開始から 2 時間が自動設定されます
        </p>
      </div>

      <div className="grid gap-1 rounded-md border border-line-2 bg-surface-1 p-3">
        <label className="inline-flex items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={values.captionEnabled}
            onChange={(e) => set("captionEnabled", e.target.checked)}
            className="accent-brand-600"
          />
          字幕を出す
        </label>
        <p className="text-xs text-text-tertiary">
          オフにすると字幕ワーカーを起動しません。イベント 1 本あたりのコストが約 35%
          下がります。配信開始後の切り替えは反映されません。
        </p>
      </div>

      <fieldset className="grid gap-2" disabled={!values.captionEnabled}>
        <legend className="text-sm font-medium text-text-primary">字幕の対応言語</legend>
        <div className="flex flex-wrap gap-3">
          {LANGUAGE_OPTIONS.map((lang) => (
            <label
              key={lang}
              className="inline-flex items-center gap-1.5 text-sm text-text-secondary"
            >
              <input
                type="checkbox"
                checked={values.languages.includes(lang)}
                onChange={() => toggleLanguage(lang)}
                className="accent-brand-600"
              />
              {lang}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-2">
        <Label htmlFor="ef-yt-lang">YouTube 送出言語 (1 言語)</Label>
        <select
          disabled={!values.captionEnabled}
          id="ef-yt-lang"
          value={values.youtubeLanguage}
          onChange={(e) => set("youtubeLanguage", e.target.value as LanguageCode)}
          className="rounded-md border border-line-2 bg-surface-1 px-3 py-2 text-sm text-text-primary"
        >
          {values.languages.map((lang) => (
            <option key={lang} value={lang}>
              {lang}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="ef-engine">字幕エンジン</Label>
        <select
          disabled={!values.captionEnabled}
          id="ef-engine"
          value={values.engine}
          onChange={(e) => set("engine", e.target.value as EventFormValues["engine"])}
          className="rounded-md border border-line-2 bg-surface-1 px-3 py-2 text-sm text-text-primary"
        >
          {ENGINE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <label className="inline-flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          disabled={!values.captionEnabled}
          checked={values.captionEnabled && values.customApiEnabled}
          onChange={(e) => set("customApiEnabled", e.target.checked)}
          className="accent-brand-600"
        />
        独自字幕配信 API を有効化する
      </label>

      <div className="grid gap-2">
        <Label htmlFor="ef-rtmp">YouTube RTMP URL</Label>
        <Input
          id="ef-rtmp"
          value={values.rtmpUrl ?? ""}
          onChange={(e) => set("rtmpUrl", e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="ef-skey">ストリームキー参照 (Secrets 名)</Label>
        <Input
          id="ef-skey"
          value={values.streamKeyRef ?? ""}
          onChange={(e) => set("streamKeyRef", e.target.value)}
        />
      </div>

      <Button type="submit" disabled={props.busy}>
        {props.busy ? "作成中…" : "イベントを作成"}
      </Button>
    </form>
  );
}
