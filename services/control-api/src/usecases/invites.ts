/**
 * 招待 URL の発行・検証・失効・再発行 (DESIGN.md 4.1)。
 *
 * 署名 (HMAC) は invite/token.ts、失効状態は InviteTokenRepository が担う。
 * 検証は「署名・有効期限」(token.ts) に加えて「失効していないか・version 一致」(repo) を確認する。
 */
import type { InvitedRole } from "@stagecast/shared";
import type { InviteTokenRepository } from "../repo/types.js";
import { signInviteToken, verifyInviteToken } from "../invite/token.js";
import { NotFoundError, ValidationError } from "./events.js";

/** 招待 TTL の許容範囲 (1 分〜7 日)。短すぎ/長すぎる招待 URL を防ぐ。 */
export const MIN_TTL_SEC = 60;
export const MAX_TTL_SEC = 7 * 24 * 60 * 60;

function validateRole(role: unknown): InvitedRole {
  if (role !== "moderator" && role !== "speaker") {
    throw new ValidationError("role must be 'moderator' or 'speaker'");
  }
  return role;
}

function validateTtlSec(ttlSec: unknown): number {
  if (typeof ttlSec !== "number" || !Number.isFinite(ttlSec) || !Number.isInteger(ttlSec)) {
    throw new ValidationError("ttlSec must be an integer (seconds)");
  }
  if (ttlSec < MIN_TTL_SEC || ttlSec > MAX_TTL_SEC) {
    throw new ValidationError(`ttlSec must be between ${MIN_TTL_SEC} and ${MAX_TTL_SEC}`);
  }
  return ttlSec;
}

function validateEventId(eventId: unknown): string {
  if (typeof eventId !== "string" || !eventId.trim()) {
    throw new ValidationError("eventId is required");
  }
  return eventId;
}

export interface IssuedInvite {
  jti: string;
  token: string;
  url: string;
  role: InvitedRole;
  eventId: string;
  expiresAtSec: number;
  version: number;
}

export type InviteVerifyResult =
  | { valid: true; eventId: string; role: InvitedRole; jti: string }
  | {
      valid: false;
      reason:
        | "malformed"
        | "bad-signature"
        | "expired"
        | "invalid-payload"
        | "revoked"
        | "stale-version";
    };

export function createInviteService(deps: {
  repo: InviteTokenRepository;
  secret: string;
  newJti: () => string;
  now: () => number;
  /** 招待 URL のベース (例: https://app.example.com/join)。 */
  baseUrl: string;
}) {
  const { repo, secret, newJti, now, baseUrl } = deps;

  async function issue(input: {
    eventId: string;
    role: InvitedRole;
    ttlSec: number;
  }): Promise<IssuedInvite> {
    const eventId = validateEventId(input.eventId);
    const role = validateRole(input.role);
    const ttlSec = validateTtlSec(input.ttlSec);
    const jti = newJti();
    const version = 1;
    const issuedAtSec = Math.floor(now() / 1000);
    await repo.put({ jti, eventId, role, currentVersion: version, revoked: false });
    const token = signInviteToken({ eventId, role, jti, issuedAtSec, ttlSec, version }, secret);
    return {
      jti,
      token,
      url: `${baseUrl}?token=${encodeURIComponent(token)}`,
      role,
      eventId,
      expiresAtSec: issuedAtSec + ttlSec,
      version,
    };
  }

  /** 既存トークンを失効させ、version を繰り上げて新トークンを再発行する。 */
  async function reissue(jti: string, ttlSecInput: number): Promise<IssuedInvite> {
    const ttlSec = validateTtlSec(ttlSecInput);
    const record = await repo.get(jti);
    // 存在しない jti の再発行は 404 にする (内部エラー 500 にしない, #35 と統一)。
    if (!record) throw new NotFoundError(`invite ${jti} not found`);
    const version = record.currentVersion + 1;
    const issuedAtSec = Math.floor(now() / 1000);
    // 再発行は同じ jti を使い version だけ繰り上げる。古い version のトークンは stale-version で弾く。
    await repo.put({ ...record, currentVersion: version, revoked: false });
    const token = signInviteToken(
      { eventId: record.eventId, role: record.role, jti, issuedAtSec, ttlSec, version },
      secret,
    );
    return {
      jti,
      token,
      url: `${baseUrl}?token=${encodeURIComponent(token)}`,
      role: record.role,
      eventId: record.eventId,
      expiresAtSec: issuedAtSec + ttlSec,
      version,
    };
  }

  async function revoke(jti: string): Promise<void> {
    const record = await repo.get(jti);
    if (!record) return;
    await repo.put({ ...record, revoked: true });
  }

  async function verify(token: string): Promise<InviteVerifyResult> {
    const nowSec = Math.floor(now() / 1000);
    const res = verifyInviteToken(token, secret, nowSec);
    if (!res.valid) return { valid: false, reason: res.reason };
    const record = await repo.get(res.payload.jti);
    if (!record || record.revoked) return { valid: false, reason: "revoked" };
    if (res.payload.version !== record.currentVersion) {
      return { valid: false, reason: "stale-version" };
    }
    return {
      valid: true,
      eventId: res.payload.eventId,
      role: res.payload.role,
      jti: res.payload.jti,
    };
  }

  return { issue, reissue, revoke, verify };
}
