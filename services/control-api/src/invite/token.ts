/**
 * 署名付き招待トークン (DESIGN.md 4.1, F-12)。
 *
 * モデレーター・登壇者にはアカウントを発行せず、イベント単位の署名付き招待 URL を共有する。
 * トークンはイベント ID・ロール・有効期限を含み、サーバー側で HMAC-SHA256 署名を検証する。
 * 失効・再発行に対応するため jti と version を持ち、失効確認はリポジトリ照合で行う
 * (本モジュールは暗号的な発行・検証のみを担当する)。
 *
 * 形式: `base64url(JSON payload).base64url(HMAC-SHA256(secret, payloadB64))`
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isValidInviteTokenPayload,
  type InviteTokenPayload,
  type InvitedRole,
} from "@stagecast/shared";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export interface IssueInviteInput {
  eventId: string;
  role: InvitedRole;
  /** トークン ID (失効単位)。 */
  jti: string;
  /** 発行時刻 (UNIX 秒)。 */
  issuedAtSec: number;
  /** 有効秒数 (イベント開催時間に合わせる)。 */
  ttlSec: number;
  /** 再発行で繰り上がるバージョン。 */
  version: number;
}

/** 署名付き招待トークン文字列を発行する。 */
export function signInviteToken(input: IssueInviteInput, secret: string): string {
  if (!secret) throw new Error("invite token secret is required");
  const payload: InviteTokenPayload = {
    jti: input.jti,
    eventId: input.eventId,
    role: input.role,
    iat: input.issuedAtSec,
    exp: input.issuedAtSec + input.ttlSec,
    version: input.version,
  };
  const payloadB64 = base64url(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

export type VerifyResult =
  | { valid: true; payload: InviteTokenPayload }
  | { valid: false; reason: "malformed" | "bad-signature" | "expired" | "invalid-payload" };

/**
 * 招待トークンの署名と有効期限を検証する。
 * 失効 (jti/version の照合) は呼び出し側がリポジトリで別途確認する。
 */
export function verifyInviteToken(token: string, secret: string, nowSec: number): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed" };
  const [payloadB64, sig] = parts as [string, string];

  const expectedSig = sign(payloadB64, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "bad-signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!isValidInviteTokenPayload(parsed)) return { valid: false, reason: "invalid-payload" };
  if (nowSec >= parsed.exp || nowSec < parsed.iat) return { valid: false, reason: "expired" };

  return { valid: true, payload: parsed };
}
