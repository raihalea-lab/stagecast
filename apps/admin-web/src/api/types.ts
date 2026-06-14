/**
 * 管理コンソールが使う制御 API クライアントの抽象 (DESIGN.md 8 章)。
 *
 * 本番は HTTP (API Gateway) 実装、ローカル/テストは control-api のロジックを
 * インメモリで呼ぶ実装に差し替える。
 */
import type {
  AssetRef,
  EventDefinition,
  EventStatus,
  InvitedRole,
  PresentationState,
  SlideSource,
  SpeakerVisibility,
} from "@stagecast/shared";
import type { CreateEventInput } from "@stagecast/control-api";

export interface IssuedInvite {
  jti: string;
  token: string;
  url: string;
  role: InvitedRole;
  eventId: string;
  expiresAtSec: number;
  version: number;
}

export interface ControlApiClient {
  listEvents(): Promise<EventDefinition[]>;
  createEvent(input: CreateEventInput): Promise<EventDefinition>;
  getEvent(id: string): Promise<EventDefinition>;
  updateEvent(id: string, patch: Partial<CreateEventInput>): Promise<EventDefinition>;
  setStatus(id: string, status: EventStatus): Promise<EventDefinition>;
  deleteEvent(id: string): Promise<void>;

  issueInvite(eventId: string, role: InvitedRole, ttlSec: number): Promise<IssuedInvite>;

  getPresentation(eventId: string): Promise<PresentationState>;
  setSpeakerVisibility(
    eventId: string,
    speakerId: string,
    visibility: SpeakerVisibility,
  ): Promise<PresentationState>;
  setSlide(
    eventId: string,
    source: SlideSource | undefined,
    page?: number,
  ): Promise<PresentationState>;
}

/**
 * 素材アップロード (QR・配信素材・スライド) (DESIGN.md 8 章, 5.2)。
 * 本番は S3 への署名付き URL アップロード。ローカルはインメモリ保管。
 */
export interface AssetService {
  upload(
    eventId: string,
    file: { name: string; contentType: string; bytes: Uint8Array },
  ): Promise<AssetRef>;
}
