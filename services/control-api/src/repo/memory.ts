/**
 * インメモリ・リポジトリ実装 (テスト/ローカル用)。
 * 本番では同じインターフェースの DynamoDB 実装に差し替える。
 */
import type { EventDefinition, PresentationState, SpeakerVisibility } from '@stagecast/shared';
import type {
  EventRepository,
  InviteTokenRecord,
  InviteTokenRepository,
  PresentationRepository,
} from './types.js';

export class MemoryEventRepository implements EventRepository {
  private readonly store = new Map<string, EventDefinition>();

  async put(event: EventDefinition): Promise<void> {
    this.store.set(event.id, structuredClone(event));
  }
  async get(eventId: string): Promise<EventDefinition | undefined> {
    const e = this.store.get(eventId);
    return e ? structuredClone(e) : undefined;
  }
  async list(): Promise<EventDefinition[]> {
    return [...this.store.values()].map((e) => structuredClone(e));
  }
  async delete(eventId: string): Promise<void> {
    this.store.delete(eventId);
  }
}

export class MemoryInviteTokenRepository implements InviteTokenRepository {
  private readonly store = new Map<string, InviteTokenRecord>();

  async put(record: InviteTokenRecord): Promise<void> {
    this.store.set(record.jti, { ...record });
  }
  async get(jti: string): Promise<InviteTokenRecord | undefined> {
    const r = this.store.get(jti);
    return r ? { ...r } : undefined;
  }
  async listByEvent(eventId: string): Promise<InviteTokenRecord[]> {
    return [...this.store.values()].filter((r) => r.eventId === eventId).map((r) => ({ ...r }));
  }
}

export class MemoryPresentationRepository implements PresentationRepository {
  private readonly store = new Map<string, PresentationState>();

  private ensure(eventId: string): PresentationState {
    let s = this.store.get(eventId);
    if (!s) {
      s = { eventId, speakers: [] };
      this.store.set(eventId, s);
    }
    return s;
  }

  async get(eventId: string): Promise<PresentationState | undefined> {
    const s = this.store.get(eventId);
    return s ? structuredClone(s) : undefined;
  }

  async setSpeakerVisibility(
    eventId: string,
    speakerId: string,
    visibility: SpeakerVisibility,
    nowMs: number,
  ): Promise<PresentationState> {
    const s = this.ensure(eventId);
    const existing = s.speakers.find((sp) => sp.speakerId === speakerId);
    if (existing) {
      existing.visibility = visibility;
      existing.updatedAtMs = nowMs;
    } else {
      s.speakers.push({ speakerId, visibility, updatedAtMs: nowMs });
    }
    return structuredClone(s);
  }

  async setSlide(
    eventId: string,
    slide: Pick<PresentationState, 'slideSource' | 'slidePage'>,
  ): Promise<PresentationState> {
    const s = this.ensure(eventId);
    s.slideSource = slide.slideSource;
    s.slidePage = slide.slidePage;
    return structuredClone(s);
  }
}
