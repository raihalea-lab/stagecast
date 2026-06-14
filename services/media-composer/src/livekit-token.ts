/**
 * LiveKit アクセストークンの発行 (DESIGN.md 3.2, 5 章, F-1)。
 *
 * 登壇者・モデレーター・管理者は、この JWT (HS256) で SFU(LiveKit) に接続する。
 * ロールに応じて publish/subscribe 権限を絞る。秘密鍵はコードに置かず環境変数 /
 * Secrets Manager から注入する (ADR D-10)。
 */
import { createHmac } from 'node:crypto';
import type { Role } from '@stagecast/shared';

export interface VideoGrant {
  roomJoin: boolean;
  room: string;
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData: boolean;
}

/** ロール → LiveKit 権限のマッピング (DESIGN.md 4 表)。 */
export function grantForRole(role: Role, room: string): VideoGrant {
  switch (role) {
    case 'speaker':
      // 登壇者: 自分の映像音声・画面共有を publish、他を subscribe。
      return { roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true };
    case 'moderator':
    case 'admin':
      // モデレーター・管理者: 進行のため publish/subscribe 双方可。
      return { roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true };
    case 'viewer':
    default:
      // 視聴者は SFU には来ない (YouTube 視聴) が、保険として subscribe のみ。
      return { roomJoin: true, room, canPublish: false, canSubscribe: true, canPublishData: false };
  }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export interface AccessTokenInput {
  apiKey: string;
  apiSecret: string;
  /** 参加者の識別子 (LiveKit identity)。 */
  identity: string;
  room: string;
  role: Role;
  /** 発行時刻 (UNIX 秒)。 */
  issuedAtSec: number;
  /** 有効秒数。 */
  ttlSec: number;
  /** 表示名 (任意)。 */
  name?: string;
}

/**
 * LiveKit 互換のアクセストークン (JWT/HS256) を生成する。
 * クレームは LiveKit の `video` グラント形式に準拠する。
 */
export function createLiveKitAccessToken(input: AccessTokenInput): string {
  if (!input.apiKey || !input.apiSecret) {
    throw new Error('LiveKit apiKey/apiSecret are required');
  }
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: input.apiKey,
    sub: input.identity,
    name: input.name,
    nbf: input.issuedAtSec,
    iat: input.issuedAtSec,
    exp: input.issuedAtSec + input.ttlSec,
    video: grantForRole(input.role, input.room),
  };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = createHmac('sha256', input.apiSecret).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}
