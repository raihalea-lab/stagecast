import { describe, expect, it } from "vitest";
import {
  FakeMediaDevicesProvider,
  loadPreferredDevices,
  resolveSelected,
  savePreferredDevices,
  smoothLevel,
  splitDevices,
  type DeviceInfo,
  type KeyValueStore,
} from "./devices.js";

const devices: DeviceInfo[] = [
  { deviceId: "mic-1", label: "内蔵マイク", kind: "audioinput" },
  { deviceId: "mic-2", label: "USB マイク", kind: "audioinput" },
  { deviceId: "cam-1", label: "FaceTime", kind: "videoinput" },
];

class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

describe("splitDevices (N7)", () => {
  it("マイクとカメラに分ける", () => {
    const { microphones, cameras } = splitDevices(devices);
    expect(microphones.map((d) => d.deviceId)).toEqual(["mic-1", "mic-2"]);
    expect(cameras.map((d) => d.deviceId)).toEqual(["cam-1"]);
  });
});

describe("resolveSelected (N7)", () => {
  it("保存済み ID が一覧にあればそれを選ぶ", () => {
    expect(resolveSelected(devices, "mic-2")).toBe("mic-2");
  });
  it("保存済みが無効/未指定なら先頭にフォールバック", () => {
    expect(resolveSelected(devices, "missing")).toBe("mic-1");
    expect(resolveSelected(devices)).toBe("mic-1");
  });
  it("デバイスが空なら undefined", () => {
    expect(resolveSelected([], "x")).toBeUndefined();
  });
});

describe("smoothLevel (N7)", () => {
  it("EMA で平滑化し 0..1 にクランプする", () => {
    expect(smoothLevel(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(smoothLevel(0.5, 0.5, 0.5)).toBeCloseTo(0.5);
    // 範囲外サンプルはクランプ。
    expect(smoothLevel(0, 5, 1)).toBe(1);
    expect(smoothLevel(0.2, -5, 1)).toBe(0);
  });
});

describe("preferred device persistence (N7)", () => {
  it("保存して読み戻せる", () => {
    const store = new MemoryStore();
    savePreferredDevices(store, { microphoneId: "mic-2", cameraId: "cam-1" });
    expect(loadPreferredDevices(store)).toEqual({ microphoneId: "mic-2", cameraId: "cam-1" });
  });
  it("未保存なら空オブジェクト", () => {
    expect(loadPreferredDevices(new MemoryStore())).toEqual({});
  });
  it("壊れた JSON は空として扱う", () => {
    const store = new MemoryStore();
    store.setItem("stagecast.devicePrefs", "{not json");
    expect(loadPreferredDevices(store)).toEqual({});
  });
});

describe("FakeMediaDevicesProvider (N7)", () => {
  it("一覧を返し、メーターは擬似レベルを巡回し stop を数える", async () => {
    const provider = new FakeMediaDevicesProvider(devices, [0.2, 0.8]);
    expect((await provider.list()).length).toBe(3);
    const meter = await provider.openMicMeter("mic-1");
    expect(meter.level()).toBe(0.2);
    expect(meter.level()).toBe(0.8);
    expect(meter.level()).toBe(0.2);
    meter.stop();
    expect(provider.stopped).toBe(1);
  });
});
