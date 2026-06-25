/**
 * 制御 API の永続化インターフェース。
 *
 * 実体は DynamoDB (DESIGN.md 3.1) だが、テストとローカルでは外部接続なしに動かせるよう
 * インメモリ実装に差し替える (PROMPT 共通ルール「モック/フェイク実装」)。
 */
import type {
  EventDefinition,
  EventRequest,
  InvitedRole,
  PresentationState,
  SpeakerVisibility,
} from "@stagecast/shared";

export interface EventRepository {
  put(event: EventDefinition): Promise<void>;
  get(eventId: string): Promise<EventDefinition | undefined>;
  list(): Promise<EventDefinition[]>;
  delete(eventId: string): Promise<void>;
}

/** 招待トークンの失効・再発行を管理する記録 (jti 単位)。 */
export interface InviteTokenRecord {
  jti: string;
  eventId: string;
  /** 付与ロール (再発行時に引き継ぐ)。 */
  role: InvitedRole;
  /** 現在有効なバージョン。再発行で +1。古い version のトークンは無効。 */
  currentVersion: number;
  /** 失効済みフラグ。 */
  revoked: boolean;
}

export interface InviteTokenRepository {
  put(record: InviteTokenRecord): Promise<void>;
  get(jti: string): Promise<InviteTokenRecord | undefined>;
  listByEvent(eventId: string): Promise<InviteTokenRecord[]>;
}

export interface EventRequestRepository {
  put(request: EventRequest): Promise<void>;
  get(id: string): Promise<EventRequest | undefined>;
  list(): Promise<EventRequest[]>;
  delete(id: string): Promise<void>;
}

export interface PresentationRepository {
  get(eventId: string): Promise<PresentationState | undefined>;
  setSpeakerVisibility(
    eventId: string,
    speakerId: string,
    visibility: SpeakerVisibility,
    nowMs: number,
  ): Promise<PresentationState>;
  setSlide(
    eventId: string,
    slide: Pick<PresentationState, "slideSource" | "slidePage">,
  ): Promise<PresentationState>;
}
