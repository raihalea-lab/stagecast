/**
 * イベント CRUD とライフサイクル状態の更新 (DESIGN.md 8 章, 7.1)。
 */
import {
  isValidCaptionSettings,
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

export function createEventService(deps: {
  repo: EventRepository;
  newId: () => string;
  now: () => number;
  cleanupStorage?: (eventId: string) => Promise<void>;
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
    return event;
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

  // ライフサイクル遷移 (DESIGN.md 7.1)。許可された遷移のみ受け付ける。
  const allowed: Record<EventStatus, EventStatus[]> = {
    draft: ["scheduled", "live"],
    scheduled: ["live", "draft"],
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
