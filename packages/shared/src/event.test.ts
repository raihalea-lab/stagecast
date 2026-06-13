import { describe, expect, it } from 'vitest';
import { isValidCaptionSettings, type CaptionSettings } from './event.js';

describe('event caption settings', () => {
  it('requires the YouTube language to be among supported languages', () => {
    const ok: CaptionSettings = {
      languages: ['ja', 'en'],
      youtubeLanguage: 'ja',
      engine: 'transcribe',
      customApiEnabled: false,
    };
    expect(isValidCaptionSettings(ok)).toBe(true);

    const bad: CaptionSettings = { ...ok, youtubeLanguage: 'en', languages: ['ja'] };
    expect(isValidCaptionSettings(bad)).toBe(false);

    const empty: CaptionSettings = { ...ok, languages: [] };
    expect(isValidCaptionSettings(empty)).toBe(false);
  });
});
