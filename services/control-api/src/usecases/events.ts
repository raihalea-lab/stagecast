/**
 * イベント CRUD とライフサイクル状態の更新 (DESIGN.md 8 章, 7.1)。
 */
import {
  isValidCaptionSettings,
  MAX_EVENTS,
  type CaptionSettings,
  type EventDefinition,
  type EventStatus,
  type AssetRef,
  type YouTubeTarget,
} from "@stagecast/shared";
import type { EventRepository } from "../repo/types.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
export class NotFoundError extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

export interface CreateEventInput {
  title: string;
  startsAt: string;
  endsAt?: string;
  caption: CaptionSettings;
  qrAsset?: AssetRef;
  brandingAssets?: AssetRef[];
  slideAssets?: AssetRef[];
  youtube?: YouTubeTarget;
}

export type EventService = ReturnType<typeof createEventService>;

/** タイトル最大長 (DynamoDB 項目肥大と UI 崩れの防止)。 */
export const MAX_TITLE_LENGTH = 200;

// 保存上限の定義は shared にある (admin-web も同じ数字を表示するため)。
// 超過分は終了済みイベントだけを startsAt の古い順に消す。未終了は消さない。
export { MAX_EVENTS } from "@stagecast/shared";

/** 文字列・非空・長さ上限を検証する (不正な型は 500 でなく 400 にする)。 */
function validateTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError("title is required");
  if (value.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`title must be <= ${MAX_TITLE_LENGTH} chars`);
  }
  return value;
}

