/**
 * ステージ操作のコントローラ (UI 非依存・テスト可能)。
 *
 * 招待トークンでの入室 → SFU 接続 → publish 制御 → スライド送り を束ねる。
 * React コンポーネントはこのコントローラを呼ぶだけにし、ロジックを外部接続なしに検証する。
 *
 * D8: moderator/admin 用に layout 変更・ミュート要請・参加者追跡を追加。
 */
import { encodeStageMessage, type LayoutKind, type InvitedRole } from "@stagecast/shared";
import type { JoinOptions, JoinResponse, StageClient } from "./api/stage-client.js";
import type { PreferredDevices } from "./lib/devices.js";
import type { ParticipantSnapshot, RoomConnector } from "./lib/room.js";
import { goToPage, nextPage, prevPage, type SlideDeckState } from "./lib/slides.js";

export interface StageSession {
  eventId: string;
  role: InvitedRole;
  room: string;
  canPublish: boolean;
}

export class StageController {
  private session?: StageSession;
  private deck: SlideDeckState = { page: 1, totalPages: 1 };
  private lastJoin?: JoinResponse;
  private joinInFlight?: Promise<JoinResponse>;

  constructor(
    private readonly client: StageClient,
    private readonly room: RoomConnector,
  ) {}

  get currentSession(): StageSession | undefined {
    return this.session;
  }
  get slideDeck(): SlideDeckState {
    return this.deck;
  }

  setPreferredDevices(prefs: PreferredDevices): void {
    this.room.setPreferredDevices(prefs);
  }

  onDisconnected(handler: () => void): void {
    this.room.onDisconnected(() => {
      this.session = undefined;
      this.lastJoin = undefined;
      handler();
    });
  }

  onReconnecting(handler: () => void): void {
    this.room.onReconnecting(handler);
  }
  onReconnected(handler: () => void): void {
    this.room.onReconnected(handler);
  }

  onParticipantsChanged(handler: (participants: ParticipantSnapshot[]) => void): void {
    this.room.onParticipantsChanged(handler);
  }

  onDataReceived(handler: (payload: Uint8Array) => void): void {
    this.room.onDataReceived(handler);
  }

  async join(token: string, displayName?: string, options?: JoinOptions): Promise<JoinResponse> {
    if (this.session && this.lastJoin) return this.lastJoin;
    if (this.joinInFlight) return this.joinInFlight;
    this.joinInFlight = (async () => {
      const res = await this.client.join(token, displayName, options);
      if (!res.ok) return res;
      await this.room.connect(
        res.livekitUrl,
        res.livekitToken,
        res.iceServers ? { iceServers: res.iceServers } : undefined,
      );
      this.session = {
        eventId: res.eventId,
        role: res.role,
        room: res.room,
        // speaker と moderator はメディア publish 可 (LiveKit 側は両方 canPublish: true)。
        canPublish: res.role === "speaker" || res.role === "moderator",
      };
      this.lastJoin = res;
      return res;
    })();
    try {
      return await this.joinInFlight;
    } finally {
      this.joinInFlight = undefined;
    }
  }

  private requirePublish(): void {
    if (!this.session?.canPublish) throw new Error("this role cannot publish");
  }

  async toggleMic(on: boolean): Promise<void> {
    this.requirePublish();
    await this.room.setMicrophoneEnabled(on);
  }
  async toggleCamera(on: boolean): Promise<void> {
    this.requirePublish();
    await this.room.setCameraEnabled(on);
  }
  async toggleScreenShare(on: boolean): Promise<void> {
    this.requirePublish();
    await this.room.setScreenShareEnabled(on);
  }

  setDeck(totalPages: number): void {
    this.deck = { page: 1, totalPages: Math.max(1, totalPages) };
  }

  async slideNext(): Promise<number> {
    this.requirePublish();
    this.deck = nextPage(this.deck);
    await this.room.sendSlide({ type: "slide", page: this.deck.page });
    return this.deck.page;
  }
  async slidePrev(): Promise<number> {
    this.requirePublish();
    this.deck = prevPage(this.deck);
    await this.room.sendSlide({ type: "slide", page: this.deck.page });
    return this.deck.page;
  }
  async slideGoTo(page: number): Promise<number> {
    this.requirePublish();
    this.deck = goToPage(this.deck, page);
    await this.room.sendSlide({ type: "slide", page: this.deck.page });
    return this.deck.page;
  }

  /** layout 切替を DataChannel で broadcast する (D8: moderator/admin 用)。 */
  async changeLayout(layout: LayoutKind, focusIdentity?: string): Promise<void> {
    if (!this.session) throw new Error("not joined");
    await this.room.publishData(
      encodeStageMessage({ type: "layout-change", layout, focusIdentity }),
    );
  }

  /** 特定の participant にミュート要請を送る (D8: moderator/admin 用)。 */
  async requestMute(targetIdentity: string): Promise<void> {
    if (!this.session) throw new Error("not joined");
    await this.room.publishData(encodeStageMessage({ type: "mute-request", targetIdentity }));
  }

  /** 現在の参加者スナップショットを取得する (D8)。 */
  getParticipants(): ParticipantSnapshot[] {
    return this.room.getParticipants();
  }

  async leave(): Promise<void> {
    if (!this.session && !this.lastJoin) return;
    await this.room.disconnect();
    this.session = undefined;
    this.lastJoin = undefined;
  }
}
