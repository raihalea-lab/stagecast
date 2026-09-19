/**
 * 招待 URL の発行・検証・失効・再発行 (DESIGN.md 4.1)。
 *
 * 署名 (HMAC) は invite/token.ts、失効状態は InviteTokenRepository が担う。
 * 検証は「署名・有効期限」(token.ts) に加えて「失効していないか・version 一致」(repo) を確認する。
 */
import { DEFAULT_EVENT_DURATION_MS, type InvitedRole } from "@stagecast/shared";
import type { InviteTokenRecord, InviteTokenRepository } from "../repo/types.js";
import { signInviteToken, verifyInviteToken } from "../invite/token.js";
import { NotFoundError, ValidationError } from "./events.js";

/** 招待 TTL の許容範囲 (1 分〜7 日)。短すぎ/長すぎる招待 URL を防ぐ。 */
export const MIN_TTL_SEC = 60;
export const MAX_TTL_SEC = 7 * 24 * 60 * 60;

/** 終了時刻を過ぎても片付け中に入室できるよう、期限にはこれだけ余裕を足す。 */
const INVITE_GRACE_SEC = 60 * 60;
/**
 * 署名に焼き込む exp の上限。 本当の期限はイベント終了 (verify 時に今の endsAt で判定) なので、
 * これは「イベントが消えても永遠には残らない」ための天井。 endsAt を編集しても URL が変わらない。
 * 発行時刻基準なので、これより先のイベントは当日に expired になる。 3 年先の配信予定は現実的に無い。
 */
const INVITE_TOKEN_CEILING_SEC = 3 * 365 * 24 * 60 * 60;

/**
 * 招待 URL の期限 (UNIX 秒) をイベントの開催時間から決める (ADR 0029)。
 * 「発行から 12h」だと前日に発行した URL が本番で切れる。
 */
export function inviteExpiryFor(event: { startsAt: string; endsAt?: string }): number {
  const endMs = event.endsAt
    ? Date.parse(event.endsAt)
    : Date.parse(event.startsAt) + DEFAULT_EVENT_DURATION_MS;
  return Math.floor(endMs / 1000) + INVITE_GRACE_SEC;
}

const INVITE_ROLES: readonly InvitedRole[] = ["moderator", "speaker"];

/** ロールごと 1 本の招待の jti。 決定的なので同時に 2 回作られても同じレコードに落ちる。 */
export function inviteJti(eventId: string, role: InvitedRole): string {
  return `${eventId}:${role}`;
}

/** listForEvent / reissue が扱うレコード (issuedAtSec 必須)。 */
type StableInviteRecord = InviteTokenRecord & { issuedAtSec: number };

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
  /** 表示用の期限 (イベント終了 + 猶予)。 署名内の exp ではない。 */
  expiresAtSec: number;
  version: number;
  /** 失効中 (再発行するまで入室できない)。 */
  revoked: boolean;
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

  /**
   * 署名の入力は jti / issuedAtSec / version だけ (期限は天井)。 すべてレコードから決まるので
   * 何度呼んでも同じ URL 文字列になり、endsAt を編集しても配った URL がそのまま生きる。
   */
  function toIssued(record: StableInviteRecord, expiresAtSec: number): IssuedInvite {
    const token = signInviteToken(
      {
        eventId: record.eventId,
        role: record.role,
        jti: record.jti,
        issuedAtSec: record.issuedAtSec,
        ttlSec: INVITE_TOKEN_CEILING_SEC,
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
      expiresAtSec,
      version: record.currentVersion,
      revoked: record.revoked,
    };
  }

  /**
   * ロールごとに 1 本の招待を返す。 無ければ作る (get-or-create)。
   * jti が決定的なので同時に 2 回呼ばれても 1 レコードに落ち、旧レコード (UUID jti) は自然に無視される。
   * 失効させたロールも revoked=true で返す (画面が「失効中 / 再発行」を出せるように)。
   */
  async function listForEvent(eventId: string): Promise<IssuedInvite[]> {
    const exp = await expiresAtFor(eventId);
    const nowSec = Math.floor(now() / 1000);
    const result: IssuedInvite[] = [];
    for (const role of INVITE_ROLES) {
      const jti = inviteJti(eventId, role);
      let record = await repo.get(jti);
      if (!record) {
        // 条件付き put: 同時に 2 回来ても後の put が先の (再発行済みかもしれない) レコードを上書きしない。
        record = await repo.putIfAbsent({
          jti,
          eventId,
          role,
          currentVersion: 1,
          revoked: false,
          issuedAtSec: nowSec,
        });
      }
      if (record.issuedAtSec === undefined) {
        // 決定的 jti に issuedAtSec の無いレコードが居る (手動修正など)。 iat 無しで署名すると壊れた URL になるので作り直す。
        record = { ...record, issuedAtSec: nowSec };
        await repo.put(record);
      }
      result.push(toIssued(record as StableInviteRecord, exp));
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
      revoked: false,
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
    const next: StableInviteRecord = {
      ...record,
      currentVersion: record.currentVersion + 1,
      revoked: false,
      issuedAtSec: Math.floor(now() / 1000),
    };
    await repo.put(next);
    return toIssued(next, exp);
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
    // ロールごと 1 本の招待 (issuedAtSec あり) は、本当の期限をイベント終了 (今の endsAt) で判定する。
    // イベントが消えていれば入れない。 TTL 指定で発行した旧方式のトークンは署名内の exp だけで判定する。
    if (record.issuedAtSec !== undefined) {
      // NotFound (イベント削除済み) だけ「失効」に倒す。 DDB の一時障害まで 401 にすると
      // 登壇者に「招待が無効」と見えて再試行されないので、それ以外はそのまま投げて 5xx にする。
      const eventExp = await expiresAtFor(res.payload.eventId).catch((err: unknown) => {
        if (err instanceof NotFoundError) return undefined;
        throw err;
      });
      if (eventExp === undefined) return { valid: false, reason: "revoked" };
      if (nowSec > eventExp) return { valid: false, reason: "expired" };
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
