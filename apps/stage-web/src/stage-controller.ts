/**
 * ステージ操作のコントローラ (UI 非依存・テスト可能)。
 *
 * 招待トークンでの入室 → SFU 接続 → publish 制御 → スライド送り を束ねる。
 * React コンポーネントはこのコントローラを呼ぶだけにし、ロジックを外部接続なしに検証する。
 */
import type { InvitedRole } from "@stagecast/shared";
import type { JoinOptions, JoinResponse, StageClient } from "./api/stage-client.js";
import type { PreferredDevices } from "./lib/devices.js";
import type { RoomConnector } from "./lib/room.js";
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

  /** 入室前テストで選んだマイク/カメラを SFU 接続に伝える (N7)。 */
  setPreferredDevices(prefs: PreferredDevices): void {
    this.room.setPreferredDevices(prefs);
  }

  /**
   * SFU 切断時に呼ばれるハンドラを登録する。切断ではセッションを無効化し、
   * UI は入室画面に戻して再入室を促す。
   */
  onDisconnected(handler: () => void): void {
    this.room.onDisconnected(() => {
      this.session = undefined;
      this.lastJoin = undefined; // 再入室を可能にする。
      handler();
    });
  }

  /**
   * 一時的な回線断の自動再接続を UI へ通知する。完全切断 (onDisconnected) と違い
   * セッションは維持され、復帰すれば publish もそのまま続く。
   */
  onReconnecting(handler: () => void): void {
    this.room.onReconnecting(handler);
  }
  onReconnected(handler: () => void): void {
    this.room.onReconnected(handler);
  }

  /**
   * 招待トークンで入室し、SFU へ接続する。
   * 連打/二重呼び出しでも SFU 接続は 1 回に保つ (in-flight を共有 + 入室済みは再接続しない)。
   * options で /join 503 リトライ動作 (ADR 0008 D-3) を制御できる。
   */
  async join(
    token: string,
    displayName?: string,
    options?: JoinOptions,
  ): Promise<JoinResponse> {
    if (this.session && this.lastJoin) return this.lastJoin; // 入室済み: 再接続しない。
    if (this.joinInFlight) return this.joinInFlight; // 同時呼び出しは 1 本にまとめる。
    this.joinInFlight = (async () => {
      const res = await this.client.join(token, displayName, options);
      if (!res.ok) return res;
      await this.room.connect(res.livekitUrl, res.livekitToken);
      this.session = {
        eventId: res.eventId,
        role: res.role,
        room: res.room,
        // 登壇者のみ publish 可。モデレーターは進行補助 (subscribe 主体)。
        canPublish: res.role === "speaker",
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

  /** 事前アップロードスライドのページ設定 (totalPages) を初期化する。 */
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

  async leave(): Promise<void> {
    // 未入室なら何もしない。二重退室で disconnect を重ねて呼ばない (冪等)。
    if (!this.session && !this.lastJoin) return;
    await this.room.disconnect();
    this.session = undefined;
    this.lastJoin = undefined; // 退室後の再 join をクリーンにする。
  }
}
