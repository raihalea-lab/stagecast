import { describe, expect, it } from 'vitest';
import {
  CognitoJwtAdminAuthVerifier,
  FakeAdminAuthVerifier,
  UnauthorizedError,
} from './admin-auth.js';

describe('FakeAdminAuthVerifier', () => {
  it('accepts the fake bearer format and rejects others', async () => {
    const v = new FakeAdminAuthVerifier();
    expect(await v.verify('Bearer fake:u1:u1@x.com')).toEqual({ userId: 'u1', email: 'u1@x.com' });
    await expect(v.verify(undefined)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(v.verify('Bearer real-jwt')).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe('CognitoJwtAdminAuthVerifier', () => {
  it('maps verified claims to an admin principal', async () => {
    const v = new CognitoJwtAdminAuthVerifier(async (token) => {
      expect(token).toBe('good');
      return { sub: 'cognito-sub', email: 'admin@x.com' };
    });
    expect(await v.verify('Bearer good')).toEqual({ userId: 'cognito-sub', email: 'admin@x.com' });
  });

  it('rejects when the JWT verifier throws', async () => {
    const v = new CognitoJwtAdminAuthVerifier(async () => {
      throw new Error('expired');
    });
    await expect(v.verify('Bearer bad')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a missing token without calling the verifier', async () => {
    let called = false;
    const v = new CognitoJwtAdminAuthVerifier(async () => {
      called = true;
      return { sub: 'x' };
    });
    await expect(v.verify(undefined)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(called).toBe(false);
  });
});
