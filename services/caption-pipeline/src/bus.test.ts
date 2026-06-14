import { describe, expect, it } from 'vitest';
import type { CaptionEvent } from '@stagecast/shared';
import { InProcessCaptionBus } from './bus.js';

const sample: CaptionEvent = {
  startMs: 0,
  endMs: 1000,
  language: 'ja',
  text: 'こんにちは',
  status: 'final',
};

describe('InProcessCaptionBus', () => {
  it('delivers published captions to all subscribers', () => {
    const bus = new InProcessCaptionBus();
    const a: CaptionEvent[] = [];
    const b: CaptionEvent[] = [];
    bus.subscribe((c) => a.push(c));
    bus.subscribe((c) => b.push(c));
    bus.publish(sample);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new InProcessCaptionBus();
    const received: CaptionEvent[] = [];
    const off = bus.subscribe((c) => received.push(c));
    off();
    bus.publish(sample);
    expect(received).toHaveLength(0);
  });

  it('isolates a throwing subscriber from the others (fail-soft)', () => {
    const bus = new InProcessCaptionBus();
    const received: CaptionEvent[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((c) => received.push(c));
    expect(() => bus.publish(sample)).not.toThrow();
    expect(received).toHaveLength(1);
  });
});
