/**
 * イベント作成フォーム (DESIGN.md 8 章)。
 * タイトル/日時・字幕言語・YouTube送出言語・エンジン・独自API有効化・YouTube配信先を登録する。
 */
import { useState } from "react";
import type { LanguageCode } from "@stagecast/shared";
import {
  defaultFormValues,
  ENGINE_OPTIONS,
  LANGUAGE_OPTIONS,
  toCreateEventInput,
  validateForm,
  type EventFormValues,
} from "../lib/event-form.js";
import type { CreateEventInput } from "@stagecast/control-api";

export function EventForm(props: { onCreate: (input: CreateEventInput) => void; busy?: boolean }) {
  const [values, setValues] = useState<EventFormValues>(defaultFormValues());
  const [errors, setErrors] = useState<string[]>([]);

  const set = <K extends keyof EventFormValues>(key: K, value: EventFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

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
  };

  return (
    <form onSubmit={submit} className="event-form">
      <h2>新規イベント</h2>
      {errors.length > 0 && (
        <ul className="errors">
          {errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      )}
      <label>
        タイトル
        <input value={values.title} onChange={(e) => set("title", e.target.value)} />
      </label>
      <label>
        開催日時
        <input
          type="datetime-local"
          value={values.startsAt}
          onChange={(e) => set("startsAt", e.target.value)}
        />
      </label>

      <fieldset>
        <legend>字幕の対応言語</legend>
        {LANGUAGE_OPTIONS.map((lang) => (
          <label key={lang} className="inline">
            <input
              type="checkbox"
              checked={values.languages.includes(lang)}
              onChange={() => toggleLanguage(lang)}
            />
            {lang}
          </label>
        ))}
      </fieldset>

      <label>
        YouTube 送出言語 (1 言語)
        <select
          value={values.youtubeLanguage}
          onChange={(e) => set("youtubeLanguage", e.target.value as LanguageCode)}
        >
          {values.languages.map((lang) => (
            <option key={lang} value={lang}>
              {lang}
            </option>
          ))}
        </select>
      </label>

      <label>
        字幕エンジン
        <select
          value={values.engine}
          onChange={(e) => set("engine", e.target.value as EventFormValues["engine"])}
        >
          {ENGINE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <label className="inline">
        <input
          type="checkbox"
          checked={values.customApiEnabled}
          onChange={(e) => set("customApiEnabled", e.target.checked)}
        />
        独自字幕配信 API を有効化する (多言語・任意起動)
      </label>

      <label>
        YouTube RTMP URL
        <input value={values.rtmpUrl ?? ""} onChange={(e) => set("rtmpUrl", e.target.value)} />
      </label>
      <label>
        ストリームキー参照 (Secrets 名)
        <input
          value={values.streamKeyRef ?? ""}
          onChange={(e) => set("streamKeyRef", e.target.value)}
        />
      </label>

      <button type="submit" disabled={props.busy}>
        {props.busy ? "作成中…" : "イベントを作成"}
      </button>
    </form>
  );
}
