/**
 * RoomConnector の LiveKit 実装 (ブラウザ用)。
 * livekit-client の Room を用いて WebRTC publish を行う。テストでは使わず、
 * 本番 (main.tsx) でのみ生成する。
 */
import { Room, RoomEvent } from "livekit-client";
import type { PreferredDevices } from "./devices.js";
import type { RoomConnector, RoomState, SlideMessage } from "./room.js";

export class LiveKitRoomConnector implements RoomConnector {
  private room = new Room();
  state: RoomState = "idle";
  private encoder = new TextEncoder();
  private prefs: PreferredDevices = {};

  async connect(url: string, token: string): Promise<void> {
    await this.room.connect(url, token);
    this.state = "connected";
  }
  setPreferredDevices(prefs: PreferredDevices): void {
    this.prefs = prefs;
  }
  onDisconnected(handler: () => void): void {
    this.room.on(RoomEvent.Disconnected, () => {
      this.state = "disconnected";
      handler();
    });
  }
  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    // 入室前テストで選んだマイクを capture options で指定する (N7)。
    await this.room.localParticipant.setMicrophoneEnabled(
      enabled,
      this.prefs.microphoneId ? { deviceId: { exact: this.prefs.microphoneId } } : undefined,
    );
  }
  async setCameraEnabled(enabled: boolean): Promise<void> {
    await this.room.localParticipant.setCameraEnabled(
      enabled,
      this.prefs.cameraId ? { deviceId: { exact: this.prefs.cameraId } } : undefined,
    );
  }
  async setScreenShareEnabled(enabled: boolean): Promise<void> {
    await this.room.localParticipant.setScreenShareEnabled(enabled);
  }
  async sendSlide(message: SlideMessage): Promise<void> {
    const payload = this.encoder.encode(JSON.stringify(message));
    await this.room.localParticipant.publishData(payload, { reliable: true, topic: "slides" });
  }
  async disconnect(): Promise<void> {
    await this.room.disconnect();
    this.state = "disconnected";
  }
}
