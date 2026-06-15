/**
 * ステージ操作のコントローラ (UI 非依存・テスト可能)。
 *
 * 招待トークンでの入室 → SFU 接続 → publish 制御 → スライド送り を束ねる。
 * React コンポーネントはこのコントローラを呼ぶだけにし、ロジックを外部接続なしに検証する。
 */
import type { InvitedRole } from "@stagecast/shared";
import type { JoinResponse, StageClient } from "./api/stage-client.js";
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

  /** 招待トークンで入室し、SFU へ接続する。 */
  async join(token: string, displayName?: string): Promise<JoinResponse> {
    const res = await this.client.join(token, displayName);
    if (!res.ok) return res;
    await this.room.connect(res.livekitUrl, res.livekitToken);
    this.session = {
      eventId: res.eventId,
      role: res.role,
      room: res.room,
      // 登壇者のみ publish 可。モデレーターは進行補助 (subscribe 主体)。
      canPublish: res.role === "speaker",
    };
    return res;
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
    await this.room.disconnect();
    this.session = undefined;
  }
}
