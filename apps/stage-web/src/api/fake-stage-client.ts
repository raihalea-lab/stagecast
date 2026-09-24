/**
 * テスト用の StageClient (外部接続なし)。App と StageController のテストで共有する。
 */
import type {
  JoinResponse,
  PresentationSnapshot,
  SlideStateUpdate,
  StageClient,
} from "./stage-client.js";
import type { LayoutKind, SpeakerVisibility } from "@stagecast/shared";

export class FakeStageClient implements StageClient {
  readonly visibilityCalls: { eventId: string; speakerId: string; visibility: string }[] = [];
  constructor(private readonly response: JoinResponse) {}
  async join(): Promise<JoinResponse> {
    return this.response;
  }
  async issuePreviewToken() {
    return {
      livekitUrl: "wss://sfu.test",
      livekitToken: "preview.token.fake",
      identity: "preview-fake",
      room: "evt-1",
    };
  }
  async setSpeakerVisibility(
    _inviteToken: string,
    eventId: string,
    speakerId: string,
    visibility: SpeakerVisibility,
  ): Promise<void> {
    this.visibilityCalls.push({ eventId, speakerId, visibility });
  }
  /** ADR 0022 D-1: 投影状態はサーバーが持つ。フェイクはメモリに置く。 */
  presentation: PresentationSnapshot = { eventId: "evt-1", speakers: [] };
  async getPresentationState(): Promise<PresentationSnapshot> {
    return this.presentation;
  }
  async setSlideState(
    _inviteToken: string,
    update: SlideStateUpdate,
  ): Promise<PresentationSnapshot> {
    this.presentation = { ...this.presentation, ...update };
    return this.presentation;
  }
  async setLayoutState(
    _inviteToken: string,
    layout: LayoutKind,
    focusIdentity?: string,
  ): Promise<PresentationSnapshot> {
    this.presentation = { ...this.presentation, layout, focusIdentity };
    return this.presentation;
  }
  readonly egressCalls: string[] = [];
  async startEgress(): Promise<void> {
    this.egressCalls.push("start");
  }
  async stopEgress(): Promise<void> {
    this.egressCalls.push("stop");
  }
  async listAssets() {
    return [];
  }
  async getAssetDownloadUrl() {
    return "https://fake-download-url";
  }
  async listPresets() {
    return [];
  }
  async createPreset(_t: string, label: string, config: unknown) {
    return {
      presetId: "fake-id",
      eventId: "evt-1",
      config: config as import("@stagecast/shared").Preset["config"],
      label,
      sortOrder: 0,
      createdAt: new Date().toISOString(),
    };
  }
  async deletePreset() {}
  async getMaterialUploadUrl() {
    return { assetId: "deck-1", key: "assets/decks/evt-1/deck-1.pdf", uploadUrl: "https://put" };
  }
  async getMaterialDownloadUrl() {
    return "https://signed/deck.pdf";
  }
}
