/**
 * `MediaDevicesProvider` のブラウザ実装 (N7)。
 * navigator.mediaDevices + AudioContext を使うため本番 (main.tsx / App) のみで生成し、
 * テストでは `FakeMediaDevicesProvider` を注入する。
 */
import type {
  CameraPreview,
  DeviceInfo,
  MediaDevicesProvider,
  MicMeter,
  StageDeviceKind,
} from "./devices.js";

export class BrowserMediaDevicesProvider implements MediaDevicesProvider {
  async list(): Promise<DeviceInfo[]> {
    // ラベルを得るには一度 getUserMedia の許可が要る。許可後すぐ停止する。
    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: true, video: true })
      .catch(() => undefined);
    const devices = await navigator.mediaDevices.enumerateDevices();
    stream?.getTracks().forEach((t) => t.stop());
    return devices
      .filter((d) => d.kind === "audioinput" || d.kind === "videoinput")
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `${d.kind} ${i + 1}`,
        kind: d.kind as StageDeviceKind,
      }));
  }

  async openCameraPreview(deviceId?: string): Promise<CameraPreview> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    return {
      stream,
      stop() {
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  }

  async openMicMeter(deviceId?: string): Promise<MicMeter> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    });
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buffer = new Uint8Array(analyser.frequencyBinCount);
    return {
      level() {
        analyser.getByteTimeDomainData(buffer);
        let peak = 0;
        for (const v of buffer) peak = Math.max(peak, Math.abs(v - 128) / 128);
        return peak;
      },
      stop() {
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
      },
    };
  }
}
