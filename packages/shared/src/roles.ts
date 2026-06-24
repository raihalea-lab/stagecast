/**
 * 参加者ロール (DESIGN.md 4 章)。
 *
 * - admin     : 配信管理者。Cognito 認証。イベント設定・メディア層起動停止・全体制御 (F-12)。
 * - moderator : イベントモデレーター。招待 URL アクセス。進行補助。
 * - speaker   : 登壇者。招待 URL アクセス。映像音声・画面共有・スライド送り。
 * - viewer    : 一般視聴者。認証不要。YouTube での視聴のみ。
 */
export const ROLES = ["admin", "moderator", "speaker", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** 招待 URL でアクセスするロール (アカウントを発行しない) (DESIGN.md 4.1)。 */
export const INVITED_ROLES = ["moderator", "speaker"] as const;
export type InvitedRole = (typeof INVITED_ROLES)[number];

/** stage-web に入室できるロール (admin は Cognito 経由, ADR 0014 D-3)。 */
export const STAGE_ROLES = ["admin", "moderator", "speaker"] as const;
export type StageRole = (typeof STAGE_ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isInvitedRole(value: string): value is InvitedRole {
  return (INVITED_ROLES as readonly string[]).includes(value);
}

export function isStageRole(value: string): value is StageRole {
  return (STAGE_ROLES as readonly string[]).includes(value);
}
