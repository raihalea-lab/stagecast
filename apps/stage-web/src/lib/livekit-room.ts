/**
 * RoomConnector の LiveKit 実装 (ブラウザ用)。
 * livekit-client の Room を用いて WebRTC publish を行う。テストでは使わず、
 * 本番 (main.tsx) でのみ生成する。
 */
import { Room } from 'livekit-client';
import type { RoomConnector, RoomState, SlideMessage } from './room.js';

export class LiveKitRoomConnector implements RoomConnector {
  private room = new Room();
  state: RoomState = 'idle';
  private encoder = new TextEncoder();

  async connect(url: string, token: string): Promise<void> {
    await this.room.connect(url, token);
    this.state = 'connected';
  }
  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    await this.room.localParticipant.setMicrophoneEnabled(enabled);
  }
  async setCameraEnabled(enabled: boolean): Promise<void> {
    await this.room.localParticipant.setCameraEnabled(enabled);
  }
  async setScreenShareEnabled(enabled: boolean): Promise<void> {
    await this.room.localParticipant.setScreenShareEnabled(enabled);
  }
  async sendSlide(message: SlideMessage): Promise<void> {
    const payload = this.encoder.encode(JSON.stringify(message));
    await this.room.localParticipant.publishData(payload, { reliable: true, topic: 'slides' });
  }
  async disconnect(): Promise<void> {
    await this.room.disconnect();
    this.state = 'disconnected';
  }
}
