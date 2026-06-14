/**
 * 確定字幕の保存と書き出し (DESIGN.md 6.4, N-4)。
 *
 * 確定字幕を言語ごとに収集し、イベント後に SRT/VTT として書き出して S3 に保存する。
 * S3 アクセスは差し替え可能な ObjectStorage 抽象を介し、テストはインメモリ実装を使う。
 */
import type { CaptionEvent, LanguageCode } from "@stagecast/shared";
import { isFinalCaption } from "@stagecast/shared";

export interface ObjectStorage {
  put(key: string, body: string, contentType: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
}

/** ミリ秒 → SRT タイムコード (HH:MM:SS,mmm)。 */
export function formatSrtTime(ms: number): string {
  return formatTime(ms, ",");
}
/** ミリ秒 → VTT タイムコード (HH:MM:SS.mmm)。 */
export function formatVttTime(ms: number): string {
  return formatTime(ms, ".");
}
function formatTime(ms: number, msSep: "," | "."): string {
  const clamped = Math.max(0, Math.floor(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSep}${pad(millis, 3)}`;
}

/** 確定字幕の配列から SRT を生成する。 */
export function toSrt(captions: CaptionEvent[]): string {
  return captions
    .map((c, i) => {
      return `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}\n`;
    })
    .join("\n");
}

/** 確定字幕の配列から WebVTT を生成する。 */
export function toVtt(captions: CaptionEvent[]): string {
  const cues = captions
    .map((c) => `${formatVttTime(c.startMs)} --> ${formatVttTime(c.endMs)}\n${c.text}`)
    .join("\n\n");
  return `WEBVTT\n\n${cues}\n`;
}

/**
 * 確定字幕を言語ごとに蓄積し、S3 へ SRT/VTT として書き出す。
 * 暫定字幕は破棄する (確定のみ保存・DESIGN.md 6.4)。
 */
export class CaptionStore {
  private readonly byLanguage = new Map<LanguageCode, CaptionEvent[]>();

  constructor(
    private readonly storage: ObjectStorage,
    private readonly config: { eventId: string; keyPrefix?: string },
  ) {}

  /** 字幕バスから受け取る。確定字幕のみ蓄積する。 */
  ingest(caption: CaptionEvent): void {
    if (!isFinalCaption(caption)) return;
    const list = this.byLanguage.get(caption.language) ?? [];
    list.push(caption);
    this.byLanguage.set(caption.language, list);
  }

  languages(): LanguageCode[] {
    return [...this.byLanguage.keys()];
  }

  captionsFor(language: LanguageCode): CaptionEvent[] {
    return [...(this.byLanguage.get(language) ?? [])].sort((a, b) => a.startMs - b.startMs);
  }

  private key(language: LanguageCode, ext: "srt" | "vtt"): string {
    const prefix = this.config.keyPrefix ?? `captions/${this.config.eventId}/`;
    return `${prefix}${language}.${ext}`;
  }

  /** 全言語の SRT と VTT を S3 へ保存し、保存したキー一覧を返す。 */
  async flushToStorage(): Promise<string[]> {
    const keys: string[] = [];
    for (const language of this.languages()) {
      const captions = this.captionsFor(language);
      const srtKey = this.key(language, "srt");
      const vttKey = this.key(language, "vtt");
      await this.storage.put(srtKey, toSrt(captions), "application/x-subrip");
      await this.storage.put(vttKey, toVtt(captions), "text/vtt");
      keys.push(srtKey, vttKey);
    }
    return keys;
  }
}

/** テスト/ローカル用インメモリ ObjectStorage。 */
export class InMemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: string; contentType: string }>();
  async put(key: string, body: string, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }
  async get(key: string): Promise<string | undefined> {
    return this.objects.get(key)?.body;
  }
}
