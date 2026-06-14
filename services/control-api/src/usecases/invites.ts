/**
 * 招待 URL の発行・検証・失効・再発行 (DESIGN.md 4.1)。
 *
 * 署名 (HMAC) は invite/token.ts、失効状態は InviteTokenRepository が担う。
 * 検証は「署名・有効期限」(token.ts) に加えて「失効していないか・version 一致」(repo) を確認する。
 */
import type { InvitedRole } from "@stagecast/shared";
import type { InviteTokenRepository } from "../repo/types.js";
import { signInviteToken, verifyInviteToken } from "../invite/token.js";

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
    const jti = newJti();
    const version = 1;
    const issuedAtSec = Math.floor(now() / 1000);
    await repo.put({
      jti,
      eventId: input.eventId,
      role: input.role,
      currentVersion: version,
      revoked: false,
    });
    const token = signInviteToken(
      { eventId: input.eventId, role: input.role, jti, issuedAtSec, ttlSec: input.ttlSec, version },
      secret,
    );
    return {
      jti,
      token,
      url: `${baseUrl}?token=${encodeURIComponent(token)}`,
      role: input.role,
      eventId: input.eventId,
      expiresAtSec: issuedAtSec + input.ttlSec,
      version,
    };
  }

  /** 既存トークンを失効させ、version を繰り上げて新トークンを再発行する。 */
  async function reissue(jti: string, ttlSec: number): Promise<IssuedInvite> {
    const record = await repo.get(jti);
    if (!record) throw new Error(`invite ${jti} not found`);
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
