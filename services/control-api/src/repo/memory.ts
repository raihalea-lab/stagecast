/**
 * インメモリ・リポジトリ実装 (テスト/ローカル用)。
 * 本番では同じインターフェースの DynamoDB 実装に差し替える。
 */
import type {
  AssetMetadata,
  EventDefinition,
  EventRequest,
  Preset,
  PresentationState,
  SpeakerVisibility,
} from "@stagecast/shared";
import type {
  AssetMetadataRepository,
  EventRepository,
  EventRequestRepository,
  InviteTokenRecord,
  InviteTokenRepository,
  PresetRepository,
  PresentationRepository,
} from "./types.js";
import { applySlide, type SlideUpdate } from "./types.js";

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

export class MemoryEventRequestRepository implements EventRequestRepository {
  private readonly store = new Map<string, EventRequest>();

  async put(request: EventRequest): Promise<void> {
    this.store.set(request.id, structuredClone(request));
  }
  async get(id: string): Promise<EventRequest | undefined> {
    const r = this.store.get(id);
    return r ? structuredClone(r) : undefined;
  }
  async list(): Promise<EventRequest[]> {
    return [...this.store.values()]
      .map((r) => structuredClone(r))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
  }
  async delete(id: string): Promise<void> {
    this.store.delete(id);
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

  async setSlide(eventId: string, slide: SlideUpdate): Promise<PresentationState> {
    const s = this.ensure(eventId);
    applySlide(s, slide);
    return structuredClone(s);
  }
}

export class MemoryAssetMetadataRepository implements AssetMetadataRepository {
  private readonly store = new Map<string, AssetMetadata>();

  async put(asset: AssetMetadata): Promise<void> {
    this.store.set(asset.assetId, structuredClone(asset));
  }
  async get(assetId: string): Promise<AssetMetadata | undefined> {
    const a = this.store.get(assetId);
    return a ? structuredClone(a) : undefined;
  }
  async list(): Promise<AssetMetadata[]> {
    return [...this.store.values()].map((a) => structuredClone(a));
  }
  async delete(assetId: string): Promise<void> {
    this.store.delete(assetId);
  }
  async updateTags(assetId: string, tags: string[]): Promise<AssetMetadata> {
    const a = await this.get(assetId);
    if (!a) throw new Error(`Asset ${assetId} not found`);
    a.tags = tags;
    this.store.set(assetId, a);
    return structuredClone(a);
  }
  async updateDescription(assetId: string, description: string): Promise<AssetMetadata> {
    const a = await this.get(assetId);
    if (!a) throw new Error(`Asset ${assetId} not found`);
    a.description = description;
    this.store.set(assetId, a);
    return structuredClone(a);
  }
}

export class MemoryPresetRepository implements PresetRepository {
  private readonly store = new Map<string, Preset>();
  private key(eventId: string, presetId: string) {
    return `${eventId}#${presetId}`;
  }

  async put(preset: Preset): Promise<void> {
    this.store.set(this.key(preset.eventId, preset.presetId), structuredClone(preset));
  }
  async get(eventId: string, presetId: string): Promise<Preset | undefined> {
    const p = this.store.get(this.key(eventId, presetId));
    return p ? structuredClone(p) : undefined;
  }
  async listByEvent(eventId: string): Promise<Preset[]> {
    return [...this.store.values()]
      .filter((p) => p.eventId === eventId)
      .map((p) => structuredClone(p))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }
  async delete(eventId: string, presetId: string): Promise<void> {
    this.store.delete(this.key(eventId, presetId));
  }
}
