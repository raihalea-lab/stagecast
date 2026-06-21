/**
 * RoomConnector の LiveKit 実装 (ブラウザ用)。
 * livekit-client の Room を用いて WebRTC publish を行う。テストでは使わず、
 * 本番 (main.tsx) でのみ生成する。
 *
 * R12-followup-19: connect() の options.iceServers を受け取ったら Room を再生成して
 * rtcConfig.iceServers にセットする。 これで LiveKit Client SDK の
 * `if (!rtcConfig.iceServers)` 判定で server response の iceServers が無視され、
 * 我々が指定した KVS WebRTC TURN を確実に使うようになる。
 */
import { Room, RoomEvent } from "livekit-client";
import type { PreferredDevices } from "./devices.js";
import type { ConnectOptions, RoomConnector, RoomState, SlideMessage } from "./room.js";

export class LiveKitRoomConnector implements RoomConnector {
  private room = new Room();
  state: RoomState = "idle";
  private encoder = new TextEncoder();
  private prefs: PreferredDevices = {};

  async connect(url: string, token: string, options?: ConnectOptions): Promise<void> {
    // R12-followup-19: rtcConfig.iceServers は Room.connect の RoomConnectOptions で渡す。
    // LiveKit Client SDK の RTCEngine が `if (!rtcConfig.iceServers)` で server response の
    // iceServers を bypass する判定をしているので、 ここで明示すれば KVS WebRTC TURN を確実に使う。
    const rtcConfig =
      options?.iceServers && options.iceServers.length > 0
        ? {
            iceServers: options.iceServers.map((s) => ({
              urls: s.urls,
              ...(s.username ? { username: s.username } : {}),
              ...(s.credential ? { credential: s.credential } : {}),
            })),
          }
        : undefined;
    await this.room.connect(url, token, rtcConfig ? { rtcConfig } : undefined);
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
  onReconnecting(handler: () => void): void {
    this.room.on(RoomEvent.Reconnecting, () => {
      this.state = "reconnecting";
      handler();
    });
  }
  onReconnected(handler: () => void): void {
    this.room.on(RoomEvent.Reconnected, () => {
      this.state = "connected";
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