/** ISO datetime としてパース可能な文字列を検証する。 */
function validateTimestamp(field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO datetime`);
  }
  return value;
}

/**
 * 状態遷移に伴う副作用を実行する。
 *
 * **await すること**が要点。投げっぱなしにすると Lambda が応答を返した時点で実行環境を
 * 凍結し、処理が完走しない。資料削除で実際に踏んだ (状態は `ended` になるのに資料が残った)。
 * reconcile の直接起動やウォームアップ登録も、動的 import + SDK 呼び出しなので同じ穴がある。
 *
 * 失敗は握り潰す。状態の書き込みはもう終わっているので、ここでエラーを返すと
 * 「状態は変わったのに呼び出し側には失敗に見える」というより悪い状態になる。
 */
async function afterTransition(run: () => Promise<void> | undefined): Promise<void> {
  try {
    await run();
  } catch {
    // 理由は上のコメントのとおり。失敗しても遷移自体は成功させる。
  }
}

export function createEventService(deps: {
  repo: EventRepository;
  newId: () => string;
  now: () => number;
  cleanupStorage?: (eventId: string) => Promise<void>;
  /** イベント終了時に翻訳参考資料を消す (録画と字幕は残す)。 */
  cleanupMaterials?: (eventId: string) => Promise<void>;
  onGoLive?: (eventId: string) => Promise<void>;
  /** ADR 0015 Phase 4: スケジュール事前ウォームアップ。startsAt=string で作成、null で削除。 */
  onWarmupSchedule?: (eventId: string, startsAt: string | null) => Promise<void>;
}) {
  const { repo, newId, now } = deps;

  async function create(input: CreateEventInput): Promise<EventDefinition> {
    const title = validateTitle(input.title);
    const startsAt = validateTimestamp("startsAt", input.startsAt);
    let endsAt: string | undefined;
    if (input.endsAt !== undefined) {
      endsAt = validateTimestamp("endsAt", input.endsAt);
      if (Date.parse(endsAt) < Date.parse(startsAt)) {
        throw new ValidationError("endsAt must be at or after startsAt");
      }
    }
    if (!isValidCaptionSettings(input.caption)) {
      throw new ValidationError("youtubeLanguage must be one of caption.languages");
    }
    const ts = now();
    const event: EventDefinition = {
      id: newId(),
      title,
      startsAt,
      endsAt,
      status: "draft",
      caption: input.caption,
      qrAsset: input.qrAsset,
      brandingAssets: input.brandingAssets,
      slideAssets: input.slideAssets,
      youtube: input.youtube,
      createdAtMs: ts,
      updatedAtMs: ts,
    };
    await repo.put(event);
    await trimOldEvents();
    return event;
  }

  async function trimOldEvents(): Promise<void> {
    const all = await repo.list();
    if (all.length <= MAX_EVENTS) return;
    const deletable = all
      .filter((e) => e.status === "ended")
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    const excess = all.length - MAX_EVENTS;
    const toDelete = deletable.slice(0, excess);
    for (const e of toDelete) {
      await repo.delete(e.id);
      await deps.cleanupStorage?.(e.id);
    }
  }

  async function get(eventId: string): Promise<EventDefinition> {
    const e = await repo.get(eventId);
    if (!e) throw new NotFoundError(`event ${eventId} not found`);
    return e;
  }

  async function list(): Promise<EventDefinition[]> {
    return repo.list();
  }

  async function update(
    eventId: string,
    patch: Partial<CreateEventInput>,
  ): Promise<EventDefinition> {
    const e = await get(eventId);
    if (patch.title !== undefined) validateTitle(patch.title);
    if (patch.startsAt !== undefined) validateTimestamp("startsAt", patch.startsAt);
    if (patch.endsAt !== undefined) validateTimestamp("endsAt", patch.endsAt);
    const next: EventDefinition = { ...e, ...patch, updatedAtMs: now() };
    if (Date.parse(next.endsAt ?? next.startsAt) < Date.parse(next.startsAt)) {
      throw new ValidationError("endsAt must be at or after startsAt");
    }
    if (next.caption && !isValidCaptionSettings(next.caption)) {
      throw new ValidationError("youtubeLanguage must be one of caption.languages");
    }
    await repo.put(next);
    return next;
  }

  // ライフサイクル遷移 (DESIGN.md 7.1, ADR 0015 Phase 4)。許可された遷移のみ受け付ける。
  // warmup: scheduled→warmup (タイマー自動遷移), warmup→live (Go Live), warmup→draft (キャンセル)
  const allowed: Record<EventStatus, EventStatus[]> = {
    draft: ["scheduled", "live"],
    scheduled: ["live", "draft", "warmup"],
    warmup: ["live", "draft"],
    live: ["ended"],
    ended: [],
  };

  async function setStatus(eventId: string, status: EventStatus): Promise<EventDefinition> {
    const e = await get(eventId);
    if (e.status === status) return e;
    if (!allowed[e.status].includes(status)) {
      throw new ValidationError(`invalid transition: ${e.status} -> ${status}`);
    }
    const next: EventDefinition = { ...e, status, updatedAtMs: now() };
    await repo.put(next);
    // ADR 0015 Phase 2: live 遷移時に reconcile Lambda を直接起動し、EventBridge 検知遅延 (0-60s) をスキップ。
    if (status === "live") await afterTransition(() => deps.onGoLive?.(eventId));
    // 終了したら翻訳参考資料を消す。用語集と同じタイミングで揃える。
    if (status === "ended") await afterTransition(() => deps.cleanupMaterials?.(eventId));
    // ADR 0015 Phase 4: scheduled 遷移時にウォームアップスケジュールを作成。
    // scheduled 以外への遷移時はスケジュールを削除。
    if (status === "scheduled") {
      await afterTransition(() => deps.onWarmupSchedule?.(eventId, e.startsAt));
    } else if (e.status === "scheduled") {
      await afterTransition(() => deps.onWarmupSchedule?.(eventId, null));
    }
    return next;
  }

  async function remove(eventId: string): Promise<void> {
    const e = await get(eventId);
    if (e.status === "live") throw new ValidationError("cannot delete a live event");
    await repo.delete(eventId);
    await deps.cleanupStorage?.(eventId);
  }

  return { create, get, list, update, setStatus, remove };
}
