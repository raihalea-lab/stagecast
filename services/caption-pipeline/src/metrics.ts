/**
 * CloudWatch カスタムメトリクス送信 (T9, ADR 0003 監視・検知)。
 *
 * 字幕パイプラインの遅延・スループットを measure → emit する。CloudWatch には EMF
 * (Embedded Metric Format) で stdout に書き出す方式を取る (Lambda/ECS で同じ書式が使える)。
 *
 * メトリクス:
 *   - CaptionLatencyMs    (字幕生成遅延: 音声タイムスタンプ → 字幕出力までの ms)
 *   - CaptionsPublished   (発行件数, status=interim/final の dimension)
 *   - SinkDeliveryErrors  (Sink 配信失敗件数, sink=youtube/custom-api 等)
 *
 * EMF: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 */
import type { CaptionEvent } from "@stagecast/shared";

export interface MetricsSink {
  /** 1 件のメトリクスを送出する (EMF JSON など)。 */
  emit(record: MetricsRecord): void;
}

export interface MetricsRecord {
  namespace: string;
  metrics: { name: string; unit: "Milliseconds" | "Count"; value: number }[];
  dimensions: Record<string, string>;
  timestampMs?: number;
}

/** stdout に EMF JSON を 1 行で書き出す Sink (CloudWatch Logs エージェントが拾う)。 */
export class ConsoleEmfMetricsSink implements MetricsSink {
  constructor(private readonly write: (line: string) => void = (l) => console.log(l)) {}
  emit(record: MetricsRecord): void {
    const dimNames = Object.keys(record.dimensions);
    const emf = {
      _aws: {
        Timestamp: record.timestampMs ?? Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: record.namespace,
            Dimensions: [dimNames],
            Metrics: record.metrics.map((m) => ({ Name: m.name, Unit: m.unit })),
          },
        ],
      },
      ...record.dimensions,
      ...Object.fromEntries(record.metrics.map((m) => [m.name, m.value])),
    };
    this.write(JSON.stringify(emf));
  }
}

/** テスト用: 配列に蓄積する Sink。 */
export class InMemoryMetricsSink implements MetricsSink {
  readonly records: MetricsRecord[] = [];
  emit(record: MetricsRecord): void {
    this.records.push(record);
  }
}

export interface CaptionMetricsConfig {
  eventId: string;
  /** CloudWatch namespace (既定 "Stagecast/CaptionPipeline")。 */
  namespace?: string;
  /** メトリクスのバックエンド (省略時は ConsoleEmfMetricsSink)。 */
  sink?: MetricsSink;
  /** 現在時刻 ms (テストで差し替え可能)。 */
  now?: () => number;
}

/**
 * 字幕イベントから遅延・件数メトリクスを生成する。
 *
 * - 遅延: now() - caption.startMs (タイムスタンプ基準)。N-2 の 3 秒目標を測る。
 * - 件数: status (interim/final) で集計。
 */
export class CaptionMetricsCollector {
  private readonly namespace: string;
  private readonly sink: MetricsSink;
  private readonly now: () => number;
  private readonly eventId: string;

  constructor(config: CaptionMetricsConfig) {
    this.eventId = config.eventId;
    this.namespace = config.namespace ?? "Stagecast/CaptionPipeline";
    this.sink = config.sink ?? new ConsoleEmfMetricsSink();
    this.now = config.now ?? Date.now;
  }

  /** 1 件の字幕イベント発行に対してメトリクスを emit する。 */
  observeCaption(caption: CaptionEvent): void {
    const latency = Math.max(0, this.now() - caption.startMs);
    this.sink.emit({
      namespace: this.namespace,
      metrics: [
        { name: "CaptionLatencyMs", unit: "Milliseconds", value: latency },
        { name: "CaptionsPublished", unit: "Count", value: 1 },
      ],
      dimensions: {
        EventId: this.eventId,
        Status: caption.status,
        Language: caption.language,
      },
    });
  }

  /** Sink 配信の再試行を記録する (一過性失敗の傾向把握用)。 */
  observeSinkRetry(sinkKind: string): void {
    this.sink.emit({
      namespace: this.namespace,
      metrics: [{ name: "SinkDeliveryRetries", unit: "Count", value: 1 }],
      dimensions: { EventId: this.eventId, Sink: sinkKind },
    });
  }

  /** Sink 配信エラー (全リトライ失敗) を記録する。 */
  observeSinkError(sinkKind: string): void {
    this.sink.emit({
      namespace: this.namespace,
      metrics: [{ name: "SinkDeliveryErrors", unit: "Count", value: 1 }],
      dimensions: { EventId: this.eventId, Sink: sinkKind },
    });
  }

  /** 翻訳の全リトライ失敗 (その言語をスキップした) を記録する。N-2 の品質劣化検知用。 */
  observeTranslateError(language: string): void {
    this.sink.emit({
      namespace: this.namespace,
      metrics: [{ name: "TranslateErrors", unit: "Count", value: 1 }],
      dimensions: { EventId: this.eventId, Language: language },
    });
  }
}
