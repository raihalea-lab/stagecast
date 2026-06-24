/**
 * 入室前デバイステスト (N7, DESIGN.md 4.1)。
 *
 * 登壇者が招待 URL で入る前に、使用するマイク/カメラを選び、マイク音量メーターで
 * 実際に音が拾えているか確認できるようにする。ブラウザ API (mediaDevices / AudioContext)
 * は `MediaDevicesProvider` で抽象化し、純粋ロジック (一覧整形・選択解決・レベル平滑化・
 * 設定永続化) を外部接続なしに単体テストする (CLAUDE.md テスト方針)。
 */

export type StageDeviceKind = "audioinput" | "videoinput";

export interface DeviceInfo {
  deviceId: string;
  label: string;
  kind: StageDeviceKind;
}

/** マイク音量メーター (0..1)。stop で確保したリソースを解放する。 */
export interface MicMeter {
  level(): number;
  stop(): void;
}

/** カメラプレビュー stream。video 要素の srcObject に渡して使う。stop でトラックを止める。 */
export interface CameraPreview {
  /** <video srcObject> に渡すための MediaStream。 */
  stream: MediaStream;
  stop(): void;
}

export interface MediaDevicesProvider {
  /** 権限要求 + デバイス列挙。 */
  list(): Promise<DeviceInfo[]>;
  /** 指定マイクの音量メーターを開く (未指定は既定マイク)。 */
  openMicMeter(deviceId?: string): Promise<MicMeter>;
  /** 指定カメラのプレビュー stream を開く (未指定は既定カメラ)。 */
  openCameraPreview(deviceId?: string): Promise<CameraPreview>;
}

export interface PreferredDevices {
  microphoneId?: string;
  cameraId?: string;
}

/** 列挙結果をマイク/カメラに分ける。 */
export function splitDevices(devices: DeviceInfo[]): {
  microphones: DeviceInfo[];
  cameras: DeviceInfo[];
} {
  return {
    microphones: devices.filter((d) => d.kind === "audioinput"),
    cameras: devices.filter((d) => d.kind === "videoinput"),
  };
}

/** 保存済み選択が一覧に在ればそれを、無ければ先頭を選ぶ。 */
export function resolveSelected(devices: DeviceInfo[], savedId?: string): string | undefined {
  if (savedId && devices.some((d) => d.deviceId === savedId)) return savedId;
  return devices[0]?.deviceId;
}

/** 指数移動平均でレベルを平滑化し、メーターのちらつきを抑える。 */
export function smoothLevel(prev: number, sample: number, alpha = 0.4): number {
  const clamped = Math.max(0, Math.min(1, sample));
  return prev * (1 - alpha) + clamped * alpha;
}

/** localStorage 互換の最小ストア (テストで差し替え可能)。 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFS_KEY = "stagecast.devicePrefs";

export function loadPreferredDevices(store: KeyValueStore): PreferredDevices {
  try {
    const raw = store.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PreferredDevices;
    return {
      ...(parsed.microphoneId ? { microphoneId: parsed.microphoneId } : {}),
      ...(parsed.cameraId ? { cameraId: parsed.cameraId } : {}),
    };
  } catch {
    return {};
  }
}

export function savePreferredDevices(store: KeyValueStore, prefs: PreferredDevices): void {
  store.setItem(PREFS_KEY, JSON.stringify(prefs));
}

/** テスト/ローカル用フェイク。固定のデバイス一覧と擬似レベルを返す。 */
export class FakeMediaDevicesProvider implements MediaDevicesProvider {
  stopped = 0;
  cameraStopped = 0;
  cameraOpens: Array<string | undefined> = [];
  constructor(
    private readonly devices: DeviceInfo[],
    private readonly levels: number[] = [0.5],
  ) {}
  async list(): Promise<DeviceInfo[]> {
    return this.devices;
  }
  async openMicMeter(_deviceId?: string): Promise<MicMeter> {
    let i = 0;
    return {
      level: () => this.levels[i++ % this.levels.length] ?? 0,
      stop: () => {
        this.stopped += 1;
      },
    };
  }
  async openCameraPreview(deviceId?: string): Promise<CameraPreview> {
    this.cameraOpens.push(deviceId);
    // jsdom には MediaStream が無いので最小限のスタブ。
    const stream = {} as unknown as MediaStream;
    return {
      stream,
      stop: () => {
        this.cameraStopped += 1;
      },
    };
  }
}
