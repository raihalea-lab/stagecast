/**
 * 本番用 HTTP クライアント (API Gateway 制御 API を呼ぶ)。
 * 認証トークンは Cognito から取得した JWT を Authorization に載せる (F-12)。
 */
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
import type {
  AdminTokenResult,
  ControlApiClient,
  EgressStartResult,
  IssuedInvite,
  PreviewTokenResult,
  StageTokenResult,
} from "./types.js";

export class HttpControlApiClient implements ControlApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | undefined,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.getToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
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
  startEgress(eventId: string): Promise<EgressStartResult> {
    return this.call("POST", `/events/${eventId}/egress/start`);
  }
  issueAdminToken(eventId: string): Promise<AdminTokenResult> {
    return this.call("POST", `/events/${eventId}/admin-token`);
  }
  issueStageToken(eventId: string): Promise<StageTokenResult> {
    return this.call("POST", `/events/${eventId}/stage-token`);
  }
  issuePreviewToken(eventId: string): Promise<PreviewTokenResult> {
    return this.call("POST", `/events/${eventId}/preview-token`);
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
