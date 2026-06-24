/**
 * メディア/字幕スタックのプロビジョナ (DESIGN.md 7.1, ADR D-6)。
 *
 * イベント開始でイベント専用のメディアスタック (SFU/Egress) と字幕パイプラインを起動し、
 * 終了で破棄する。本番は ECS/Fargate タスクや CloudFormation スタックを操作するが、
 * ここでは差し替え可能なインターフェースと、テスト用フェイクを提供する。
 *
 * 各スタックはイベント単位で独立し、相互に干渉しない (N-5, 7.3)。
 */
import type { CaptionEngineKind } from "@stagecast/shared";

export interface EventMediaSpec {
  eventId: string;
  /** 字幕エンジン経路 (DESIGN.md 6.2)。 */
  captionEngine: CaptionEngineKind;
  /** 独自字幕配信 API を起動するか (DESIGN.md 6.3.2, 任意起動)。 */
  customCaptionApi: boolean;
  /** YouTube RTMP 送出先 (任意。未指定はモック送出)。 */
  rtmpUrl?: string | undefined;
  /** YouTube ストリームキー参照名 (Secret 内のフィールド名)。R12, ADR 0006 D-4。 */
  streamKeyRef?: string | undefined;
}

export type StackStatus = "provisioning" | "running" | "destroying" | "destroyed";

/** プロビジョン済みスタックのハンドル。イベント単位で独立した資源参照を持つ。 */
export interface MediaStackHandle {
  eventId: string;
  /** スタックの一意 ID (イベント間で衝突しない)。 */
  stackId: string;
  status: StackStatus;
  /** この配信専用の SFU エンドポイント (LiveKit)。 */
  sfuUrl: string;
  /** 字幕パイプライン・タスクの識別子。 */
  captionPipelineId: string;
  /** 共有状態の名前空間 (= eventId)。 */
  valkeyNamespace: string;
  /** 独自字幕 API のエンドポイント (有効化時のみ)。 */
  customCaptionApiUrl?: string | undefined;
}

export interface MediaStackProvisioner {
  provision(spec: EventMediaSpec): Promise<MediaStackHandle>;
  destroy(handle: MediaStackHandle): Promise<void>;
}

/**
 * テスト/ローカル用フェイク。実際の AWS 呼び出しの代わりに、イベントごとに一意な
 * 資源参照を払い出し、プロビジョン/破棄の履歴を記録する。
 */
export class FakeMediaStackProvisioner implements MediaStackProvisioner {
  readonly provisioned: string[] = [];
  readonly destroyed: string[] = [];
  private seq = 0;

  async provision(spec: EventMediaSpec): Promise<MediaStackHandle> {
    const stackId = `stack-${spec.eventId}-${++this.seq}`;
    this.provisioned.push(spec.eventId);
    return {
      eventId: spec.eventId,
      stackId,
      status: "running",
      sfuUrl: `wss://sfu-${spec.eventId}.media.local`,
      captionPipelineId: `caption-${spec.eventId}`,
      valkeyNamespace: spec.eventId,
      customCaptionApiUrl: spec.customCaptionApi
        ? `wss://captions-${spec.eventId}.media.local`
        : undefined,
    };
  }

  async destroy(handle: MediaStackHandle): Promise<void> {
    this.destroyed.push(handle.eventId);
  }
}
