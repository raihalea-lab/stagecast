/**
 * 字幕パイプラインの実 AWS 疎通テスト (T8)。RUN_INTEGRATION=1 で実行。
 *
 * 必要な環境変数:
 *   AWS_REGION              (例: us-east-1)
 *   CAPTIONS_BUCKET_NAME    (T5/T7 で作成済みの S3 バケット名)
 *   BEDROCK_MODEL_ID        (例: us.anthropic.claude-sonnet-4-5-20250929-v1:0)
 *
 * 実行: RUN_INTEGRATION=1 pnpm --filter @stagecast/caption-pipeline test
 */
import { describe, expect, it } from "vitest";

const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("caption-pipeline 実 AWS 疎通 (T8)", () => {
  it("Amazon Translate: 1 文の翻訳が往復する", async () => {
    const { AmazonTranslateTranslator } = await import("./aws/translate-adapter.js");
    const tr = new AmazonTranslateTranslator();
    const out = await tr.translate("こんにちは", "ja", "en");
    expect(out.length).toBeGreaterThan(0);
  });

  it("Bedrock: モデル呼び出しが応答する", async () => {
    const { BedrockLlmAdapter } = await import("./aws/bedrock-adapter.js");
    const llm = new BedrockLlmAdapter({
      modelId: process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    });
    // 最小: 翻訳のみモード。実 API 呼び出しでエラーが出ないことを確認。
    const result = await llm.translate("Hello", "en", "ja");
    expect(result.length).toBeGreaterThan(0);
  });

  it("S3 ObjectStorage: put / get が往復する", async () => {
    const { S3ObjectStorage } = await import("./aws/s3-storage.js");
    const bucket = process.env.CAPTIONS_BUCKET_NAME!;
    const storage = new S3ObjectStorage(bucket);
    const key = `integration-test/${Date.now()}.txt`;
    await storage.put(key, "test caption", "text/plain");
    // 直接 GetObject で読み直して確認。
    const { S3Client, GetObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({});
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    expect(await got.Body!.transformToString()).toBe("test caption");
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  });

  it("HttpYouTubeCaptionPublisher: ダミーエンドポイントへ送出形式が組み立てられる", async () => {
    // 本番 YouTube への送出は副作用が強いのでスキップ可能化。
    // YOUTUBE_INGESTION_URL を 200 を返す httpbin 等にセットして実行する。
    const url = process.env.YOUTUBE_INGESTION_URL;
    if (!url) return;
    const { HttpYouTubeCaptionPublisher } = await import("./sinks/youtube-publisher.js");
    const pub = new HttpYouTubeCaptionPublisher({ ingestionUrl: url, baseEpochMs: Date.now() });
    await pub.publish({
      startMs: 0,
      endMs: 1000,
      language: "ja",
      text: "テスト",
      status: "final",
    });
  });
});
