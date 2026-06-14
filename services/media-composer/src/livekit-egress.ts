/**
 * 実 LiveKit Egress クライアント (T2, ADR D-6)。
 *
 * `EgressClient` を LiveKit Egress API で実装する。Egress は SFU 上の音声/映像トラックを
 * 1 本の映像に合成し RTMP で YouTube Live へ送出する。録画は S3 に直接アップロードする。
 *
 * LiveKit SDK (livekit-server-sdk) の EgressClient を薄くラップする。SDK 呼び出しを
 * `LiveKitEgressApi` インターフェースで抽象化することで、SDK 非依存のユニットテストを
 * 維持しつつ、本番では実 SDK を注入する。
 */
import type { EncodedOutputs, EgressClient as LiveKitServerEgressClient } from "livekit-server-sdk";
import type { CompositionLayout } from "./layout.js";
import type { EgressClient, EgressHandle, RecordingConfig, StartEgressInput } from "./egress.js";

/** LiveKit Egress API の最小サブセット (livekit-server-sdk が満たす形)。 */
export interface LiveKitEgressApi {
  /** RoomComposite Egress を開始する (レイアウト合成 + 出力)。 */
  startRoomCompositeEgress(input: {
    roomName: string;
    layout?: string;
    audioOnly?: boolean;
    videoOnly?: boolean;
    /** RTMP 出力先 URL (例: rtmp://a.rtmp.youtube.com/live2/<stream-key>)。 */
    streamOutputs?: { protocol: "rtmp"; urls: string[] }[];
    /** ファイル出力 (録画)。 */
    fileOutputs?: {
      fileType: "mp4";
      filepath: string;
      s3?: { bucket: string; region?: string };
    }[];
  }): Promise<{ egressId: string }>;
  /** レイアウトを更新する (発表者切替などの即時反映)。 */
  updateLayout(egressId: string, layout: string): Promise<void>;
  /** Egress を停止する。 */
  stopEgress(egressId: string): Promise<void>;
}

export interface LiveKitEgressClientConfig {
  api: LiveKitEgressApi;
  /** YouTube RTMP のデフォルト送出先 URL (任意)。spec の rtmpUrl が優先。 */
  defaultRtmpUrl?: string;
  /** S3 リージョン (録画出力用)。 */
  s3Region?: string;
}

/**
 * 抽象 `EgressClient` の LiveKit 実装。
 *
 * - start: RoomComposite Egress を起動。レイアウトは `layoutToLiveKit` で LiveKit が
 *   理解する文字列 (組み込みプリセット名) に変換する。カスタムテンプレ運用に切り替える
 *   場合は templateBaseUrl を SDK 経由で渡すよう拡張する。
 * - updateLayout: 既存 egress の layout だけ更新 (映像送出は止めない)。
 * - stop: egress を停止。録画ファイルは S3 に逐次アップロードされる (LiveKit Egress 既定)。
 */
export class LiveKitEgressClient implements EgressClient {
  constructor(private readonly config: LiveKitEgressClientConfig) {}

  async start(input: StartEgressInput): Promise<EgressHandle> {
    const layout = layoutToLiveKit(input.layout);
    const streamOutputs = this.streamOutputs(input.rtmpUrl);
    const fileOutputs = this.fileOutputs(input.eventId, input.recording);

    const { egressId } = await this.config.api.startRoomCompositeEgress({
      roomName: input.room,
      layout,
      ...(streamOutputs.length > 0 ? { streamOutputs } : {}),
      ...(fileOutputs.length > 0 ? { fileOutputs } : {}),
    });

    return {
      egressId,
      eventId: input.eventId,
      status: "active",
      rtmpUrl: input.rtmpUrl,
      recordingS3Uri: input.recording
        ? `s3://${input.recording.s3Bucket}/${this.s3Key(input.eventId, input.recording, egressId)}`
        : undefined,
    };
  }

  async updateLayout(handle: EgressHandle, layout: CompositionLayout): Promise<void> {
    await this.config.api.updateLayout(handle.egressId, layoutToLiveKit(layout));
  }

  async stop(handle: EgressHandle): Promise<void> {
    await this.config.api.stopEgress(handle.egressId);
  }

  private streamOutputs(rtmpUrl: string | undefined): { protocol: "rtmp"; urls: string[] }[] {
    const url = rtmpUrl ?? this.config.defaultRtmpUrl;
    return url ? [{ protocol: "rtmp", urls: [url] }] : [];
  }

  private fileOutputs(
    eventId: string,
    recording: RecordingConfig | undefined,
  ): {
    fileType: "mp4";
    filepath: string;
    s3?: { bucket: string; region?: string };
  }[] {
    if (!recording) return [];
    return [
      {
        fileType: "mp4",
        filepath: this.s3Key(eventId, recording),
        s3: {
          bucket: recording.s3Bucket,
          ...(this.config.s3Region ? { region: this.config.s3Region } : {}),
        },
      },
    ];
  }

