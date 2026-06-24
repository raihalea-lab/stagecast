/**
 * RoomConnector の LiveKit 実装 (ブラウザ用)。
 * livekit-client の Room を用いて WebRTC publish を行う。テストでは使わず、
 * 本番 (main.tsx) でのみ生成する。
 *
 * D8: publishData + 参加者追跡 + DataChannel 受信を追加。
 */
import { Room, RoomEvent, Track } from "livekit-client";
import type { PreferredDevices } from "./devices.js";
import type {
  ConnectOptions,
  ParticipantSnapshot,
  RoomConnector,
  RoomState,
  SlideMessage,
} from "./room.js";

export class LiveKitRoomConnector implements RoomConnector {
  private room = new Room();
  state: RoomState = "idle";
  private encoder = new TextEncoder();
  private prefs: PreferredDevices = {};
  private participantsHandler?: (participants: ParticipantSnapshot[]) => void;

  async connect(url: string, token: string, options?: ConnectOptions): Promise<void> {
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

    this.setupParticipantTracking();

    await this.room.connect(url, token, rtcConfig ? { rtcConfig } : undefined);
    this.state = "connected";
    this.refreshParticipants();
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
  onParticipantsChanged(handler: (participants: ParticipantSnapshot[]) => void): void {
    this.participantsHandler = handler;
  }
  onDataReceived(handler: (payload: Uint8Array) => void): void {
    this.room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
      handler(payload);
    });
  }
  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
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
  async publishData(payload: Uint8Array): Promise<void> {
    await this.room.localParticipant.publishData(payload, { reliable: true });
  }
  getParticipants(): ParticipantSnapshot[] {
    return this.buildSnapshots();
  }
  async disconnect(): Promise<void> {
    await this.room.disconnect();
    this.state = "disconnected";
  }

  private setupParticipantTracking(): void {
    const refresh = () => this.refreshParticipants();
    this.room
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.TrackPublished, refresh)
      .on(RoomEvent.TrackUnpublished, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh);
  }

  private refreshParticipants(): void {
    this.participantsHandler?.(this.buildSnapshots());
  }

  private buildSnapshots(): ParticipantSnapshot[] {
    const snapshots: ParticipantSnapshot[] = [];
    for (const p of this.room.remoteParticipants.values()) {
      let isMuted = true;
      let isScreenSharing = false;
      for (const pub of p.trackPublications.values()) {
        if (pub.source === Track.Source.Microphone) {
          isMuted = pub.isMuted;
        }
        if (pub.source === Track.Source.ScreenShare && !pub.isMuted) {
          isScreenSharing = true;
        }
      }
      snapshots.push({
        identity: p.identity,
        name: p.name,
        isTalking: p.isSpeaking,
        isMuted,
        isScreenSharing,
      });
    }
    return snapshots;
  }
}
