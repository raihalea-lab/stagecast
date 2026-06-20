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
  LiveKitCredentials,
  LiveKitSettingsStatus,
  PresentationState,
  SlideSource,
  SpeakerVisibility,
  YouTubeCredentials,
  YouTubeSettingsStatus,
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

/** Egress 起動結果 (R12)。 */
export interface EgressStartResult {
  egressId: string;
  /** ストリームキーを含む完全な RTMP URL (機密情報を含むので UI には表示しない)。 */
  rtmpUrl: string;
}

export interface ControlApiClient {
  listEvents(): Promise<EventDefinition[]>;
  createEvent(input: CreateEventInput): Promise<EventDefinition>;
  getEvent(id: string): Promise<EventDefinition>;
  updateEvent(id: string, patch: Partial<CreateEventInput>): Promise<EventDefinition>;
  setStatus(id: string, status: EventStatus): Promise<EventDefinition>;
  deleteEvent(id: string): Promise<void>;

  issueInvite(eventId: string, role: InvitedRole, ttlSec: number): Promise<IssuedInvite>;

  /** Egress (RTMP 送出) を起動する (R12, ADR 0006 D-4)。 */
  startEgress(eventId: string): Promise<EgressStartResult>;

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

  /** LiveKit / YouTube の運用設定 (ADR D-10, ADR 0008 D-7)。値の取得は configured フラグのみ。 */
  getLiveKitSettings(): Promise<LiveKitSettingsStatus>;
  putLiveKitSettings(creds: LiveKitCredentials): Promise<LiveKitSettingsStatus>;
  /** LiveKit の API キー/シークレットをサーバ側で再生成する。 */
  regenerateLiveKitKeys(): Promise<LiveKitSettingsStatus>;
  getYouTubeSettings(): Promise<YouTubeSettingsStatus>;
  putYouTubeSettings(creds: YouTubeCredentials): Promise<YouTubeSettingsStatus>;
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

/** 配信成果物 (録画 / 確定字幕) のダウンロード情報 (N1, DESIGN.md 6.4 / N-4)。 */
export interface Artifact {
  kind: "recording" | "caption";
  key: string;
  name: string;
  downloadUrl: string;
  size?: number;
}

/**
 * 配信後の成果物ダウンロード (DESIGN.md 6.4)。
 * 本番は control-api 経由で S3 署名付き GET URL を取得。ローカルはインメモリ。
 */
export interface ArtifactService {
  list(eventId: string): Promise<Artifact[]>;
}
