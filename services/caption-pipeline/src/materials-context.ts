/**
 * 翻訳参考資料を読み込んで翻訳の文脈として供給する (ADR 0021 D-3, D-6)。
 *
 * 字幕ワーカーは Fargate 上で招待トークンを持たず control-api を叩けないので、
 * 抽出 Lambda が書いた `_context.json` を S3 から直接読む。
 *
 * 当日にデッキが投入されるケースがあるので、起動時に 1 回読んだきりにはしない。
 * ETag を見て変化があったときだけ読み直す (HEAD 1 回/分なので無視できる)。
 */
import { createLogger, materialsContextKey, type MaterialsContext } from "@stagecast/shared";

const log = createLogger({ component: "materials-context" });

/** `_context.json` の取得元。S3 実装とフェイクを差し替えられるようにする。 */
export interface MaterialsContextSource {
  /** 現在の ETag。オブジェクトが無ければ undefined。 */
  head(key: string): Promise<string | undefined>;
  /** 中身を取得する。オブジェクトが無ければ undefined。 */
  get(key: string): Promise<string | undefined>;
}

/** 翻訳プロンプトに載せる文脈。資料が無ければ undefined を返す。 */
export interface TranslationContextProvider {
  current(): string | undefined;
}

export interface MaterialsContextStoreOptions {
  eventId: string;
  source: MaterialsContextSource;
  /** 更新確認の間隔 (ms)。既定 60 秒。 */
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export class MaterialsContextStore implements TranslationContextProvider {
  private readonly key: string;
  private readonly pollIntervalMs: number;
  private etag?: string;
  private fullText?: string;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: MaterialsContextStoreOptions) {
    this.key = materialsContextKey(options.eventId);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** 起動時に 1 回読み、以後は定期的に更新を確認する。 */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
    // Fargate の停止を妨げない。
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  current(): string | undefined {
    return this.fullText;
  }

  /**
   * ETag が変わっていれば読み直す。
   * 失敗しても例外を投げない: 資料は翻訳の補助であり、読めないことで字幕を止めない (N-2)。
   */
  async refresh(): Promise<void> {
    try {
      const etag = await this.options.source.head(this.key);
      if (!etag) {
        // 資料が消された場合。古い文脈を使い続けない。
        if (this.fullText !== undefined) {
          log.info("materials context cleared", { eventId: this.options.eventId });
        }
        this.etag = undefined;
        this.fullText = undefined;
        return;
      }
      if (etag === this.etag) return;

      const raw = await this.options.source.get(this.key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as MaterialsContext;
      if (parsed.version !== 1) {
        // 未知のバージョンは無視する (読み手より新しい形式が来た場合)。
        log.warn("unknown materials context version", { version: parsed.version });
        return;
      }
      this.etag = etag;
      this.fullText = parsed.fullText || undefined;
      log.info("materials context loaded", {
        eventId: this.options.eventId,
        materials: parsed.materials.length,
        chars: parsed.fullText.length,
      });
    } catch (err) {
      log.error("materials context refresh failed", { eventId: this.options.eventId, err });
    }
  }
}
