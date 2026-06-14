/**
 * Amazon Transcribe Streaming 実装の AsrAdapter (DESIGN.md 6.2 常用・低遅延経路, N-2)。
 *
 * push 型の AsrAdapter (pushAudio + onTranscript) を、AWS SDK の pull 型ストリーミング
 * (AudioStream を流し TranscriptResultStream を受ける) に橋渡しする。内部キューで
 * 音声チャンクをストリームへ供給する。結果のマッピングは純粋関数に切り出してテストする。
 *
 * ストリーミングループ自体は実 AWS 接続のため統合時に検証する。
 */
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  type TranscriptEvent,
} from '@aws-sdk/client-transcribe-streaming';
import type { AudioChunk, LanguageCode } from '@stagecast/shared';
import type { AsrAdapter, TranscriptSegment } from '../engines/types.js';

/** 内部言語コード → Transcribe の BCP-47 言語コード。 */
const TRANSCRIBE_LANGUAGE: Record<LanguageCode, string> = { ja: 'ja-JP', en: 'en-US' };

/** TranscriptEvent → 字幕セグメント列への純粋変換 (テスト対象)。 */
export function mapTranscriptEvent(
  event: TranscriptEvent,
  speakerId?: string,
): TranscriptSegment[] {
  const results = event.Transcript?.Results ?? [];
  const segments: TranscriptSegment[] = [];
  for (const r of results) {
    const text = r.Alternatives?.[0]?.Transcript;
    if (!text) continue;
    segments.push({
      startMs: Math.round((r.StartTime ?? 0) * 1000),
      endMs: Math.round((r.EndTime ?? 0) * 1000),
      text,
      isFinal: r.IsPartial === false,
      speakerId,
    });
  }
  return segments;
}

/** 非同期キュー: pushAudio で積み、ストリーム側が逐次取り出す。 */
class AudioQueue {
  private queue: AudioChunk[] = [];
  private resolvers: ((chunk: AudioChunk | null) => void)[] = [];
  private closed = false;

  push(chunk: AudioChunk): void {
    const resolve = this.resolvers.shift();
    if (resolve) resolve(chunk);
    else this.queue.push(chunk);
  }
  close(): void {
    this.closed = true;
    for (const resolve of this.resolvers.splice(0)) resolve(null);
  }
  private next(): Promise<AudioChunk | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() ?? null);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<AudioChunk> {
    for (;;) {
      const chunk = await this.next();
      if (chunk === null) return;
      yield chunk;
    }
  }
}

export class TranscribeStreamingAsrAdapter implements AsrAdapter {
  private handler?: (segment: TranscriptSegment) => void;
  private readonly audio = new AudioQueue();
  private started = false;

  constructor(
    readonly language: LanguageCode,
    private readonly client: TranscribeStreamingClient = new TranscribeStreamingClient({}),
    private readonly sampleRate = 16000,
  ) {}

  onTranscript(handler: (segment: TranscriptSegment) => void): void {
    this.handler = handler;
  }

  private async run(): Promise<void> {
    const audio = this.audio;
    const command = new StartStreamTranscriptionCommand({
      LanguageCode: TRANSCRIBE_LANGUAGE[this.language] as never,
      MediaSampleRateHertz: this.sampleRate,
      MediaEncoding: 'pcm',
      AudioStream: (async function* () {
        for await (const chunk of audio) {
          yield { AudioEvent: { AudioChunk: chunk.data } };
        }
      })(),
    });
    const response = await this.client.send(command);
    for await (const evt of response.TranscriptResultStream ?? []) {
      if (!evt.TranscriptEvent) continue;
      for (const segment of mapTranscriptEvent(evt.TranscriptEvent)) {
        this.handler?.(segment);
      }
    }
  }

  async pushAudio(chunk: AudioChunk): Promise<void> {
    if (!this.started) {
      this.started = true;
      // ストリーム消費はバックグラウンドで回す (結果は onTranscript に届く)。
      void this.run();
    }
    this.audio.push(chunk);
  }

  async close(): Promise<void> {
    this.audio.close();
  }
}
