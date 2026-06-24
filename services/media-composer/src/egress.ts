/**
 * Egress / RTMP 送出と録画 (DESIGN.md 5.1, F-6, N-4)。
 *
 * 合成済み映像を RTMP で YouTube Live へ送出し、同時に録画を S3 に保存する。
 * 本番は LiveKit Egress を呼ぶが、ここでは差し替え可能なインターフェースとフェイクを置く。
 */
import type { CompositionLayout } from "./layout.js";

export interface RecordingConfig {
  /** 録画を保存する S3 バケット。 */
  s3Bucket: string;
  /** S3 キーのプレフィックス (例: recordings/{eventId}/)。 */
  s3KeyPrefix: string;
}

export interface StartEgressInput {
  eventId: string;
  room: string;
  layout: CompositionLayout;
  /** RTMP 送出先 (YouTube Live)。未指定はモック送出 (ローカル検証用)。 */
  rtmpUrl?: string | undefined;
  recording?: RecordingConfig | undefined;
}

export type EgressStatus = "starting" | "active" | "stopped";

export interface EgressHandle {
  egressId: string;
  eventId: string;
  status: EgressStatus;
  rtmpUrl?: string | undefined;
  recordingS3Uri?: string | undefined;
}

export interface EgressClient {
  start(input: StartEgressInput): Promise<EgressHandle>;
  /** 発表者切替などでレイアウトが変わったとき、送出を止めずに合成を更新する。 */
  updateLayout(handle: EgressHandle, layout: CompositionLayout): Promise<void>;
  stop(handle: EgressHandle): Promise<void>;
}

/** テスト/ローカル用フェイク。送出はせず、呼び出しを記録する。 */
export class FakeEgressClient implements EgressClient {
  readonly layoutUpdates: { egressId: string; layout: CompositionLayout }[] = [];
  readonly stopped: string[] = [];
  private seq = 0;

  async start(input: StartEgressInput): Promise<EgressHandle> {
    const egressId = `egress-${input.eventId}-${++this.seq}`;
    const recordingS3Uri = input.recording
      ? `s3://${input.recording.s3Bucket}/${input.recording.s3KeyPrefix}${egressId}.mp4`
      : undefined;
    return {
      egressId,
      eventId: input.eventId,
      status: "active",
      rtmpUrl: input.rtmpUrl,
      recordingS3Uri,
    };
  }

  async updateLayout(handle: EgressHandle, layout: CompositionLayout): Promise<void> {
    this.layoutUpdates.push({ egressId: handle.egressId, layout });
  }

  async stop(handle: EgressHandle): Promise<void> {
    this.stopped.push(handle.egressId);
  }
}
