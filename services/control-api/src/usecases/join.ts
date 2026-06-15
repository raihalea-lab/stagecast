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

/** 表示名の最大長 (LiveKit participant name / JWT の肥大とレイアウト崩れを防ぐ)。 */
export const MAX_DISPLAY_NAME_LENGTH = 64;

/**
 * 公開 /join に来る表示名を無害化する。制御文字 (改行・タブ等) を空白化し、空白を畳んで
 * 最大長で切る。空なら undefined。/join は招待トークンで守られるが入力自体は untrusted。
 */
export function sanitizeDisplayName(name: string | undefined): string | undefined {
  if (typeof name !== "string") return undefined;
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 制御文字 + DEL は空白に置換 (改行混入での表示崩れ・ログ汚染を防ぐ)。
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  const collapsed = out.trim().replace(/\s+/g, " ");
  return collapsed ? collapsed.slice(0, MAX_DISPLAY_NAME_LENGTH) : undefined;
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
      name: sanitizeDisplayName(displayName),
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
