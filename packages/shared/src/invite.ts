/**
 * 招待トークン (DESIGN.md 4.1)。
 *
 * モデレーター・登壇者にはアカウントを発行せず、イベント単位の署名付き招待 URL を共有する。
 * トークンにはイベント ID・ロール・有効期限を含め、サーバー側で署名検証する。
 * 失効・再発行に対応するため、トークン ID とバージョンを持つ。
 */
import type { InvitedRole } from './roles.js';

export interface InviteTokenPayload {
  /** トークン ID。失効管理の単位 (DynamoDB に保存し、失効済みを照合)。 */
  jti: string;
  /** 対象イベント ID。 */
  eventId: string;
  /** 付与するロール (moderator / speaker)。 */
  role: InvitedRole;
  /** 発行時刻 (UNIX 秒)。 */
  iat: number;
  /** 有効期限 (UNIX 秒)。イベント開催時間に合わせて設定 (4.1)。 */
  exp: number;
  /** 再発行で繰り上がるバージョン。古いバージョンは無効扱いにできる。 */
  version: number;
}

/** トークンが時刻 `nowSec` (UNIX 秒) 時点で有効期限内かを判定する。 */
export function isInviteTokenTimeValid(payload: InviteTokenPayload, nowSec: number): boolean {
  return nowSec >= payload.iat && nowSec < payload.exp;
}

/** 招待トークンのペイロードとして妥当な形かを検証する (署名検証は別途)。 */
export function isValidInviteTokenPayload(value: unknown): value is InviteTokenPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.jti === 'string' &&
    typeof p.eventId === 'string' &&
    (p.role === 'moderator' || p.role === 'speaker') &&
    typeof p.iat === 'number' &&
    typeof p.exp === 'number' &&
    typeof p.version === 'number'
  );
}
