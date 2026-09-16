/** `_context.json` を S3 から読む (ADR 0021 D-6)。 */
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { MaterialsContextSource } from "../materials-context.js";

export class S3MaterialsContextSource implements MaterialsContextSource {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client = new S3Client({}),
  ) {}

  async head(key: string): Promise<string | undefined> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.ETag;
    } catch {
      // 資料が未登録なら 404。エラーではない。
      return undefined;
    }
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return await res.Body?.transformToString();
    } catch {
      return undefined;
    }
  }
}
