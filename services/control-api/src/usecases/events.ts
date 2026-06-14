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

export function createEventService(deps: {
  repo: EventRepository;
  newId: () => string;
  now: () => number;
}) {
  const { repo, newId, now } = deps;

  async function create(input: CreateEventInput): Promise<EventDefinition> {
    if (!input.title.trim()) throw new ValidationError("title is required");
    if (!isValidCaptionSettings(input.caption)) {
      throw new ValidationError("youtubeLanguage must be one of caption.languages");
    }
    const ts = now();
    const event: EventDefinition = {
      id: newId(),
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
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
    const next: EventDefinition = { ...e, ...patch, updatedAtMs: now() };
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
  }

  return { create, get, list, update, setStatus, remove };
}
