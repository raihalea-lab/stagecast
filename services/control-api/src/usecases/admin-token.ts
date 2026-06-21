/**
 * Admin LiveKit Token 発行 (ADR 0012 D-4, R16)。
 *
 * 管理者 (admin-web) が LiveKit room に participant として接続して、 layout 切替を
 * data channel で broadcast するための token を払い出す。 認証は API Gateway 層の
 * `requireAdmin` (Cognito JWT) で済んでいる前提。
 *
 * フロー:
 *   1. event を取得し status === "live" を確認 (event 開始前は発行しない)
 *   2. events.media.livekitUrl が確定していることを確認 (起動中なら 503)
 *   3. admin role 用 LiveKit access token を発行 (livekit-minter)
 *   4. livekitUrl + livekitToken + identity を返す
 *
 * 既存の `join.ts` (登壇者向け、 招待 token 検証あり) との違い:
 *  - 招待 token 不要 (Cognito 認証で済む)
 *  - role = admin (canPublishData: true)
 *  - identity を `admin-{uuid}` で発行 (sub に複数 admin が同時接続できる)
 */
import { randomUUID } from "node:crypto";
import type { LiveKitTokenMinter } from "../auth/livekit-minter.js";
import type { EventService } from "./events.js";
import { ServiceUnavailableError } from "./join.js";

export interface AdminTokenResult {
  livekitUrl: string;
  livekitToken: string;
  identity: string;
  room: string;
}

export interface AdminTokenServiceConfig {
  events: EventService;
  liveKitMinter: LiveKitTokenMinter;
  /** Admin token の有効期間 (秒)。 layout 切替操作中に切れないよう長めに取る (デフォルト 6 時間)。 */
  ttlSec?: number;
}

export function createAdminTokenService(config: AdminTokenServiceConfig) {
  const ttlSec = config.ttlSec ?? 6 * 60 * 60;
  return {
    async issue(eventId: string): Promise<AdminTokenResult> {
      const event = await config.events.get(eventId);
      if (event.status !== "live") {
        throw new ServiceUnavailableError("event is not live");
      }
      if (!event.media?.livekitUrl) {
        throw new ServiceUnavailableError("LiveKit URL not ready", { retryAfterSec: 30 });
      }
      // admin-{uuid} で複数 admin が同時接続できる identity を生成。
      const identity = `admin-${randomUUID()}`;
      const livekitToken = config.liveKitMinter.mint({
        identity,
        room: eventId,
        role: "admin",
        ttlSec,
        name: "Admin",
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

export type AdminTokenService = ReturnType<typeof createAdminTokenService>;
