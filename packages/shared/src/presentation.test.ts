import { describe, expect, it } from 'vitest';
import { liveSpeakers, type PresentationState } from './presentation.js';

describe('presentation', () => {
  it('liveSpeakers returns only speakers marked live', () => {
    const state: PresentationState = {
      eventId: 'evt-1',
      speakers: [
        { speakerId: 'a', visibility: 'live', updatedAtMs: 1 },
        { speakerId: 'b', visibility: 'standby', updatedAtMs: 2 },
        { speakerId: 'c', visibility: 'live', updatedAtMs: 3 },
      ],
    };
    expect(liveSpeakers(state).map((s) => s.speakerId)).toEqual(['a', 'c']);
  });
});
