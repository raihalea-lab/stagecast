/**
 * イベント設定フォームのドメインロジック (DESIGN.md 8 章)。純粋関数でテスト可能にする。
 */
import {
  isCaptionEnabled,
  isValidCaptionSettings,
  SUPPORTED_LANGUAGES,
  type CaptionEngineKind,
  type EventDefinition,
  type LanguageCode,
} from "@stagecast/shared";
import type { CreateEventInput } from "@stagecast/control-api";

export interface EventFormValues {
  title: string;
  startsAt: string;
  endsAt?: string;
  /**
   * 字幕を出すか (ADR 0017 D-2)。オフにすると CaptionWorker を起動しないので
   * イベント 1 本あたりのコストが約 35% 下がる。
   */
  captionEnabled: boolean;
  /** 字幕の対応言語。 */
  languages: LanguageCode[];
  /** YouTube へ送出する 1 言語 (DESIGN.md 2.3, 6.3.1)。 */
  youtubeLanguage: LanguageCode;
  /** 字幕エンジン経路 (DESIGN.md 6.2)。 */
  engine: CaptionEngineKind;
  /** 独自字幕配信 API を有効化するか (DESIGN.md 6.3.2)。 */
  customApiEnabled: boolean;
  /** YouTube RTMP 取り込み URL。 */
  rtmpUrl?: string;
  /** ストリームキーの参照 (Secrets の名前。値は保持しない)。 */
  streamKeyRef?: string;
}

export const ENGINE_OPTIONS: { value: CaptionEngineKind; label: string }[] = [
  { value: "transcribe", label: "Amazon Transcribe + Translate (常用・低遅延)" },
  { value: "llm", label: "LLM 経路 (品質重視)" },
  { value: "self-hosted-asr", label: "自前 ASR (拡張用)" },
];

export const LANGUAGE_OPTIONS = SUPPORTED_LANGUAGES;

export function defaultFormValues(startsAt?: string): EventFormValues {
  return {
    title: "",
    startsAt: startsAt ?? "",
    endsAt: startsAt ? computeDefaultEndsAt(startsAt) : "",
    captionEnabled: true,
    languages: ["ja", "en"],
    youtubeLanguage: "ja",
    engine: "transcribe",
    customApiEnabled: false,
  };
}

/**
 * ISO 文字列 → `<input type="datetime-local">` が読む `YYYY-MM-DDTHH:mm`。
 * 保存済みの startsAt は `Z` 付き ISO のこともあるので、フォームに戻すときは必ず通す。
 */
export function toDateTimeLocal(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function computeDefaultEndsAt(startsAt: string): string {
  if (!startsAt) return "";
  const ms = Date.parse(startsAt);
  if (Number.isNaN(ms)) return "";
  return toDateTimeLocal(new Date(ms + 2 * 60 * 60 * 1000).toISOString());
}

/**
 * 既存イベント → フォーム値 (複製ボタン)。**設定だけを写す。**
 * id / status / 配信結果 (media・egress・provisioning) は `CreateEventInput` に無いので
 * 構造的に持ち込まれない。開催日時は元のまま出す (使い回すか直すかは人が決める)。
 */
export function toFormValues(event: EventDefinition): EventFormValues {
  const c = event.caption;
  return {
    title: `${event.title} のコピー`,
    startsAt: toDateTimeLocal(event.startsAt),
    endsAt: toDateTimeLocal(event.endsAt),
    // 生の enabled を見ると、未指定 (= 有効) の既存イベントが複製で黙って字幕オフになる。
    captionEnabled: isCaptionEnabled(c),
    languages: [...c.languages],
    youtubeLanguage: c.youtubeLanguage,
    engine: c.engine,
    customApiEnabled: c.customApiEnabled,
    ...(event.youtube
      ? { rtmpUrl: event.youtube.rtmpUrl, streamKeyRef: event.youtube.streamKeyRef }
      : {}),
  };
}

export interface FormValidation {
  ok: boolean;
  errors: string[];
}

export function validateForm(values: EventFormValues): FormValidation {
  const errors: string[] = [];
  if (!values.title.trim()) errors.push("タイトルは必須です");
  if (!values.startsAt) errors.push("開催日時は必須です");
  // 字幕オフなら言語は使われないので問わない。設定は残しておき、オンに戻せば効く。
  if (values.captionEnabled) {
    if (values.languages.length === 0) errors.push("対応言語を 1 つ以上選択してください");
    if (!values.languages.includes(values.youtubeLanguage)) {
      errors.push("YouTube 送出言語は対応言語に含めてください");
    }
  }
  if (values.endsAt && values.startsAt && Date.parse(values.endsAt) < Date.parse(values.startsAt)) {
    errors.push("終了日時は開始日時より後にしてください");
  }
  return { ok: errors.length === 0, errors };
}

/** フォーム値を制御 API の CreateEventInput へ変換する。 */
export function toCreateEventInput(values: EventFormValues): CreateEventInput {
  const caption = {
    enabled: values.captionEnabled,
    languages: values.languages,
    youtubeLanguage: values.youtubeLanguage,
    engine: values.engine,
    // 字幕オフなら独自配信 API も意味がない。設定として残さない。
    customApiEnabled: values.captionEnabled && values.customApiEnabled,
  };
  if (!isValidCaptionSettings(caption)) {
    throw new Error("invalid caption settings");
  }
  return {
    title: values.title.trim(),
    startsAt: values.startsAt,
    endsAt: values.endsAt || undefined,
    caption,
    youtube:
      values.rtmpUrl && values.streamKeyRef
        ? { rtmpUrl: values.rtmpUrl, streamKeyRef: values.streamKeyRef }
        : undefined,
  };
}
