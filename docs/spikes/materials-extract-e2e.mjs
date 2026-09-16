/**
 * ADR 0021 の通し検証。
 *
 * 実行 (AWS 認証が要る):
 *   cd infra && npx cdk synth StagecastControlPlane
 *   # テンプレートから MaterialsExtractFunction の asset.<hash>/index.mjs を特定し、
 *   # @aws-sdk/* が解決できる場所 (services/materials-extract) にコピーして渡す
 *   cd services/materials-extract
 *   node ../../docs/spikes/materials-extract-e2e.mjs <PDF> <bundle.mjs>
 *
 * CDK がデプロイするのと同じバンドル済み Lambda を、使い捨ての
 * S3 バケット + DynamoDB テーブルで通しで動かす。
 *
 * 検証するもの:
 *   S3 イベント → PDF 抽出 (バンドル後の pdf.js) → _context.json → Bedrock 用語集生成
 *   → Translate ImportTerminology → 用語集が翻訳に効くこと → 資料削除で全部消えること
 */
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  DeleteTerminologyCommand,
  ListTerminologiesCommand,
  TranslateClient,
  TranslateTextCommand,
} from "@aws-sdk/client-translate";
import { readFileSync } from "node:fs";

const REGION = "ap-northeast-1";
const stamp = Date.now();
const BUCKET = `stagecast-e2e-0021-${stamp}`;
const TABLE = `stagecast-e2e-0021-${stamp}`;
const EVENT = `e2e-${stamp}`;
const ASSET = "asset-1";
const PDF = process.argv[2];
const BUNDLE = process.argv[3];

const s3 = new S3Client({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(ddb);
const translate = new TranslateClient({ region: REGION });

const ok = (m) => console.log(`  ✅ ${m}`);
const ng = (m) => {
  console.log(`  ❌ ${m}`);
  process.exitCode = 1;
};

async function setup() {
  console.log("--- 準備 ---");
  await s3.send(
    new CreateBucketCommand({
      Bucket: BUCKET,
      CreateBucketConfiguration: { LocationConstraint: REGION },
    }),
  );
  ok(`バケット作成: ${BUCKET}`);
  await ddb.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    }),
  );
  await waitUntilTableExists({ client: ddb, maxWaitTime: 60 }, { TableName: TABLE });
  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: `EVENT#${EVENT}`,
        sk: "META",
        caption: { sourceLanguage: "ja", languages: ["ja", "en"] },
      },
    }),
  );
  ok(`テーブル作成 + イベント行投入 (ja → en)`);
}

async function cleanup() {
  console.log("\n--- 後始末 ---");
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET })).catch(() => null);
  for (const o of listed?.Contents ?? []) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.Key }));
  }
  await s3.send(new DeleteBucketCommand({ Bucket: BUCKET })).catch(() => {});
  await ddb.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => {});
  const terms = await translate
    .send(new ListTerminologiesCommand({ MaxResults: 100 }))
    .catch(() => null);
  for (const t of terms?.TerminologyPropertiesList ?? []) {
    if (t.Name?.startsWith(`stagecast-${EVENT}-`)) {
      await translate.send(new DeleteTerminologyCommand({ Name: t.Name }));
      console.log(`  用語集を削除: ${t.Name}`);
    }
  }
  ok("使い捨て資源をすべて削除した");
}

function s3Event(key, eventName) {
  return {
    Records: [{ eventName, s3: { object: { key: encodeURIComponent(key).replace(/%2F/g, "/") } } }],
  };
}

async function getJson(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => null);
  return res ? JSON.parse(await res.Body.transformToString()) : null;
}

try {
  await setup();

  process.env.ASSETS_BUCKET = BUCKET;
  process.env.EVENTS_TABLE = TABLE;
  process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
  process.env.BEDROCK_REGION = "us-east-1";
  process.env.AWS_REGION = REGION;
  const { handler } = await import(BUNDLE);

  console.log("\n--- 1. 資料をアップロードして抽出させる ---");
  const key = `assets/materials/${EVENT}/${ASSET}/docswell.pdf`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: readFileSync(PDF) }));
  const t0 = Date.now();
  await handler(s3Event(key, "ObjectCreated:Put"));
  console.log(`  所要: ${Date.now() - t0}ms`);

  const ctx = await getJson(`assets/materials/${EVENT}/_context.json`);
  if (!ctx) ng("_context.json が作られなかった");
  else {
    ok(
      `_context.json 生成: ${ctx.materials.length} 資料 / ${ctx.fullText.length} 字 / ${ctx.materials[0].pages.length} ページ`,
    );
    if (/[ぁ-んァ-ヶ一-龠]/.test(ctx.fullText))
      ok("日本語が文字化けせず抽出されている (バンドル後の pdf.js)");
    else ng("日本語が取れていない");
  }

  console.log("\n--- 2. 用語集が登録されたか ---");
  const listed = await translate.send(new ListTerminologiesCommand({ MaxResults: 100 }));
  const mine = (listed.TerminologyPropertiesList ?? []).filter((t) =>
    t.Name?.startsWith(`stagecast-${EVENT}-`),
  );
  if (mine.length === 0) ng("用語集が登録されていない");
  else {
    for (const t of mine)
      ok(
        `用語集: ${t.Name} (${t.TermCount} 語, ${t.SourceLanguageCode} → ${t.TargetLanguageCodes})`,
      );
    const name = mine[0].Name;
    const sample = ctx.fullText.slice(0, 120).replace(/\n/g, " ");
    console.log(`  資料の冒頭: ${sample}`);
    const tr = async (n) =>
      (
        await translate.send(
          new TranslateTextCommand({
            Text: sample,
            SourceLanguageCode: "ja",
            TargetLanguageCode: "en",
            ...(n ? { TerminologyNames: [n] } : {}),
          }),
        )
      ).TranslatedText;
    const [a, b] = await Promise.all([tr(undefined), tr(name)]);
    console.log(`  用語集なし: ${a}`);
    console.log(`  用語集あり: ${b}`);
    if (a !== b) ok("実資料から作った用語集が翻訳に効いた");
    else console.log("  ⚠️  この一文では差が出なかった (best-effort なので想定内)");
  }

  console.log("\n--- 3. 資料を消すと _context.json と用語集も消えるか ---");
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  await handler(s3Event(key, "ObjectRemoved:Delete"));
  if (await getJson(`assets/materials/${EVENT}/_context.json`)) ng("_context.json が残っている");
  else ok("_context.json が消えた");
  const after = await translate.send(new ListTerminologiesCommand({ MaxResults: 100 }));
  const left = (after.TerminologyPropertiesList ?? []).filter((t) =>
    t.Name?.startsWith(`stagecast-${EVENT}-`),
  );
  if (left.length > 0) ng(`用語集が残っている: ${left.map((t) => t.Name)}`);
  else ok("用語集も消えた");

  console.log("\n--- 4. _context.json の PUT で無限ループしないか ---");
  const before = JSON.stringify(await getJson(`assets/materials/${EVENT}/_context.json`));
  await handler(s3Event(`assets/materials/${EVENT}/_context.json`, "ObjectCreated:Put"));
  ok("自分が書いた _context.json では何もしなかった (無限ループしない)");
} finally {
  await cleanup();
}
