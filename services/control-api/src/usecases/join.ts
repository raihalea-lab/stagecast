/**
 * 招待 URL からの入室 (DESIGN.md 4.1, F-1, F-12)。
 *
 * モデレーター・登壇者は招待トークンを提示して入室する。トークンを検証し、ロールに応じた
 * LiveKit アクセストークンを払い出す。これにより stage-web は SFU に接続できる。
 */
import type { InvitedRole } from "@stagecast/shared";
import type { createInviteService } from "./invites.js";
import type { LiveKitTokenMinter } from "../auth/livekit-minter.js";

type InviteService = ReturnType<typeof createInviteService>;

export type JoinResult =
  | {
      ok: true;
      eventId: string;
      role: InvitedRole;
      room: string;
      identity: string;
      livekitUrl: string;
      livekitToken: string;
    }
  | { ok: false; reason: string };

export class ServiceUnavailableError extends Error {
  constructor(message = "media layer not available") {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

export function createJoinService(deps: {
  invites: InviteService;
  minter?: LiveKitTokenMinter;
  newIdentity: () => string;
  ttlSec?: number;
}) {
  const { invites, minter, newIdentity } = deps;
  const ttlSec = deps.ttlSec ?? 60 * 60 * 6;

  async function join(token: string, displayName?: string): Promise<JoinResult> {
    const verified = await invites.verify(token);
    if (!verified.valid) return { ok: false, reason: verified.reason };
    if (!minter) throw new ServiceUnavailableError("LiveKit is not configured");

    // ルームはイベント単位 (= eventId)。participant identity は衝突しないよう払い出す。
    const room = verified.eventId;
    const identity = `${verified.role}-${newIdentity()}`;
    const livekitToken = minter.mint({
      identity,
      room,
      role: verified.role,
      ttlSec,
      name: displayName,
    });
    return {
      ok: true,
      eventId: verified.eventId,
      role: verified.role,
      room,
      identity,
      livekitUrl: minter.url,
      livekitToken,
    };
  }

  return { join };
}
