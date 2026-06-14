/**
 * SFU(LiveKit) への接続・publish 抽象 (DESIGN.md 3.2, 5.2, F-1, F-3)。
 *
 * 登壇者はカメラ・マイク・画面共有を publish する。スライドのページ送り (事前アップロード方式)
 * はデータメッセージで配る。テストではブラウザ無しで動く Fake を注入する。
 */

/** スライド送りのデータメッセージ (事前アップロード方式・5.2)。 */
export interface SlideMessage {
  type: 'slide';
  page: number;
}

export type RoomState = 'idle' | 'connected' | 'disconnected';

export interface RoomConnector {
  readonly state: RoomState;
  connect(url: string, token: string): Promise<void>;
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  setCameraEnabled(enabled: boolean): Promise<void>;
  /** 画面共有の開始/停止 (DESIGN.md 5.2 画面共有方式)。 */
  setScreenShareEnabled(enabled: boolean): Promise<void>;
  /** スライドのページ送りを配信する (DESIGN.md 5.2 事前アップロード方式)。 */
  sendSlide(message: SlideMessage): Promise<void>;
  disconnect(): Promise<void>;
}

/** テスト/ローカル用フェイク。publish 操作を記録する。 */
export class FakeRoomConnector implements RoomConnector {
  state: RoomState = 'idle';
  readonly calls: string[] = [];
  readonly slides: SlideMessage[] = [];
  mic = false;
  camera = false;
  screenShare = false;

  async connect(url: string, _token: string): Promise<void> {
    this.calls.push(`connect:${url}`);
    this.state = 'connected';
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
    this.state = 'disconnected';
    this.calls.push('disconnect');
  }
}
