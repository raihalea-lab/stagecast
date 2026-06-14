/**
 * 実 LiveKit 音声ソース (T1, DESIGN.md 6 章, 3.4 (4))。
 *
 * SFU(LiveKit) の登壇者音声トラックを購読し、PCM 16k mono にリサンプルして
 * 字幕パイプラインの `AudioSource` インターフェースに流す。
 *
 * LiveKit SDK には直接依存せず、最小操作を `LiveKitTrackSubscriber` として抽象化する。
 * 本番では `livekit-rtc-node` (または egress 経由) を渡し、テストでは fake を渡して
 * 外部接続なしに pipeline を検証する。
 */
import type { AudioChunk } from "@stagecast/shared";
import type { AudioSource } from "./bootstrap.js";

/** SFU 上の音声フレーム (LiveKit RTC が吐く生 PCM チャンク)。 */
export interface RawAudioFrame {
  /** PCM サンプル (Int16 リトルエンディアン or Float32)。 */
  pcm: Int16Array | Float32Array;
  /** サンプリングレート (Hz)。LiveKit はおおむね 48000 が多い。 */
  sampleRate: number;
  /** チャンネル数 (1=mono, 2=stereo)。 */
  channels: number;
  /** メディアタイムライン基準のフレーム開始時刻 (ミリ秒)。 */
  timestampMs: number;
  /** 話者識別子 (LiveKit identity)。 */
  speakerId?: string;
}

/** LiveKit RTC からの音声購読を抽象化する。 */
export interface LiveKitTrackSubscriber {
  /**
   * 接続して音声トラックの購読を開始する。`onFrame` には到着順にフレームを渡す。
   * ストップは返却値の関数を呼ぶ。
   */
  subscribe(
    config: { url: string; token: string; room: string },
    onFrame: (frame: RawAudioFrame) => void,
  ): Promise<() => Promise<void>>;
}

export interface LiveKitAudioSourceConfig {
  /** LiveKit サーバ URL (例: wss://lk.example) */
  url: string;
  /** 入室済み identity の access token (server-sdk で発行) */
  token: string;
  /** 入室するルーム名 (= eventId に対応) */
  room: string;
  /** 字幕パイプラインに渡す出力サンプリングレート (既定 16000 Hz)。 */
  targetSampleRate?: number;
}

const DEFAULT_TARGET_SR = 16000;

/**
 * `AudioSource` の LiveKit 実装。SDK は注入されるため SDK 非依存のテストが可能。
 */
export class LiveKitAudioSource implements AudioSource {
  private stopFn: (() => Promise<void>) | undefined;

  constructor(
    private readonly config: LiveKitAudioSourceConfig,
    private readonly subscriber: LiveKitTrackSubscriber,
  ) {}

  async start(onChunk: (chunk: AudioChunk) => Promise<void> | void): Promise<void> {
    const targetSr = this.config.targetSampleRate ?? DEFAULT_TARGET_SR;
    this.stopFn = await this.subscriber.subscribe(
      { url: this.config.url, token: this.config.token, room: this.config.room },
      (frame) => {
        const mono = toMono(frame);
        const resampled = resampleLinearInt16(mono, frame.sampleRate, targetSr);
        const chunk: AudioChunk = {
          data: new Uint8Array(resampled.buffer, resampled.byteOffset, resampled.byteLength),
          timestampMs: frame.timestampMs,
          sampleRate: targetSr,
          ...(frame.speakerId !== undefined ? { speakerId: frame.speakerId } : {}),
        };
        // pipeline 側のエラーは握り、配信全体を止めない (字幕は best-effort)。
        void Promise.resolve(onChunk(chunk)).catch((err) => {
          console.error("LiveKitAudioSource: pushAudio failed", err);
        });
      },
    );
  }

  async stop(): Promise<void> {
    if (this.stopFn) {
      await this.stopFn();
      this.stopFn = undefined;
    }
  }
}

/**
 * フレームを mono Float32 にまとめる (LiveKit が stereo Int16 のことが多いため)。
 * 既に mono ならそのまま Float32 に正規化して返す。
 */
