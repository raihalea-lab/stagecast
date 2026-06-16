/**
 * ローカル/テスト用の制御 API クライアント。
 *
 * control-api の実ロジック (buildControlApi) をインメモリで直接呼ぶ。これにより
 * バックエンドをデプロイせずに、管理コンソールの一連の操作 (イベント作成→素材登録→
 * 設定保存→配信開始) を検証できる (PROMPT フェーズ6 受け入れ基準)。
 */
import { buildControlApi, type App } from "@stagecast/control-api";
import type {
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
import type { ControlApiClient, IssuedInvite } from "./types.js";

const ADMIN_AUTH = "Bearer fake:admin-local:admin@stagecast.local";

export class LocalControlApiClient implements ControlApiClient {
  private readonly app: App;

  constructor(app?: App) {
    this.app = app ?? buildControlApi({ inviteSecret: "local-dev-secret" });
  }

  private async call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const res = await this.app.handle({
      method,
      path,
      headers: auth ? { authorization: ADMIN_AUTH } : {},
      body,
    });
    if (res.status >= 400) {
      throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return res.body as T;
  }

  listEvents(): Promise<EventDefinition[]> {
    return this.call("GET", "/events");
  }
  createEvent(input: CreateEventInput): Promise<EventDefinition> {
    return this.call("POST", "/events", input);
  }
  getEvent(id: string): Promise<EventDefinition> {
    return this.call("GET", `/events/${id}`);
  }
  updateEvent(id: string, patch: Partial<CreateEventInput>): Promise<EventDefinition> {
    return this.call("PATCH", `/events/${id}`, patch);
  }
  setStatus(id: string, status: EventStatus): Promise<EventDefinition> {
    return this.call("POST", `/events/${id}/status`, { status });
  }
  deleteEvent(id: string): Promise<void> {
    return this.call("DELETE", `/events/${id}`);
  }
  issueInvite(eventId: string, role: InvitedRole, ttlSec: number): Promise<IssuedInvite> {
    return this.call("POST", `/events/${eventId}/invites`, { role, ttlSec });
  }
  getPresentation(eventId: string): Promise<PresentationState> {
    return this.call("GET", `/events/${eventId}/presentation`);
  }
  setSpeakerVisibility(
    eventId: string,
    speakerId: string,
    visibility: SpeakerVisibility,
  ): Promise<PresentationState> {
    return this.call("POST", `/events/${eventId}/presentation/speakers`, { speakerId, visibility });
  }
  setSlide(
    eventId: string,
    source: SlideSource | undefined,
    page?: number,
  ): Promise<PresentationState> {
    return this.call("POST", `/events/${eventId}/presentation/slide`, {
      slideSource: source,
      slidePage: page,
    });
  }
  // ローカル/テストでは control-api を SettingsService 無しで構築しているため、
  // 設定 API は 503 を返す。実体での確認は HttpControlApiClient + Lambda 経由で行う。
  getLiveKitSettings(): Promise<LiveKitSettingsStatus> {
    return this.call("GET", "/settings/livekit");
  }
  putLiveKitSettings(creds: LiveKitCredentials): Promise<LiveKitSettingsStatus> {
    return this.call("PUT", "/settings/livekit", creds);
  }
  regenerateLiveKitKeys(): Promise<LiveKitSettingsStatus> {
    return this.call("POST", "/settings/livekit/regenerate");
  }
  getYouTubeSettings(): Promise<YouTubeSettingsStatus> {
    return this.call("GET", "/settings/youtube");
  }
  putYouTubeSettings(creds: YouTubeCredentials): Promise<YouTubeSettingsStatus> {
    return this.call("PUT", "/settings/youtube", creds);
  }
}
