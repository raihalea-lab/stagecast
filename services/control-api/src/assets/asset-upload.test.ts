import { describe, expect, it, beforeEach } from 'vitest';
import { buildControlApi } from '../factory.js';
import { createAssetUploadService, type AssetUploadSigner } from './asset-upload.js';
import type { App, HttpRequest } from '../http/app.js';

const adminAuth = { authorization: 'Bearer fake:admin-1:admin@example.com' };
const req = (p: Partial<HttpRequest> & Pick<HttpRequest, 'method' | 'path'>): HttpRequest => ({
  headers: {},
  ...p,
});

class FakeSigner implements AssetUploadSigner {
  async presignPut(key: string, contentType: string): Promise<string> {
    return `https://s3.test/${key}?ct=${encodeURIComponent(contentType)}&sig=abc`;
  }
}

describe('asset upload service', () => {
  it('namespaces the key under the event and sanitizes the filename', async () => {
    let n = 0;
    const svc = createAssetUploadService({ signer: new FakeSigner(), newId: () => `id-${++n}` });
    const out = await svc.createUploadUrl('evt-1', 'my slides (v2).pdf', 'application/pdf');
    expect(out.key).toBe('assets/evt-1/id-1-my_slides__v2_.pdf');
    expect(out.uploadUrl).toContain('assets/evt-1/id-1-my_slides__v2_.pdf');
  });
});

describe('POST /events/{id}/assets/upload-url', () => {
  let app: App;
  beforeEach(() => {
    app = buildControlApi({ inviteSecret: 's', assetSigner: new FakeSigner(), newId: () => 'fix' });
  });

  it('returns a presigned upload URL for admins', async () => {
    const res = await app.handle(
      req({
        method: 'POST',
        path: '/events/evt-1/assets/upload-url',
        headers: adminAuth,
        body: { filename: 'qr.png', contentType: 'image/png' },
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ key: 'assets/evt-1/fix-qr.png' });
  });

  it('requires admin auth', async () => {
    const res = await app.handle(
      req({ method: 'POST', path: '/events/evt-1/assets/upload-url', body: {} }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 503 when no signer is configured', async () => {
    const noAssets = buildControlApi({ inviteSecret: 's' });
    const res = await noAssets.handle(
      req({
        method: 'POST',
        path: '/events/evt-1/assets/upload-url',
        headers: adminAuth,
        body: { filename: 'x', contentType: 'text/plain' },
      }),
    );
    expect(res.status).toBe(503);
  });
});
