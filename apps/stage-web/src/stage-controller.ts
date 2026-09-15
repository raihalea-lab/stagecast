/**
 * ステージ操作のコントローラ (UI 非依存・テスト可能)。
 *
 * 招待トークンでの入室 → SFU 接続 → publish 制御 → スライド送り を束ねる。
 * React コンポーネントはこのコントローラを呼ぶだけにし、ロジックを外部接続なしに検証する。
 *
 * D8: moderator/admin 用に layout 変更・ミュート要請・参加者追跡を追加。
 */
import {
  encodeStageMessage,
  type LayoutKind,
  type SpeakerVisibility,
  type StageRole,
} from "@stagecast/shared";
import type { JoinOptions, JoinResponse, StageClient } from "./api/stage-client.js";
import type { PreferredDevices } from "./lib/devices.js";
import type { ParticipantSnapshot, RoomConnector } from "./lib/room.js";
import { goToPage, nextPage, prevPage, type SlideDeckState } from "./lib/slides.js";

export interface StageSession {
  eventId: string;
  role: StageRole;
  room: string;
  canPublish: boolean;
}

export class StageController {
  private session?: StageSession;
  private deck: SlideDeckState = { page: 1, totalPages: 1 };
  private lastJoin?: JoinResponse;
  private joinInFlight?: Promise<JoinResponse>;
  private knownIdentities = new Set<string>();

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
      // 再入室したときに全員を「既知」と誤認して join を検知できなくなるのを防ぐ。
      this.knownIdentities.clear();
      handler();
    });
  }

  onReconnecting(handler: () => void): void {
    this.room.onReconnecting(handler);
  }
  onReconnected(handler: () => void): void {
    this.room.onReconnected(handler);
  }

  /**
   * 参加者の変化を通知する。第 2 引数は今回新しく入室した identity (F-3, 5.2)。
   * RoomConnector のハンドラ枠は 1 つしかないので、差分の計算はここで持つ。
   */
  onParticipantsChanged(
    handler: (participants: ParticipantSnapshot[], joinedIdentities: string[]) => void,
  ): void {
    this.room.onParticipantsChanged((participants) => {
      const identities = participants.map((p) => p.identity);
      const joined = identities.filter((id) => !this.knownIdentities.has(id));
      this.knownIdentities = new Set(identities);
      handler(participants, joined);
    });
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
        canPublish: true,
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

  /** Admin 直接接続: /join を経由せず LiveKit に直接接続する (ADR 0014 D-4)。 */
  async connectAdmin(livekitUrl: string, livekitToken: string, eventId: string): Promise<void> {
    await this.room.connect(livekitUrl, livekitToken);
    this.session = {
      eventId,
      role: "admin",
      room: eventId,
      canPublish: true,
    };
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

  /** 事前アップロードスライド (PDF) のデッキ URL を composer に通知する (F-3, 5.2)。 */
  async setDeckUrl(url: string): Promise<void> {
    this.requirePublish();
    this.deck = { page: 1, totalPages: this.deck.totalPages };
    await this.room.publishData(encodeStageMessage({ type: "slide-deck", url }));
  }

  /**
   * 投影を解除して composer を通常レイアウトに戻す (F-3, 5.2)。
   * composer はデッキが載っている間 slide レイアウトを固定するため、これが無いと
   * イベント中ずっと grid / 画面共有メインに戻せない。
   */
  async hideDeck(): Promise<void> {
    this.requirePublish();
    this.deck = { page: 1, totalPages: 1 };
    await this.room.publishData(encodeStageMessage({ type: "slide-hide" }));
  }

  /**
   * 後から room に入ってきた participant (先にデッキを入れてから配信を始めた場合の
   * egress composer など) にデッキの現在状態を配り直す (F-3, 5.2)。
   * slide-deck は一度きりの broadcast なので、これが無いと composer が投影を受け取れない。
   */
  async republishDeck(url: string): Promise<void> {
    this.requirePublish();
    await this.room.publishData(encodeStageMessage({ type: "slide-deck", url }));
    // composer は slide-deck 受信で 1 ページ目に戻るので、現在ページを続けて送る。
    if (this.deck.page !== 1) {
      await this.room.sendSlide({ type: "slide-page", page: this.deck.page });
    }
  }

  async slideNext(): Promise<number> {
    this.requirePublish();
    this.deck = nextPage(this.deck);
    await this.room.sendSlide({ type: "slide-page", page: this.deck.page });
    return this.deck.page;
  }
  async slidePrev(): Promise<number> {
    this.requirePublish();
    this.deck = prevPage(this.deck);
    await this.room.sendSlide({ type: "slide-page", page: this.deck.page });
    return this.deck.page;
  }
  async slideGoTo(page: number): Promise<number> {
    this.requirePublish();
    this.deck = goToPage(this.deck, page);
    await this.room.sendSlide({ type: "slide-page", page: this.deck.page });
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
    await this.room.publishData(encodeStageMessage({ type: "mute-request", targetIdentity }), {
      destinationIdentities: [targetIdentity],
    });
  }

  /** 特定の participant を強制ミュートする (Phase 1)。受信側が自動的にマイクをオフにする。 */
  async forceMute(targetIdentity: string): Promise<void> {
    if (!this.session) throw new Error("not joined");
    // broadcast すると受信者全員が自分をミュートしてしまうため宛先を絞る。
    await this.room.publishData(encodeStageMessage({ type: "force-mute", targetIdentity }), {
      destinationIdentities: [targetIdentity],
    });
  }

  /** 登壇者の表示状態を変更する (Phase 1: ステージ管理)。REST API + DataChannel broadcast。 */
  async setSpeakerVisibility(
    speakerId: string,
    visibility: SpeakerVisibility,
    inviteToken?: string,
  ): Promise<void> {
    if (!this.session) throw new Error("not joined");
    if (inviteToken) {
      await this.client.setSpeakerVisibility(
        inviteToken,
        this.session.eventId,
        speakerId,
        visibility,
      );
    }
    await this.room.publishData(
      encodeStageMessage({ type: "visibility-change", speakerId, visibility }),
    );
  }

  /** バナー表示を DataChannel で broadcast する (Phase 3)。 */
  async showBanner(
    text: string,
    opts?: { subtext?: string; position?: "bottom" | "top"; autoHideMs?: number },
  ): Promise<void> {
    if (!this.session) throw new Error("not joined");
    await this.room.publishData(
      encodeStageMessage({
        type: "banner-show",
        text,
        subtext: opts?.subtext,
        position: opts?.position ?? "bottom",
        autoHideMs: opts?.autoHideMs,
      }),
    );
  }

  /** バナー非表示を DataChannel で broadcast する (Phase 3)。 */
  async hideBanner(): Promise<void> {
    if (!this.session) throw new Error("not joined");
    await this.room.publishData(encodeStageMessage({ type: "banner-hide" }));
  }

  /** オーバーレイ表示を DataChannel で broadcast する (Phase 4)。 */
  async showOverlay(
    kind: "qr" | "image" | "video",
    url: string,
    opts?: {
      position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
      sizePercent?: number;
      autoHideMs?: number;
    },
  ): Promise<void> {
    if (!this.session) throw new Error("not joined");
    await this.room.publishData(
      encodeStageMessage({
        type: "overlay-show",
        kind,
        url,
        position: opts?.position ?? "bottom-right",
        sizePercent: opts?.sizePercent,
        autoHideMs: opts?.autoHideMs,
      }),
    );
  }

  /** オーバーレイ非表示を DataChannel で broadcast する (Phase 4)。 */
  async hideOverlay(): Promise<void> {
    if (!this.session) throw new Error("not joined");
    await this.room.publishData(encodeStageMessage({ type: "overlay-hide" }));
  }

  /** チャットメッセージを DataChannel で broadcast する (Phase 2)。送信したメッセージを返す。 */
  async sendChat(
    text: string,
    displayName?: string,
  ): Promise<{
    id: string;
    senderIdentity: string;
    senderName?: string;
    text: string;
    timestampMs: number;
  }> {
    if (!this.session) throw new Error("not joined");
    const identity =
      this.lastJoin && this.lastJoin.ok ? this.lastJoin.identity : this.session.eventId;
    const msg = {
      type: "chat" as const,
      id: crypto.randomUUID(),
      senderIdentity: identity,
      senderName: displayName,
      text,
      timestampMs: Date.now(),
    };
    await this.room.publishData(encodeStageMessage(msg));
    return msg;
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
    this.knownIdentities.clear();
  }
}
