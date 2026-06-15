/**
 * SFU(LiveKit) への接続・publish 抽象 (DESIGN.md 3.2, 5.2, F-1, F-3)。
 *
 * 登壇者はカメラ・マイク・画面共有を publish する。スライドのページ送り (事前アップロード方式)
 * はデータメッセージで配る。テストではブラウザ無しで動く Fake を注入する。
 */

import type { PreferredDevices } from "./devices.js";

/** スライド送りのデータメッセージ (事前アップロード方式・5.2)。 */
export interface SlideMessage {
  type: "slide";
  page: number;
}

export type RoomState = "idle" | "connected" | "reconnecting" | "disconnected";

export interface RoomConnector {
  readonly state: RoomState;
  connect(url: string, token: string): Promise<void>;
  /** 入室前テストで選んだマイク/カメラを publish 時に使う (N7)。 */
  setPreferredDevices(prefs: PreferredDevices): void;
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  setCameraEnabled(enabled: boolean): Promise<void>;
  /** 画面共有の開始/停止 (DESIGN.md 5.2 画面共有方式)。 */
  setScreenShareEnabled(enabled: boolean): Promise<void>;
  /** スライドのページ送りを配信する (DESIGN.md 5.2 事前アップロード方式)。 */
  sendSlide(message: SlideMessage): Promise<void>;
  /** SFU から切断されたとき (回線断・サーバ都合) に呼ばれるハンドラを登録する。 */
  onDisconnected(handler: () => void): void;
  /** 一時的な回線断で自動再接続を試行中に呼ばれるハンドラを登録する (セッションは維持)。 */
  onReconnecting(handler: () => void): void;
  /** 自動再接続が成功し配信が復帰したときに呼ばれるハンドラを登録する。 */
  onReconnected(handler: () => void): void;
  disconnect(): Promise<void>;
}

/** テスト/ローカル用フェイク。publish 操作を記録する。 */
export class FakeRoomConnector implements RoomConnector {
  state: RoomState = "idle";
  readonly calls: string[] = [];
  readonly slides: SlideMessage[] = [];
  preferredDevices: PreferredDevices = {};
  mic = false;
  camera = false;
  screenShare = false;
  private disconnectHandler?: () => void;
  private reconnectingHandler?: () => void;
  private reconnectedHandler?: () => void;

  async connect(url: string, _token: string): Promise<void> {
    this.calls.push(`connect:${url}`);
    this.state = "connected";
  }
  onDisconnected(handler: () => void): void {
    this.disconnectHandler = handler;
  }
  onReconnecting(handler: () => void): void {
    this.reconnectingHandler = handler;
  }
  onReconnected(handler: () => void): void {
    this.reconnectedHandler = handler;
  }
  /** テストから切断を発火する。 */
  emitDisconnect(): void {
    this.state = "disconnected";
    this.disconnectHandler?.();
  }
  /** テストから一時的な再接続中/復帰を発火する。 */
  emitReconnecting(): void {
    this.state = "reconnecting";
    this.reconnectingHandler?.();
  }
  emitReconnected(): void {
    this.state = "connected";
    this.reconnectedHandler?.();
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
  async disconnect(): Promise<void> {
    this.state = "disconnected";
    this.calls.push("disconnect");
  }
}
