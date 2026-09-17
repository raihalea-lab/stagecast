/**
 * SFU(LiveKit) への接続・publish 抽象 (DESIGN.md 3.2, 5.2, F-1, F-3)。
 *
 * 登壇者はカメラ・マイク・画面共有を publish する。スライドのページ送り (事前アップロード方式)
 * はデータメッセージで配る。テストではブラウザ無しで動く Fake を注入する。
 *
 * D8: publishData + 参加者追跡 (Moderator/Admin サブビュー用) を追加。
 */

import type { PreferredDevices } from "./devices.js";

/** スライド送りのデータメッセージ (事前アップロード方式・5.2)。 */
export interface SlideMessage {
  type: "slide-page";
  page: number;
}

export type RoomState = "idle" | "connected" | "reconnecting" | "disconnected";

/** R12-followup-19: ICE 用 TURN server (server から /join で受け取る)。 */
export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface ConnectOptions {
  iceServers?: IceServerConfig[];
}

/** 参加者のスナップショット情報 (packages/ui の ParticipantInfo と 1:1 対応)。 */
export interface ParticipantSnapshot {
  identity: string;
  name?: string;
  isTalking: boolean;
  isMuted: boolean;
  isScreenSharing: boolean;
}

/** publishData の宛先指定。未指定なら room 全体に broadcast する。 */
export interface PublishDataOptions {
  destinationIdentities?: string[];
}

export interface RoomConnector {
  readonly state: RoomState;
  /** 接続後の自分の identity。 未接続なら undefined (D8: チャットの自他判定に使う)。 */
  readonly localIdentity: string | undefined;
  /** room metadata の生文字列 (ADR 0022 D-1 / 0025 D-2)。 接続時点の投影状態が入る。 */
  readonly roomMetadata: string | undefined;
  /** room metadata の更新ハンドラ。 他のウィンドウの操作もここから届く。 */
  onRoomMetadataChanged(handler: (metadata: string | undefined) => void): void;
  connect(url: string, token: string, options?: ConnectOptions): Promise<void>;
  setPreferredDevices(prefs: PreferredDevices): void;
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  setCameraEnabled(enabled: boolean): Promise<void>;
  setScreenShareEnabled(enabled: boolean): Promise<void>;
  sendSlide(message: SlideMessage): Promise<void>;
  /** 汎用データ送信 (layout-change / mute-request 等, D8)。 */
  publishData(payload: Uint8Array, opts?: PublishDataOptions): Promise<void>;
  /** 現在の参加者スナップショットを取得する (D8)。 */
  getParticipants(): ParticipantSnapshot[];
  /** 参加者情報が変化したときに呼ばれるハンドラを登録する (D8)。 */
  onParticipantsChanged(handler: (participants: ParticipantSnapshot[]) => void): void;
  /** DataChannel メッセージ受信ハンドラを登録する (mute-request 受信用, D8)。 */
  onDataReceived(handler: (payload: Uint8Array) => void): void;
  /** reason は LiveKit の DisconnectReason 名 (DUPLICATE_IDENTITY 等)。 切断の切り分けに要る。 */
  onDisconnected(handler: (reason?: string) => void): void;
  onReconnecting(handler: () => void): void;
  onReconnected(handler: () => void): void;
  disconnect(): Promise<void>;
}

/** テスト/ローカル用フェイク。publish 操作を記録する。 */
export class FakeRoomConnector implements RoomConnector {
  state: RoomState = "idle";
  localIdentity: string | undefined;
  roomMetadata: string | undefined;
  private metadataHandler?: (metadata: string | undefined) => void;
  readonly calls: string[] = [];
  readonly slides: SlideMessage[] = [];
  readonly publishedData: Uint8Array[] = [];
  preferredDevices: PreferredDevices = {};
  mic = false;
  camera = false;
  screenShare = false;
  participants: ParticipantSnapshot[] = [];
  private disconnectHandler?: (reason?: string) => void;
  private reconnectingHandler?: () => void;
  private reconnectedHandler?: () => void;
  private participantsHandler?: (participants: ParticipantSnapshot[]) => void;
  private dataHandler?: (payload: Uint8Array) => void;

  async connect(url: string, _token: string, options?: ConnectOptions): Promise<void> {
    this.calls.push(
      options?.iceServers?.length
        ? `connect:${url}:ice=${options.iceServers.length}`
        : `connect:${url}`,
    );
    this.state = "connected";
  }
  onDisconnected(handler: (reason?: string) => void): void {
    this.disconnectHandler = handler;
  }
  onRoomMetadataChanged(handler: (metadata: string | undefined) => void): void {
    this.metadataHandler = handler;
  }
  /** テストから metadata 更新を流し込む (他ウィンドウの操作が届いた状況を作る)。 */
  emitRoomMetadata(metadata: string | undefined): void {
    this.roomMetadata = metadata;
    this.metadataHandler?.(metadata);
  }
  onReconnecting(handler: () => void): void {
    this.reconnectingHandler = handler;
  }
  onReconnected(handler: () => void): void {
    this.reconnectedHandler = handler;
  }
  onParticipantsChanged(handler: (participants: ParticipantSnapshot[]) => void): void {
    this.participantsHandler = handler;
  }
  onDataReceived(handler: (payload: Uint8Array) => void): void {
    this.dataHandler = handler;
  }
  emitDisconnect(): void {
    this.state = "disconnected";
    this.disconnectHandler?.();
  }
  emitReconnecting(): void {
    this.state = "reconnecting";
    this.reconnectingHandler?.();
  }
  emitReconnected(): void {
    this.state = "connected";
    this.reconnectedHandler?.();
  }
  emitParticipantsChanged(participants: ParticipantSnapshot[]): void {
    this.participants = participants;
    this.participantsHandler?.(participants);
  }
  emitDataReceived(payload: Uint8Array): void {
    this.dataHandler?.(payload);
  }
  setPreferredDevices(prefs: PreferredDevices): void {
    this.preferredDevices = prefs;
    this.calls.push(`prefs:${prefs.microphoneId ?? "-"}/${prefs.cameraId ?? "-"}`);
  }
  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    this.mic = enabled;
    this.calls.push(`mic:${enabled}`);
  }
  async setCameraEnabled(enabled: boolean): Promise<void> {
    this.camera = enabled;
    this.calls.push(`camera:${enabled}`);
  }
  async setScreenShareEnabled(enabled: boolean): Promise<void> {
    this.screenShare = enabled;
    this.calls.push(`screen:${enabled}`);
  }
  async sendSlide(message: SlideMessage): Promise<void> {
    this.slides.push(message);
  }
  publishedDestinations: (string[] | undefined)[] = [];
  async publishData(payload: Uint8Array, opts?: PublishDataOptions): Promise<void> {
    this.publishedData.push(payload);
    this.publishedDestinations.push(opts?.destinationIdentities);
    this.calls.push("publishData");
  }
  getParticipants(): ParticipantSnapshot[] {
    return this.participants;
  }
  async disconnect(): Promise<void> {
    this.state = "disconnected";
    this.calls.push("disconnect");
  }
}
