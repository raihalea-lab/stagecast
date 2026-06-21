/**
 * Preview LiveKit Token 発行 (ADR 0012 D-6, R17)。
 *
 * admin-web / stage-web が composer-template を iframe で開いて「現在の配信」をプレビューする
 * ための subscriber-only token を払い出す。 publish 不要・layout 操作不要なので viewer role。
 *
 * 認証ポリシー:
 *  - admin-web からは Cognito JWT (requireAdmin) で叩く
 *  - stage-web からは invite token (招待 URL) を提示する別経路で叩く
 *  - 本サービスは「event が live + media 確定」の事前条件のみ確認し、 認証は HTTP 層で完結
 *
 * R17-Phase1: まず admin 用 endpoint のみ公開。 stage-web 用は invite 検証を別途追加する
 * (R17-Phase3)。
 *
 * 既存の admin-token.ts (admin role) との違い:
 *  - role = viewer (canPublish: false, canSubscribe: true, canPublishData: false)
 *  - identity = `preview-{uuid}` (admin/speaker と区別、 複数 viewer が同時接続できる)
 *  - ttl は短め (1 時間) - プレビューは継続不要、 切れたら再取得
 */
import { randomUUID } from "node:crypto";
import type { LiveKitTokenMinter } from "../auth/livekit-minter.js";
import type { EventService } from "./events.js";
import { ServiceUnavailableError } from "./join.js";

export interface PreviewTokenResult {
  livekitUrl: string;
  livekitToken: string;
  identity: string;
  room: string;
}

export interface PreviewTokenServiceConfig {
  events: EventService;
  liveKitMinter: LiveKitTokenMinter;
  /** Preview token の有効期間 (秒)。 デフォルト 1 時間。 */
  ttlSec?: number;
}

export function createPreviewTokenService(config: PreviewTokenServiceConfig) {
  const ttlSec = config.ttlSec ?? 60 * 60;
  return {
    async issue(eventId: string): Promise<PreviewTokenResult> {
      const event = await config.events.get(eventId);
      if (event.status !== "live") {
        throw new ServiceUnavailableError("event is not live");
      }
      if (!event.media?.livekitUrl) {
        throw new ServiceUnavailableError("LiveKit URL not ready", { retryAfterSec: 30 });
      }
      // preview-{uuid} で複数 viewer が同時接続できる identity を生成。
      const identity = `preview-${randomUUID()}`;
      const livekitToken = config.liveKitMinter.mint({
        identity,
        room: eventId,
        role: "viewer",
        ttlSec,
        name: "Preview",
      });
      return {
        livekitUrl: event.media.livekitUrl,
        livekitToken,
        identity,
        room: eventId,
      };
    },
  };
}

export type PreviewTokenService = ReturnType<typeof createPreviewTokenService>;
