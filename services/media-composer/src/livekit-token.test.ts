import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createLiveKitAccessToken, grantForRole } from './livekit-token.js';

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('livekit token', () => {
  it('grants publish to speakers but not to viewers (DESIGN.md 4 表)', () => {
    expect(grantForRole('speaker', 'room1').canPublish).toBe(true);
    expect(grantForRole('viewer', 'room1').canPublish).toBe(false);
  });

  it('produces a verifiable HS256 JWT with video grant', () => {
    const token = createLiveKitAccessToken({
      apiKey: 'devkey',
      apiSecret: 'devsecret',
      identity: 'spk-1',
      room: 'evt-a',
      role: 'speaker',
      issuedAtSec: 1000,
      ttlSec: 3600,
    });
    const [h, p, sig] = token.split('.');
    expect(decode(h!).alg).toBe('HS256');
    const payload = decode(p!);
    expect(payload.iss).toBe('devkey');
    expect(payload.sub).toBe('spk-1');
    expect((payload.video as { room: string }).room).toBe('evt-a');

    const expected = createHmac('sha256', 'devsecret').update(`${h}.${p}`).digest('base64url');
    expect(sig).toBe(expected);
  });

  it('throws without credentials (secrets must be injected, ADR D-10)', () => {
    expect(() =>
      createLiveKitAccessToken({
        apiKey: '',
        apiSecret: '',
        identity: 'x',
        room: 'r',
        role: 'admin',
        issuedAtSec: 0,
        ttlSec: 1,
      }),
    ).toThrow();
  });
});