function toMono(frame: RawAudioFrame): Float32Array {
  const { pcm, channels } = frame;
  const len = Math.floor(pcm.length / channels);
  const out = new Float32Array(len);
  if (pcm instanceof Int16Array) {
    for (let i = 0; i < len; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += pcm[i * channels + c]! / 0x8000;
      out[i] = sum / channels;
    }
  } else {
    for (let i = 0; i < len; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += pcm[i * channels + c]!;
      out[i] = sum / channels;
    }
  }
  return out;
}

/**
 * 線形補間リサンプラ (Float32 → Int16 PCM)。
 *
 * 字幕用途では十分な品質で、Transcribe Streaming への入力 (16k Int16 mono) に合う。
 * 高品質が必要ならポリフェーズフィルタへ差し替え可能。
 */
export function resampleLinearInt16(src: Float32Array, srcSr: number, dstSr: number): Int16Array {
  if (srcSr === dstSr) {
    const out = new Int16Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = floatToInt16(src[i]!);
    return out;
  }
  const ratio = srcSr / dstSr;
  const dstLen = Math.floor(src.length / ratio);
  const out = new Int16Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    const t = i * ratio;
    const i0 = Math.floor(t);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const frac = t - i0;
    const v = src[i0]! * (1 - frac) + src[i1]! * frac;
    out[i] = floatToInt16(v);
  }
  return out;
}

function floatToInt16(v: number): number {
  const clamped = Math.max(-1, Math.min(1, v));
  return Math.round(clamped * 0x7fff);
}

/**
 * 環境変数から LiveKit 音声ソースを構築する (字幕ワーカーの bootstrap 用)。
 * subscriber は遅延ロード (実 SDK のインポートはここで初めて発生する)。
 */
export async function liveKitAudioSourceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LiveKitAudioSource | undefined> {
  const url = env.LIVEKIT_URL;
  const token = env.LIVEKIT_INGEST_TOKEN ?? env.LIVEKIT_API_KEY; // 認証情報が無ければ未構築。
  const room = env.LIVEKIT_ROOM ?? env.STAGECAST_EVENT_ID;
  if (!url || !token || !room) return undefined;
  const subscriber = await loadDefaultSubscriber();
  return new LiveKitAudioSource(
    {
      url,
      token,
      room,
      ...(env.CAPTION_TARGET_SR ? { targetSampleRate: Number(env.CAPTION_TARGET_SR) } : {}),
    },
    subscriber,
  );
}

/**
 * livekit-rtc-node を遅延 import で読み込み、`LiveKitTrackSubscriber` 互換のラッパを返す。
 *
 * `@livekit/rtc-node` はネイティブ依存があるオプショナルパッケージなので、本ファイルは
 * コンパイル時には型依存しない (string indirection で TS の解決を回避)。
 * SDK が無い環境 (テスト/ローカルで未インストール) では実行時に throw する。
 */
async function loadDefaultSubscriber(): Promise<LiveKitTrackSubscriber> {
  // string 変数経由にすることで bundler/TS が解決を試みない (実行時にのみ解決)。
  const pkgName = "@livekit/rtc-node";
  const mod = (await import(/* @vite-ignore */ pkgName)) as unknown as {
    Room: new () => {
      connect: (url: string, token: string) => Promise<void>;
      disconnect: () => Promise<void>;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  };
  return {
    async subscribe(config, onFrame) {
      const room = new mod.Room();
      room.on("trackSubscribed", (track: unknown, _publication: unknown, participant: unknown) => {
        const anyTrack = track as {
          kind?: string;
          source?: string;
          on?: (e: string, cb: (frame: unknown) => void) => void;
        };
        if (anyTrack.kind !== "audio") return;
        const identity = (participant as { identity?: string } | undefined)?.identity;
        anyTrack.on?.("frame", (raw: unknown) => {
          const r = raw as {
            data: Int16Array | Float32Array;
            sampleRate: number;
            channels: number;
            timestampUs?: bigint;
          };
          onFrame({
            pcm: r.data,
            sampleRate: r.sampleRate,
            channels: r.channels,
            timestampMs: r.timestampUs ? Number(r.timestampUs / 1000n) : Date.now(),
            ...(identity ? { speakerId: identity } : {}),
          });
        });
      });
      await room.connect(config.url, config.token);
      return async () => {
        await room.disconnect();
      };
    },
  };
}
