import { describe, expect, it } from 'vitest';
import type { CaptionEvent } from '@stagecast/shared';
import { ValkeyStreamsCaptionBus, type CaptionStreamClient } from './valkey-bus.js';

/**
 * フェイク Streams クライアント。xadd で配列に積み、read は追記を購読者へ流す。
 * 単一プロセス内で publish→subscribe の往復を決定的に検証する。
 */
class FakeStreamClient implements CaptionStreamClient {
  readonly streams = new Map<string, { id: string; payload: string }[]>();
  private waiters = new Map<string, (() => void)[]>();
  private seq = 0;

  async xadd(stream: string, payload: string): Promise<string> {
    const id = `${++this.seq}-0`;
    const list = this.streams.get(stream) ?? [];
    list.push({ id, payload });
    this.streams.set(stream, list);
    for (const wake of this.waiters.get(stream) ?? []) wake();
    this.waiters.set(stream, []);
    return id;
  }

  async *read(
    stream: string,
    _lastId: string,
    signal: { aborted: boolean },
  ): AsyncIterable<{ id: string; payload: string }> {
    let cursor = this.streams.get(stream)?.length ?? 0; // '$' 相当: 接続以降
    while (!signal.aborted) {
      const list = this.streams.get(stream) ?? [];
      if (cursor < list.length) {
        yield list[cursor]!;
        cursor += 1;
      } else {
        await new Promise<void>((resolve) => {
          const waiters = this.waiters.get(stream) ?? [];
          waiters.push(resolve);
          this.waiters.set(stream, waiters);
          // abort されたら起こす
          const check = setInterval(() => {
            if (signal.aborted) {
              clearInterval(check);
              resolve();
            }
          }, 1);
        });
      }
    }
  }
}

function caption(text: string, language: 'ja' | 'en' = 'ja'): CaptionEvent {
  return { startMs: 0, endMs: 1000, language, text, status: 'final' };
}

describe('ValkeyStreamsCaptionBus (ADR 0002)', () => {
  it('namespaces the stream per event', async () => {
    const client = new FakeStreamClient();
    const bus = new ValkeyStreamsCaptionBus({ eventId: 'evt-a', client });
    bus.publish(caption('x'));
    await Promise.resolve();
    expect([...client.streams.keys()]).toContain('stagecast:evt-a:captions');
  });

  it('delivers published captions to a subscriber', async () => {
    const client = new FakeStreamClient();
    const bus = new ValkeyStreamsCaptionBus({ eventId: 'evt-a', client });
    const received: CaptionEvent[] = [];
    const off = bus.subscribe((c) => received.push(c));
    // 購読ループが先頭カーソルを取るのを待ってから publish
    await Promise.resolve();

    bus.publish(caption('こんにちは'));
    await waitFor(() => received.length === 1);
    expect(received[0]?.text).toBe('こんにちは');
    off();
  });

  it('does not deliver to a different event stream (isolation, N-5)', async () => {
    const client = new FakeStreamClient();
    const busA = new ValkeyStreamsCaptionBus({ eventId: 'evt-a', client });
    const busB = new ValkeyStreamsCaptionBus({ eventId: 'evt-b', client });
    const a: CaptionEvent[] = [];
    busA.subscribe((c) => a.push(c));
    await Promise.resolve();

    busB.publish(caption('only-b'));
    await delay(10);
    expect(a).toHaveLength(0);
  });

  it('ignores malformed/invalid payloads without throwing', async () => {
    const client = new FakeStreamClient();
    const bus = new ValkeyStreamsCaptionBus({ eventId: 'evt-a', client });
    const received: CaptionEvent[] = [];
    bus.subscribe((c) => received.push(c));
    await Promise.resolve();

    await client.xadd('stagecast:evt-a:captions', 'not json');
    await client.xadd('stagecast:evt-a:captions', JSON.stringify({ bogus: true }));
    bus.publish(caption('valid'));
    await waitFor(() => received.length === 1);
    expect(received.map((c) => c.text)).toEqual(['valid']);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await delay(2);
  }
}
