/**
 * stage-web から制御 API を呼ぶクライアント (DESIGN.md 4.1, F-1)。
 *
 * 招待トークンを /join に提示し、LiveKit 接続情報を受け取る。認証は招待トークンのみで、
 * 管理者用 Cognito は不要 (モデレーター・登壇者はアカウントを持たない)。
 */
import type { InvitedRole } from '@stagecast/shared';

export interface JoinSuccess {
  ok: true;
  eventId: string;
  role: InvitedRole;
  room: string;
  identity: string;
  livekitUrl: string;
  livekitToken: string;
}
export interface JoinFailure {
  ok: false;
  reason: string;
}
export type JoinResponse = JoinSuccess | JoinFailure;

export interface StageClient {
  join(token: string, displayName?: string): Promise<JoinResponse>;
}

export class HttpStageClient implements StageClient {
  constructor(private readonly baseUrl: string) {}

  async join(token: string, displayName?: string): Promise<JoinResponse> {
    const res = await fetch(`${this.baseUrl}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, displayName }),
    });
    if (res.status === 503) return { ok: false, reason: 'media-unavailable' };
    return (await res.json()) as JoinResponse;
  }
}
