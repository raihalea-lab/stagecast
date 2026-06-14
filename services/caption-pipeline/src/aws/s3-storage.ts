/**
 * S3 実装の ObjectStorage (DESIGN.md 6.4, N-4)。
 *
 * 確定字幕 (SRT/VTT) を S3 に保存する。AWS SDK v3 の S3Client を注入する。
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { ObjectStorage } from '../store/caption-store.js';

export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client = new S3Client({}),
  ) {}

  async put(key: string, body: string, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<string | undefined> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) return undefined;
    // SDK v3 のストリームは transformToString を備える。
    return res.Body.transformToString();
  }
}
