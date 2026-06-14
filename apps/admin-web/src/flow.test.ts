/**
 * フェーズ6 受け入れ基準のフロー検証:
 * イベント作成 → 素材(QR)を S3 相当へアップロード → 設定保存 → 配信開始(live) で反映。
 * バックエンドは control-api の実ロジックをインメモリで動かす。
 */
import { describe, expect, it } from 'vitest';
import { LocalControlApiClient } from './api/local-client.js';
import { InMemoryAssetService } from './api/asset-service.js';
import { defaultFormValues, toCreateEventInput } from './lib/event-form.js';

describe('admin console end-to-end flow (DESIGN.md 8 章, 7.1)', () => {
  it('creates an event, uploads a QR asset, saves it, and goes live', async () => {
    const client = new LocalControlApiClient();
    const assets = new InMemoryAssetService();

    // 1) イベント作成
    const input = toCreateEventInput({
      ...defaultFormValues(),
      title: 'Tech Conf 2026',
      startsAt: '2026-07-01T09:00',
      customApiEnabled: true,
    });
    const created = await client.createEvent(input);
    expect(created.status).toBe('draft');
    expect(created.caption.customApiEnabled).toBe(true);

    // 2) QR 素材をアップロード (S3 相当)
    const ref = await assets.upload(created.id, {
      name: 'qr.png',
      contentType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(ref.key).toBe(`assets/${created.id}/qr.png`);

    // 3) 設定保存 (イベントに QR を紐づけ)
    const withQr = await client.updateEvent(created.id, { qrAsset: ref });
    expect(withQr.qrAsset?.key).toBe(ref.key);

    // 4) 招待 URL 発行 (登壇者)
    const invite = await client.issueInvite(created.id, 'speaker', 3600);
    expect(invite.url).toContain('token=');

    // 5) 配信開始 → live に反映
    const live = await client.setStatus(created.id, 'live');
    expect(live.status).toBe('live');

    // 一覧にも反映
    const list = await client.listEvents();
    expect(list.find((e) => e.id === created.id)?.status).toBe('live');
  });
});
