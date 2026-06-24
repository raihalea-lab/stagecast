import type { EventRequest } from "@stagecast/shared";
import type { EventRequestRepository } from "../repo/types.js";
import { ValidationError, type EventService } from "./events.js";

export interface CreateEventRequestInput {
  requesterName: string;
  requesterEmail?: string;
  title: string;
  startsAt: string;
  endsAt: string;
  description?: string;
}

export type EventRequestService = ReturnType<typeof createEventRequestService>;

export function createEventRequestService(deps: {
  repo: EventRequestRepository;
  events: EventService;
  newId: () => string;
  now: () => number;
}) {
  const { repo, events, newId, now } = deps;

  function validateIsoDatetime(field: string, value: unknown): string {
    if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) {
      throw new ValidationError(`${field} must be an ISO datetime`);
    }
    return value;
  }

  async function create(input: CreateEventRequestInput): Promise<EventRequest> {
    if (typeof input.requesterName !== "string" || !input.requesterName.trim()) {
      throw new ValidationError("requesterName is required");
    }
    if (typeof input.title !== "string" || !input.title.trim()) {
      throw new ValidationError("title is required");
    }
    if (input.title.length > 200) {
      throw new ValidationError("title must be <= 200 chars");
    }
    const startsAt = validateIsoDatetime("startsAt", input.startsAt);
    const endsAt = validateIsoDatetime("endsAt", input.endsAt);
    if (Date.parse(endsAt) < Date.parse(startsAt)) {
      throw new ValidationError("endsAt must be at or after startsAt");
    }
    if (input.description !== undefined && input.description.length > 1000) {
      throw new ValidationError("description must be <= 1000 chars");
    }
    const ts = now();
    const request: EventRequest = {
      id: newId(),
      requesterName: input.requesterName.trim(),
      requesterEmail: input.requesterEmail?.trim() || undefined,
      title: input.title.trim(),
      startsAt,
      endsAt,
      description: input.description?.trim() || undefined,
      status: "pending",
      createdAtMs: ts,
      updatedAtMs: ts,
    };
    await repo.put(request);
    return request;
  }

  async function list(): Promise<EventRequest[]> {
    return repo.list();
  }

  async function get(id: string): Promise<EventRequest> {
    const r = await repo.get(id);
    if (!r) throw new ValidationError(`event request ${id} not found`);
    return r;
  }

  async function approve(id: string) {
    const r = await get(id);
    if (r.status !== "pending") {
      throw new ValidationError(`cannot approve a ${r.status} request`);
    }
    const event = await events.create({
      title: r.title,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      caption: {
        languages: ["ja", "en"],
        youtubeLanguage: "ja",
        engine: "transcribe",
        customApiEnabled: false,
      },
    });
    const updated: EventRequest = {
      ...r,
      status: "approved",
      approvedEventId: event.id,
      updatedAtMs: now(),
    };
    await repo.put(updated);
    return { request: updated, event };
  }

  async function reject(id: string, reason?: string) {
    const r = await get(id);
    if (r.status !== "pending") {
      throw new ValidationError(`cannot reject a ${r.status} request`);
    }
    const updated: EventRequest = {
      ...r,
      status: "rejected",
      rejectionReason: reason?.trim() || undefined,
      updatedAtMs: now(),
    };
    await repo.put(updated);
    return updated;
  }

  return { create, list, get, approve, reject };
}
