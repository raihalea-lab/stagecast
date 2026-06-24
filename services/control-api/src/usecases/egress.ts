/**
 * Egress (RTMP 送出) 起動ユースケース (R12, ADR 0006 D-4)。
 *
 * 管理者の「配信開始」操作で、LiveKit Egress に RoomComposite Egress を指示する。
 * Egress は SFU 上のトラックを Chrome ヘッドレスで合成し、RTMP で YouTube Live に送出する。
 *
 * フロー:
 *   1. events.media.livekitUrl が確定していることを確認 (未起動なら 503)
 *   2. youtube.rtmpUrl と youtube.streamKeyRef を取得 (どちらか欠ければ 400)
 *   3. YouTube Secret から streamKey 値を取得
 *   4. LiveKit Egress API (startRoomCompositeEgress) を呼び出す
 *   5. events.media.egressId を保存して状態を可視化
 */

import { ValidationError, type EventService } from "./events.js";
import { ServiceUnavailableError } from "./join.js";

/** YouTube ストリームキー解決器 (Secrets Manager のフィールドから値を取得)。 */
export interface StreamKeyResolver {
  /** `streamKeyRef` (Secret 内のフィールド名) から実際のストリームキー文字列を返す。 */
  resolve(streamKeyRef: string): Promise<string>;
}

/** LiveKit Egress 起動の最小インターフェース (テストでフェイク可能)。 */
export interface EgressStarter {
  /**
   * RoomComposite Egress を起動する。
   * - `livekitUrl`: per-event の LiveKit signaling URL (events.media.livekitUrl)
   * - `roomName`: LiveKit のルーム名 (eventId と一致)
   * - `streamUrl`: RTMP 完全 URL (`${rtmpUrl}/${streamKey}` で組み立て済み)
   * 戻り値: LiveKit が払い出す egressId
   */
  startRtmpEgress(input: {
    livekitUrl: string;
    roomName: string;
    streamUrl: string;
  }): Promise<{ egressId: string }>;
}

export interface EgressServiceConfig {
  events: EventService;
  streamKeyResolver: StreamKeyResolver;
  starter: EgressStarter;
}

export interface StartEgressResult {
  egressId: string;
  rtmpUrl: string;
}

export function createEgressService(config: EgressServiceConfig) {
  return {
    async start(eventId: string): Promise<StartEgressResult> {
      const event = await config.events.get(eventId);
      if (event.status !== "live") {
        throw new ValidationError("event is not live");
      }
      if (!event.media?.livekitUrl) {
        // EventMediaStack 起動中。reconcile が livekitUrl を書き戻すのを待ってから再試行する。
        throw new ServiceUnavailableError("LiveKit URL not ready", { retryAfterSec: 30 });
      }
      const youtube = event.youtube;
      if (!youtube?.rtmpUrl) {
        throw new ValidationError("event.youtube.rtmpUrl is required");
      }
      if (!youtube.streamKeyRef) {
        throw new ValidationError("event.youtube.streamKeyRef is required");
      }
      const streamKey = await config.streamKeyResolver.resolve(youtube.streamKeyRef);
      if (!streamKey) {
        throw new ServiceUnavailableError("stream key not found in YouTube secret");
      }
      // YouTube Live は `${rtmpUrl}/${streamKey}` 形式。末尾の `/` を整える。
      const streamUrl = joinRtmpUrl(youtube.rtmpUrl, streamKey);
      const result = await config.starter.startRtmpEgress({
        livekitUrl: event.media.livekitUrl,
        roomName: eventId,
        streamUrl,
      });
      return { egressId: result.egressId, rtmpUrl: streamUrl };
    },
  };
}

export type EgressService = ReturnType<typeof createEgressService>;

/** `rtmp://a.rtmp.youtube.com/live2` + `STREAM_KEY` → `rtmp://a.rtmp.youtube.com/live2/STREAM_KEY`。 */
export function joinRtmpUrl(rtmpUrl: string, streamKey: string): string {
  const base = rtmpUrl.endsWith("/") ? rtmpUrl.slice(0, -1) : rtmpUrl;
  return `${base}/${streamKey}`;
}
