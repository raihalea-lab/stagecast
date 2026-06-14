import { describe, expect, it } from "vitest";
import type { AudioChunk } from "@stagecast/shared";
import {
  LiveKitAudioSource,
  resampleLinearInt16,
  type LiveKitTrackSubscriber,
  type RawAudioFrame,
} from "./livekit-audio-source.js";

class FakeSubscriber implements LiveKitTrackSubscriber {
  readonly connections: Array<{ url: string; token: string; room: string }> = [];
  emit?: (frame: RawAudioFrame) => void;
  stopped = false;
  async subscribe(
    config: { url: string; token: string; room: string },
    onFrame: (f: RawAudioFrame) => void,
  ): Promise<() => Promise<void>> {
    this.connections.push(config);
    this.emit = onFrame;
    return async () => {
      this.stopped = true;
    };
  }
}

describe("resampleLinearInt16 (T1)", () => {
  it("同一サンプルレートは Float→Int16 変換のみ", () => {
    const src = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const out = resampleLinearInt16(src, 48000, 48000);
    expect(out.length).toBe(5);
    expect(out[0]).toBe(0);
    expect(out[3]).toBe(0x7fff);
    expect(out[4]).toBe(-0x7fff);
  });

  it("48k → 16k で長さが約 1/3 になる (線形補間)", () => {
    const src = new Float32Array(48); // 1ms 相当
    for (let i = 0; i < 48; i++) src[i] = i / 48;
    const out = resampleLinearInt16(src, 48000, 16000);
    expect(out.length).toBe(16); // 48 / 3
  });
});

describe("LiveKitAudioSource (T1)", () => {
  it("フレームを mono 16k PCM にして onChunk へ流す", async () => {
    const sub = new FakeSubscriber();
    const src = new LiveKitAudioSource(
      { url: "wss://lk", token: "t", room: "r", targetSampleRate: 16000 },
      sub,
    );
    const chunks: AudioChunk[] = [];
    await src.start((c) => {
      chunks.push(c);
    });
    expect(sub.connections).toEqual([{ url: "wss://lk", token: "t", room: "r" }]);

    // 48k stereo Int16 フレームを送る (1サンプル = LR ペア)。
    const pcm = new Int16Array([0x4000, 0x4000, -0x4000, -0x4000]);
    sub.emit!({ pcm, sampleRate: 48000, channels: 2, timestampMs: 100, speakerId: "spk-1" });
    // pushAudio は同期で呼ばれる (キューに enqueue するだけ)。
    await new Promise((r) => setTimeout(r, 0));
    expect(chunks).toHaveLength(1);
    const chunk = chunks[0]!;
    expect(chunk.sampleRate).toBe(16000);
    expect(chunk.speakerId).toBe("spk-1");
    expect(chunk.timestampMs).toBe(100);
    expect(chunk.data.byteLength % 2).toBe(0); // Int16 列なので偶数バイト
  });

  it("stop で subscriber も停止する", async () => {
    const sub = new FakeSubscriber();
    const src = new LiveKitAudioSource({ url: "wss://lk", token: "t", room: "r" }, sub);
    await src.start(() => {});
    await src.stop();
    expect(sub.stopped).toBe(true);
  });

  it("onChunk の例外で全体を止めない (best-effort, N-2)", async () => {
    const sub = new FakeSubscriber();
    const src = new LiveKitAudioSource({ url: "wss://lk", token: "t", room: "r" }, sub);
    await src.start(async () => {
      throw new Error("downstream boom");
    });
    expect(() =>
      sub.emit!({
        pcm: new Int16Array([0, 0]),
        sampleRate: 16000,
        channels: 1,
        timestampMs: 0,
      }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
