/**
 * 招待 URL の発行・検証・失効・再発行 (DESIGN.md 4.1)。
 *
 * 署名 (HMAC) は invite/token.ts、失効状態は InviteTokenRepository が担う。
 * 検証は「署名・有効期限」(token.ts) に加えて「失効していないか・version 一致」(repo) を確認する。
 */
import type { InvitedRole } from "@stagecast/shared";
import type { InviteTokenRecord, InviteTokenRepository } from "../repo/types.js";
import { signInviteToken, verifyInviteToken } from "../invite/token.js";
import { NotFoundError, ValidationError } from "./events.js";

/** 招待 TTL の許容範囲 (1 分〜7 日)。短すぎ/長すぎる招待 URL を防ぐ。 */
export const MIN_TTL_SEC = 60;
export const MAX_TTL_SEC = 7 * 24 * 60 * 60;

/** endsAt 未設定のイベントの既定所要時間 (admin-web の EventForm と同じ 2h)。 */
const DEFAULT_DURATION_SEC = 2 * 60 * 60;
/** 終了時刻を過ぎても片付け中に入室できるよう、期限にはこれだけ余裕を足す。 */
const INVITE_GRACE_SEC = 60 * 60;

/**
 * 招待 URL の期限 (UNIX 秒) をイベントの開催時間から決める (ADR 0029)。
 * 「発行から 12h」だと前日に発行した URL が本番で切れる。
 */
export function inviteExpiryFor(event: { startsAt: string; endsAt?: string }): number {
  const endMs = event.endsAt
    ? Date.parse(event.endsAt)
    : Date.parse(event.startsAt) + DEFAULT_DURATION_SEC * 1000;
  return Math.floor(endMs / 1000) + INVITE_GRACE_SEC;
}

const INVITE_ROLES: readonly InvitedRole[] = ["moderator", "speaker"];

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
  /** イベント ID → 招待期限 (UNIX 秒)。 イベントが無ければ NotFoundError を投げる。 */
  expiresAtFor: (eventId: string) => Promise<number>;
}) {
  const { repo, secret, newJti, now, baseUrl, expiresAtFor } = deps;

  function toIssued(record: InviteTokenRecord, issuedAtSec: number, exp: number): IssuedInvite {
    const token = signInviteToken(
      {
        eventId: record.eventId,
        role: record.role,
        jti: record.jti,
        issuedAtSec,
        ttlSec: exp - issuedAtSec,
        version: record.currentVersion,
      },
      secret,
    );
    return {
      jti: record.jti,
      token,
      url: `${baseUrl}?token=${encodeURIComponent(token)}`,
      role: record.role,
      eventId: record.eventId,
      expiresAtSec: exp,
      version: record.currentVersion,
    };
  }

  /**
   * ロールごとに 1 本の招待を返す。 無ければ作る (get-or-create)。
   * 署名の入力 (jti / issuedAtSec / version / 期限) がすべてレコードとイベントから決まるので、
   * 何度呼んでも同じ URL 文字列になる。 issuedAtSec を持たない旧レコードは対象外にして作り直す。
   */
  async function listForEvent(eventId: string): Promise<IssuedInvite[]> {
    const exp = await expiresAtFor(eventId);
    const existing = (await repo.listByEvent(eventId))
      .filter((r) => !r.revoked && r.issuedAtSec !== undefined)
      .sort((a, b) => a.jti.localeCompare(b.jti));
    const result: IssuedInvite[] = [];
    for (const role of INVITE_ROLES) {
      let record = existing.find((r) => r.role === role);
      if (!record) {
        record = {
          jti: newJti(),
          eventId,
          role,
          currentVersion: 1,
          revoked: false,
          issuedAtSec: Math.floor(now() / 1000),
        };
        await repo.put(record);
      }
      result.push(toIssued(record, record.issuedAtSec!, exp));
    }
    return result;
  }

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

  /**
   * 既存トークンを失効させ、version を繰り上げて新トークンを再発行する。
   * 期限は listForEvent と同じくイベント終了に揃える (ここだけ 12h に戻ると穴が復活する)。
   */
  async function reissue(jti: string): Promise<IssuedInvite> {
    const record = await repo.get(jti);
    // 存在しない jti の再発行は 404 にする (内部エラー 500 にしない, #35 と統一)。
    if (!record) throw new NotFoundError(`invite ${jti} not found`);
    const exp = await expiresAtFor(record.eventId);
    // 再発行は同じ jti を使い version だけ繰り上げる。古い version のトークンは stale-version で弾く。
    // issuedAtSec も更新して、以後の listForEvent がこの再発行結果と同じ URL を返すようにする。
    const next: InviteTokenRecord = {
      ...record,
      currentVersion: record.currentVersion + 1,
      revoked: false,
      issuedAtSec: Math.floor(now() / 1000),
    };
    await repo.put(next);
    return toIssued(next, next.issuedAtSec!, exp);
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

  return { issue, listForEvent, reissue, revoke, verify };
}
