/**
 * 実 AWS との疎通確認テスト (T8)。RUN_INTEGRATION=1 のときのみ実行する。
 * 通常の `vp test` ではスキップされる (外部接続なしの方針, DESIGN.md / PROMPT 共通ルール)。
 *
 * 必要な環境変数:
 *   AWS_REGION                 (例: ap-northeast-1)
 *   METADATA_TABLE_NAME        (T5 でデプロイ済みのテーブル名)
 *   ASSETS_BUCKET_NAME         (T5 でデプロイ済みのバケット名)
 *   COGNITO_USER_POOL_ID       (T5 でデプロイ済みの User Pool)
 *   COGNITO_USER_POOL_CLIENT_ID
 *   COGNITO_ID_TOKEN           (検証する有効な ID トークン。手動で発行)
 *
 * 実行: RUN_INTEGRATION=1 pnpm --filter @stagecast/control-api test
 */
import { describe, expect, it } from "vitest";

const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("control-api 実 AWS 疎通 (T8)", () => {
  it("DynamoDB へ put / get できる", async () => {
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient, PutCommand, GetCommand, DeleteCommand } =
      await import("@aws-sdk/lib-dynamodb");
    const table = process.env.METADATA_TABLE_NAME!;
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const pk = `integration-test#${Date.now()}`;
    await client.send(new PutCommand({ TableName: table, Item: { pk, sk: "ping", v: 1 } }));
    const got = await client.send(new GetCommand({ TableName: table, Key: { pk, sk: "ping" } }));
    expect(got.Item?.v).toBe(1);
    await client.send(new DeleteCommand({ TableName: table, Key: { pk, sk: "ping" } }));
  });

  it("S3 へ put / get / delete できる", async () => {
    const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } =
      await import("@aws-sdk/client-s3");
    const Bucket = process.env.ASSETS_BUCKET_NAME!;
    const Key = `integration-test/${Date.now()}.txt`;
    const s3 = new S3Client({});
    await s3.send(new PutObjectCommand({ Bucket, Key, Body: "hello" }));
    const got = await s3.send(new GetObjectCommand({ Bucket, Key }));
    const text = await got.Body!.transformToString();
    expect(text).toBe("hello");
    await s3.send(new DeleteObjectCommand({ Bucket, Key }));
  });

  it("CognitoJwtAdminAuthVerifier が有効な ID トークンを検証できる", async () => {
    const token = process.env.COGNITO_ID_TOKEN;
    if (!token) {
      // 手動で取得した token が無いときはスキップ (前提条件不足)。
      return;
    }
    const { cognitoAdminAuthVerifier } = await import("./auth/admin-auth.js");
    const verifier = cognitoAdminAuthVerifier({
      userPoolId: process.env.COGNITO_USER_POOL_ID!,
      clientId: process.env.COGNITO_USER_POOL_CLIENT_ID!,
    });
    const principal = await verifier.verify(`Bearer ${token}`);
    expect(principal.userId).toBeTruthy();
  });
});