  private s3Key(eventId: string, recording: RecordingConfig, egressId?: string): string {
    // recordings/{eventId}/{egressId}.mp4 (egressId 未確定なら timestamp プレースホルダ)。
    const id = egressId ?? "{egress}";
    return `${recording.s3KeyPrefix}${eventId}/${id}.mp4`;
  }
}

/**
 * 抽象 `LiveKitEgressApi` を実 `livekit-server-sdk` の `EgressClient` で満たすアダプタ
 * (D3, ADR 0006 D-5/D-7)。
 *
 * 本アダプタにより `LiveKitEgressApi` の手書きインターフェースが実 SDK の現行シグネチャ
 * (`startRoomCompositeEgress(roomName, output, opts)`) と整合していることを型レベルで担保する。
 * `livekit-server-sdk` 本体はランタイムでのみ必要なので、型は `import type` で参照し、
 * 出力 (`StreamOutput` / `EncodedFileOutput`) の生成は呼び出し時に lazy import する
 * (ADR 0006 D-7「型のみ正規 import + lazy ランタイム」)。
 */
export function createLiveKitEgressApi(client: LiveKitServerEgressClient): LiveKitEgressApi {
  return {
    async startRoomCompositeEgress(input) {
      const sdk = await import("livekit-server-sdk");
      const output: EncodedOutputs = {};

      const streamUrls = (input.streamOutputs ?? []).flatMap((s) => s.urls);
      if (streamUrls.length > 0) {
        output.stream = new sdk.StreamOutput({
          protocol: sdk.StreamProtocol.RTMP,
          urls: streamUrls,
        });
      }

      const file = input.fileOutputs?.[0];
      if (file) {
        output.file = new sdk.EncodedFileOutput({
          fileType: sdk.EncodedFileType.MP4,
          filepath: file.filepath,
          ...(file.s3
            ? {
                output: {
                  case: "s3" as const,
                  value: new sdk.S3Upload({
                    bucket: file.s3.bucket,
                    ...(file.s3.region ? { region: file.s3.region } : {}),
                  }),
                },
              }
            : {}),
        });
      }

      // layout は opts に渡す (現行 SDK は output を第 2 引数、layout を opts に取る)。
      const info = await client.startRoomCompositeEgress(input.roomName, output, {
        ...(input.layout ? { layout: input.layout } : {}),
        ...(input.audioOnly ? { audioOnly: input.audioOnly } : {}),
        ...(input.videoOnly ? { videoOnly: input.videoOnly } : {}),
      });
      return { egressId: info.egressId };
    },
    async updateLayout(egressId, layout) {
      await client.updateLayout(egressId, layout);
    },
    async stopEgress(egressId) {
      await client.stopEgress(egressId);
    },
  };
}

/**
 * computeLayout の `CompositionLayout` を LiveKit の組み込みレイアウト名にマップする。
 *
 * LiveKit RoomComposite は `grid` / `speaker` / `single-speaker` / `audio-only` などの
 * プリセットを持つ。スライド有り/無しと登壇者数からおおまかに割り当てる。完全カスタム
 * レイアウトが必要になったら templateBaseUrl を Egress に渡す方式へ切替える。
 */
export function layoutToLiveKit(layout: CompositionLayout): string {
  if (layout.slide) return "speaker"; // スライドを大きく、登壇者を脇に
  const n = layout.speakers.length;
  if (n <= 1) return "single-speaker";
  return "grid"; // 複数登壇者をグリッド表示
}

/**
 * 発表者状態 (Valkey) の変化を購読して composer.onPresentationChanged を駆動する結線 (T2)。
 *
 * `subscribe` は購読解除関数を返す。Valkey 側の購読 (pub/sub or keyspace notifications)
 * は呼び出し側で実装し、イベントが届くたびに `notify(state)` を呼ぶだけでよい。
 */
export interface PresentationChangeSubscriber {
  /** state を渡すと composer.onPresentationChanged に流す。失敗はログに任せる。 */
  notify(state: import("@stagecast/shared").PresentationState): void;
}

import type { StreamComposer } from "./composer.js";

/**
 * StreamComposer を購読器でラップする。Valkey ストアの notify を本オブジェクトに流せば
 * 自動的に Egress のレイアウトが更新される (DESIGN.md 5.3)。
 */
export function attachComposerToPresentation(
  composer: StreamComposer,
  options: { onError?: (err: unknown) => void } = {},
): PresentationChangeSubscriber {
  return {
    notify(state) {
      void composer.onPresentationChanged(state).catch((err) => {
        if (options.onError) options.onError(err);
        else console.error("composer.onPresentationChanged failed", err);
      });
    },
  };
}
