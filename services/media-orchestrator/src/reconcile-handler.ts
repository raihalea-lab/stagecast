/**
 * 調整ループの Lambda ハンドラ (T4, ADR 0003 D-2)。
 *
 * EventBridge スケジュールから 60 秒ごとに起動され、
 *   1. DynamoDB から live イベント集合を読む (desired)
 *   2. CloudFormation から `StagecastEventMedia-*` スタック集合を読む (actual)
 *   3. reconcile プランを計算し、provisioner で実行する
 * を 1 サイクルで行う。
 *
 * Lambda 内では実 AWS SDK を直接使うが、ロジックは純粋関数 + インターフェース注入で
 * 単体テスト可能にしている (reconcile.ts / fetchDesired / fetchActual)。
 */
import { createLogger } from "@stagecast/shared";
import type { ScheduledEvent, Context } from "aws-lambda";
import { eventMediaStackName, createAwsMediaStackProvisioner } from "./aws-cfn.js";

const log = createLogger({ component: "reconcile" });
import {
  enforceMaxParallel,
  executePlan,
  findStaleStacks,
  planReconcile,
  type ActualStack,
  type ActualStackKind,
  type DesiredEvent,
  type ReconcileExecutor,
} from "./reconcile.js";

/** これ以上残存したら「暴走の疑い」として警告するスタック寿命 (既定 24h, L3)。 */
const DEFAULT_STALE_STACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 並列イベント数の soft cap 既定値 (ADR 0008 D-6)。 */
const DEFAULT_MAX_PARALLEL_EVENTS = 10;

/** LiveKit Server (Fargate task) が listen するシグナリングポート。 */
const LIVEKIT_SIGNAL_PORT = 7880;

import {
  clusterName,
  eventServiceNames,
  readServiceStatuses,
  scaleUpServices,
  sfuServiceName,
  type EcsLike,
} from "./ecs-services.js";
import {
  createProvisioningPublisher,
  type ProvisioningInput,
  type ProvisioningStore,
} from "./provisioning.js";
import { createMediaPublisher, type MediaResolver, type MediaStore } from "./media-publisher.js";
import type { EventMediaInfo, EventProvisioningInfo } from "@stagecast/shared";
// 型だけの import なので実行時の読み込みは増えない。
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** 環境変数から共有 Cluster 名を読む (未設定なら per-event Cluster, ADR 0015 Phase 3)。 */
function sharedCluster(): string | undefined {
  return process.env.SHARED_CLUSTER_NAME;
}

/** 環境変数 → 結線。Lambda の cold start で 1 度だけ評価する。 */
interface HandlerDeps {
  fetchDesired: () => Promise<DesiredEvent[]>;
  fetchActual: () => Promise<ActualStack[]>;
  /** ADR 0021 D-3: 終了したイベントの翻訳用語集の棚卸し。 */
  terminologySweep: TerminologySweepDeps;
  executor: ReconcileExecutor;
  mediaPublisher: ReturnType<typeof createMediaPublisher>;
  /** ADR 0023 D-3: 起動進捗を events 行に書き戻す。 */
  provisioningPublisher: ReturnType<typeof createProvisioningPublisher>;
  /** ADR 0016 D-6 / ADR 0023 D-2: ECS サービスの観測とスケールアップ。 */
  ecs: EcsLike;
  maxParallel: number;
}

let cached: HandlerDeps | undefined;

async function deps(): Promise<HandlerDeps> {
  if (cached) return cached;
  const tableName = process.env.METADATA_TABLE_NAME;
  if (!tableName) throw new Error("METADATA_TABLE_NAME is required");
  // 遅延 import: テストや代替ハンドラから読まれても副作用を発生させない。
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } =
    await import("@aws-sdk/lib-dynamodb");
  const { CloudFormationClient, ListStacksCommand, DescribeStacksCommand } =
    await import("@aws-sdk/client-cloudformation");
  const { ECSClient, ListTasksCommand, DescribeTasksCommand } = await import("@aws-sdk/client-ecs");
  const { EC2Client, DescribeNetworkInterfacesCommand } = await import("@aws-sdk/client-ec2");
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const cfn = new CloudFormationClient({});
  const ecs = new ECSClient({});
  const ec2 = new EC2Client({});

  // ADR 0009 D-1: EventMediaStack の CfnOutput `LivekitDomainName` を優先して採用する。
  // 取得できなかった場合は ADR 0008 D-2 の Public IP 取得にフォールバック (後方互換)。
  const resolver: MediaResolver = {
    resolveLivekitUrl: async (eventId) => {
      // 1) CFN Output から per-event ドメイン名を取得 (ADR 0009)
      let livekitDomain: string | undefined;
      try {
        const stackName = eventMediaStackName(eventId);
        const stacks = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
        const outputs = stacks.Stacks?.[0]?.Outputs ?? [];
        livekitDomain = outputs.find(
          (o: { OutputKey?: string }) => o.OutputKey === "LivekitDomainName",
        )?.OutputValue;
      } catch {
        // スタック存在しない / Output 未定義 → Public IP fallback に進む。
      }

      // 2) ECS task の Public IP を解決する (ADR 0008 D-2)。
      //    CFN Output がある場合でも Route53 Aレコード UPSERT に IP が必要。
      const cluster = clusterName(eventId, sharedCluster());
      const listed = await ecs.send(
        new ListTasksCommand({
          cluster,
          serviceName: sfuServiceName(eventId, sharedCluster()),
          desiredStatus: "RUNNING",
        }),
      );
      const taskArn = listed.taskArns?.[0];
      if (!taskArn) return livekitDomain ? `wss://${livekitDomain}` : undefined;
      const described = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
      const attachment = described.tasks?.[0]?.attachments?.find(
        (a: { type?: string }) => a.type === "ElasticNetworkInterface",
      );
      const eniId = attachment?.details?.find(
        (d: { name?: string }) => d.name === "networkInterfaceId",
      )?.value;
      if (!eniId) return livekitDomain ? `wss://${livekitDomain}` : undefined;
      const enis = await ec2.send(
        new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }),
      );
      const publicIp = enis.NetworkInterfaces?.[0]?.Association?.PublicIp;
      if (!publicIp) return livekitDomain ? `wss://${livekitDomain}` : undefined;

      // 3) ADR 0016 D-3: Route53 A レコードを動的 UPSERT する。
      //    CFN Output のドメイン名があればそれを使い、なければ MEDIA_DOMAIN_NAME で組み立てる。
      const mediaDomain = process.env.MEDIA_DOMAIN_NAME;
      const zoneId = process.env.MEDIA_HOSTED_ZONE_ID;
      if (zoneId) {
        const recordName =
          livekitDomain ??
          (mediaDomain ? `event-${eventId.slice(0, 8)}.${mediaDomain}` : undefined);
        if (recordName) {
          try {
            await upsertRoute53ARecord(zoneId, recordName, publicIp);
            log.info("route53 upsert", { eventId, recordName, publicIp });
            return `wss://${recordName}`;
          } catch (err) {
            log.warn("route53 upsert failed, falling back to IP", {
              eventId,
              error: String(err),
            });
          }
        }
      }

      if (livekitDomain) return `wss://${livekitDomain}`;
      return `wss://${publicIp}:${LIVEKIT_SIGNAL_PORT}`;
    },
  };

  const store: MediaStore = {
    get: async (eventId) => {
      const res = await dynamo.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND sk = :sk",
          ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":sk": "META" },
          Limit: 1,
        }),
      );
      return res.Items?.[0]?.media as EventMediaInfo | undefined;
    },
    put: async (eventId, media) => {
      await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: `EVENT#${eventId}`, sk: "META" },
          UpdateExpression: "SET media = :m, updatedAtMs = :t",
          ExpressionAttributeValues: { ":m": media, ":t": Date.now() },
        }),
      );
    },
    clear: async (eventId) => {
      await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: `EVENT#${eventId}`, sk: "META" },
          UpdateExpression: "REMOVE media SET updatedAtMs = :t",
          ExpressionAttributeValues: { ":t": Date.now() },
        }),
      );
    },
  };
  const mediaPublisher = createMediaPublisher({ resolver, store });

  // ADR 0023 D-3: 起動進捗 (events.provisioning) の読み書き。
  const provisioningStore: ProvisioningStore = {
    get: async (eventId) => {
      const res = await dynamo.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND sk = :sk",
          ExpressionAttributeValues: { ":pk": `EVENT#${eventId}`, ":sk": "META" },
          Limit: 1,
        }),
      );
      return res.Items?.[0]?.provisioning as EventProvisioningInfo | undefined;
    },
    // `provisioning` は DynamoDB の予約語なので式中で直接書けない (media は予約語ではない)。
    put: async (eventId, info) => {
      await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: `EVENT#${eventId}`, sk: "META" },
          UpdateExpression: "SET #prov = :p, updatedAtMs = :t",
          ExpressionAttributeNames: { "#prov": "provisioning" },
          ExpressionAttributeValues: { ":p": info, ":t": Date.now() },
        }),
      );
    },
    clear: async (eventId) => {
      await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: `EVENT#${eventId}`, sk: "META" },
          UpdateExpression: "REMOVE #prov SET updatedAtMs = :t",
          ExpressionAttributeNames: { "#prov": "provisioning" },
          ExpressionAttributeValues: { ":t": Date.now() },
        }),
      );
    },
  };
  const provisioningPublisher = createProvisioningPublisher({ store: provisioningStore });

  // ADR 0016 D-6 / ADR 0023 D-2: ECS サービスの desired/running 観測とスケールアップ。
  const { DescribeServicesCommand, UpdateServiceCommand } = await import("@aws-sdk/client-ecs");
  const ecsLike: EcsLike = {
    describeServices: async (cluster, services) => {
      // 存在しないサービスは failures に入るだけで例外にはならない (= 作成途中を素通りできる)。
      // 破棄直後は同名の INACTIVE/DRAINING な残骸が返ることがあり、これを「存在する」と
      // 扱うと UpdateService が ECS に拒否されるので ACTIVE だけを採用する。
      const res = await ecs.send(new DescribeServicesCommand({ cluster, services }));
      return (res.services ?? []).flatMap((svc) =>
        svc.serviceName && svc.status === "ACTIVE"
          ? [
              {
                name: svc.serviceName,
                desiredCount: svc.desiredCount ?? 0,
                runningCount: svc.runningCount ?? 0,
              },
            ]
          : [],
      );
    },
    updateDesiredCount: async (cluster, service, desiredCount) => {
      await ecs.send(new UpdateServiceCommand({ cluster, service, desiredCount }));
    },
  };

  const maxParallel = process.env.MAX_PARALLEL_EVENTS
    ? Number(process.env.MAX_PARALLEL_EVENTS)
    : DEFAULT_MAX_PARALLEL_EVENTS;

  cached = {
    fetchDesired: async () => {
      const [liveRes, pendingRes] = await Promise.all([
        dynamo.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: "gsi-live",
            KeyConditionExpression: "liveStatus = :v",
            ExpressionAttributeValues: { ":v": "live" },
          }),
        ),
        dynamo.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: "gsi-live",
            KeyConditionExpression: "liveStatus = :v",
            ExpressionAttributeValues: { ":v": "pending" },
          }),
        ),
      ]);
      return [
        ...(liveRes.Items ?? []).map(toDesiredEvent),
        ...(pendingRes.Items ?? []).map((it) => ({
          ...toDesiredEvent(it),
          pending: true as const,
        })),
      ];
    },
    terminologySweep: createTerminologySweepDeps(tableName, dynamo),
    fetchActual: async () => {
      const stacks: ActualStack[] = [];
      let next: string | undefined;
      do {
        const res = await cfn.send(
          new ListStacksCommand({
            StackStatusFilter: [
              "CREATE_IN_PROGRESS",
              "CREATE_COMPLETE",
              "CREATE_FAILED",
              "ROLLBACK_IN_PROGRESS",
              "ROLLBACK_COMPLETE",
              "ROLLBACK_FAILED",
              "DELETE_IN_PROGRESS",
              "DELETE_FAILED",
              "UPDATE_IN_PROGRESS",
              "UPDATE_COMPLETE",
              "UPDATE_FAILED",
              "UPDATE_ROLLBACK_IN_PROGRESS",
              "UPDATE_ROLLBACK_COMPLETE",
            ],
            NextToken: next,
          }),
        );
        for (const s of res.StackSummaries ?? []) {
          if (!s.StackName?.startsWith("StagecastEventMedia-")) continue;
          const eventId = s.StackName.slice("StagecastEventMedia-".length);
          const ageMs = s.CreationTime ? Date.now() - s.CreationTime.getTime() : undefined;
          const status = s.StackStatus ?? "";
          stacks.push({ eventId, kind: classifyStackStatus(status), status, ageMs });
        }
        next = res.NextToken;
      } while (next);
      return stacks;
    },
    executor: makeExecutor(),
    mediaPublisher,
    provisioningPublisher,
    ecs: ecsLike,
    maxParallel,
  };
  return cached;
}

/**
 * DynamoDB の gsi-live item を DesiredEvent に変換する (純粋関数・テスト可能)。
 *
 * item は EventDefinition を素直に格納したもの (dynamo-mapper.eventToItem)。
 * - eventId: GSI ソートキー属性 (無ければ id)
 * - captionEngine / customCaptionApi: `caption` ネスト配下から取る (top-level には無い)
 * - rtmpUrl: `youtube.rtmpUrl` から取る (フォーム入力は youtube ターゲット配下に保存される)
 */
export function toDesiredEvent(it: Record<string, unknown>): DesiredEvent {
  const caption = it.caption as
    | { engine?: DesiredEvent["captionEngine"]; customApiEnabled?: boolean }
    | undefined;
  const youtube = it.youtube as { rtmpUrl?: string; streamKeyRef?: string } | undefined;
  return {
    eventId: String(it.eventId ?? it.id ?? ""),
    captionEngine: caption?.engine ?? "transcribe",
    customCaptionApi: Boolean(caption?.customApiEnabled),
    rtmpUrl: youtube?.rtmpUrl,
    streamKeyRef: youtube?.streamKeyRef,
  };
}

/** CloudFormation スタックの状態文字列を ActualStackKind に分類する (T4)。 */
export function classifyStackStatus(status: string): ActualStackKind {
  if (status === "CREATE_COMPLETE" || status === "UPDATE_COMPLETE") return "running";
  if (status === "DELETE_IN_PROGRESS") return "deleting";
  if (status.endsWith("IN_PROGRESS")) return "in_progress";
  if (status.includes("FAILED") || status.startsWith("ROLLBACK")) return "failed";
  if (status === "DELETE_COMPLETE") return "deleting";
  return "failed";
}

async function upsertRoute53ARecord(
  hostedZoneId: string,
  recordName: string,
  publicIp: string,
): Promise<void> {
  const { Route53Client, ChangeResourceRecordSetsCommand } =
    await import("@aws-sdk/client-route-53");
  const r53 = new Route53Client({});
  await r53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Changes: [
          {
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: recordName,
              Type: "A",
              TTL: 60,
              ResourceRecords: [{ Value: publicIp }],
            },
          },
        ],
      },
    }),
  );
}

/**
 * 用語集の名前からイベント ID を取り出す (ADR 0021 D-3)。
 *
 * 名前は `stagecast-{eventId}-{target}` で、eventId は UUID。target にも `-` が入りうる
 * (`zh-TW`) ので、UUID の形で切り出す。この形に合わないものは stagecast の用語集では
 * ないので触らない (他システムの用語集を消さないための境界)。
 */
export function eventIdFromTerminologyName(name: string): string | undefined {
  const m = /^stagecast-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-.+$/.exec(
    name,
  );
  return m?.[1];
}

/** 棚卸しの判定に使うイベントの状態。行が無い (= 削除済み) ときは undefined。 */
export type EventLifecycle = { status: string } | undefined;

/**
 * 残すべき用語集かどうか。
 *
 * 資料は配信の何日も前に登録されうるので、`draft` / `scheduled` の間は残す。
 * イベントが `ended` になったか、行ごと消えたら回収する。
 */
export function shouldKeepTerminology(event: EventLifecycle): boolean {
  return event !== undefined && event.status !== "ended";
}

/**
 * 実 AWS 向けの棚卸し依存。
 *
 * 用語集 → イベントの順に引く。用語集はアカウント上限 (既定 100) で頭打ちなので、
 * `ListTerminologies` 数回 + `BatchGetItem` 1 回で済む。イベント側を全件走査するより軽い。
 */
export function createTerminologySweepDeps(
  tableName: string,
  dynamo: DynamoDBDocumentClient,
): TerminologySweepDeps {
  // SDK の読み込みとクライアント生成は 1 回だけ。棚卸しは毎 tick 走るので、
  // 用語集 1 件ごとにクライアントを作らない。
  let translate: Promise<{
    client: import("@aws-sdk/client-translate").TranslateClient;
    ListTerminologiesCommand: typeof import("@aws-sdk/client-translate").ListTerminologiesCommand;
    DeleteTerminologyCommand: typeof import("@aws-sdk/client-translate").DeleteTerminologyCommand;
  }>;
  const getTranslate = () => {
    translate ??= import("@aws-sdk/client-translate").then((m) => ({
      client: new m.TranslateClient({}),
      ListTerminologiesCommand: m.ListTerminologiesCommand,
      DeleteTerminologyCommand: m.DeleteTerminologyCommand,
    }));
    return translate;
  };

  return {
    listNames: async () => {
      const { client, ListTerminologiesCommand } = await getTranslate();
      const names: string[] = [];
      let nextToken: string | undefined;
      do {
        const listed = await client.send(
          new ListTerminologiesCommand({ MaxResults: 100, NextToken: nextToken }),
        );
        for (const t of listed.TerminologyPropertiesList ?? []) {
          if (t.Name) names.push(t.Name);
        }
        nextToken = listed.NextToken;
      } while (nextToken);
      return names;
    },
    lookupEvents: async (eventIds) => {
      const { BatchGetCommand } = await import("@aws-sdk/lib-dynamodb");
      const found = new Map<string, EventLifecycle>();
      // BatchGetItem は 1 回 100 件まで。
      for (let i = 0; i < eventIds.length; i += 100) {
        const chunk = eventIds.slice(i, i + 100);
        const res = (await dynamo.send(
          new BatchGetCommand({
            RequestItems: {
              [tableName]: {
                Keys: chunk.map((id) => ({ pk: `EVENT#${id}`, sk: "META" })),
                ProjectionExpression: "pk, #s",
                ExpressionAttributeNames: { "#s": "status" },
              },
            },
          }),
        )) as {
          Responses?: Record<string, { pk?: string; status?: string }[]>;
          UnprocessedKeys?: Record<string, { Keys?: { pk?: string }[] }>;
        };
        for (const item of res.Responses?.[tableName] ?? []) {
          const id = item.pk?.slice("EVENT#".length);
          // status が無い行は壊れているので、消さない側に倒す (誤削除より残留を選ぶ)。
          if (id) found.set(id, { status: item.status ?? "unknown" });
        }
        // スロットリング等で引けなかったキーは「行が無い」と区別がつかない。
        // 引けなかっただけなのに削除済みと見なすと、**配信中のイベントの用語集を消す**。
        // 判定不能として残す側に倒し、次の tick でやり直す。
        for (const key of res.UnprocessedKeys?.[tableName]?.Keys ?? []) {
          const id = key.pk?.slice("EVENT#".length);
          if (id) found.set(id, { status: "unknown" });
        }
      }
      // BatchGetItem は存在しない行を返さない。引けなかった = 削除済み。
      return new Map(eventIds.map((id) => [id, found.get(id)]));
    },
    remove: async (name) => {
      const { client, DeleteTerminologyCommand } = await getTranslate();
      await client.send(new DeleteTerminologyCommand({ Name: name }));
    },
  };
}

export interface TerminologySweepDeps {
  listNames: () => Promise<string[]>;
  /** eventId → 状態。行が無いものは undefined を返す。 */
  lookupEvents: (eventIds: string[]) => Promise<Map<string, EventLifecycle>>;
  remove: (name: string) => Promise<void>;
}

/**
 * 終了・削除済みイベントの翻訳用語集を回収する (ADR 0021 D-3)。
 *
 * メディアスタックの有無では判定しない。**配信せずに終わったイベント** (下書きのまま
 * 資料だけ登録された等) はスタックが存在せず、スタック基準だと永久に残るため。
 * 用語集の側から棚卸しするので、どんな経路で作られたものでも取りこぼさない。
 */
export async function sweepTerminologies(deps: TerminologySweepDeps): Promise<string[]> {
  const names = await deps.listNames();
  const byEvent = new Map<string, string[]>();
  for (const name of names) {
    const eventId = eventIdFromTerminologyName(name);
    if (!eventId) continue;
    byEvent.set(eventId, [...(byEvent.get(eventId) ?? []), name]);
  }
  if (byEvent.size === 0) return [];

  const events = await deps.lookupEvents([...byEvent.keys()]);
  const removed: string[] = [];
  for (const [eventId, eventNames] of byEvent) {
    if (shouldKeepTerminology(events.get(eventId))) continue;
    for (const name of eventNames) {
      await deps.remove(name);
      removed.push(name);
    }
  }
  return removed;
}

async function deleteRoute53ARecord(hostedZoneId: string, recordName: string): Promise<void> {
  const { Route53Client, ListResourceRecordSetsCommand, ChangeResourceRecordSetsCommand } =
    await import("@aws-sdk/client-route-53");
  const r53 = new Route53Client({});
  // DELETE にはレコードの現在値が必要なので、先に値を取得する。
  const listed = await r53.send(
    new ListResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      StartRecordName: recordName,
      StartRecordType: "A",
      MaxItems: 1,
    }),
  );
  const existing = listed.ResourceRecordSets?.find(
    (rrs: { Name?: string }) => rrs.Name === `${recordName}.` || rrs.Name === recordName,
  );
  if (!existing || existing.Type !== "A") return; // レコードが存在しない
  await r53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: hostedZoneId,
      ChangeBatch: {
        Changes: [
          {
            Action: "DELETE",
            ResourceRecordSet: existing,
          },
        ],
      },
    }),
  );
}

function makeExecutor(): ReconcileExecutor {
  // renderTemplate は CDK synth を伴うため遅延ロード。
  let provisionerPromise: Promise<ReturnType<typeof createAwsMediaStackProvisioner>> | undefined;
  async function getProv(): Promise<ReturnType<typeof createAwsMediaStackProvisioner>> {
    if (provisionerPromise) return provisionerPromise;
    provisionerPromise = (async () => {
      // テンプレート synth (= aws-cdk-lib バンドル) は別 Lambda に分離し、reconcile 本体の
      // バンドルを軽く保つ (D1)。RenderTemplateFunction を invoke して JSON を得る。
      const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
      const lambda = new LambdaClient({});
      const fnName = process.env.RENDER_TEMPLATE_FUNCTION_NAME;
      if (!fnName) throw new Error("RENDER_TEMPLATE_FUNCTION_NAME is required");
      const expressMode = process.env.CFN_EXPRESS_MODE !== "false";
      return createAwsMediaStackProvisioner({
        renderTemplate: async (spec) => {
          const res = await lambda.send(
            new InvokeCommand({
              FunctionName: fnName,
              Payload: new TextEncoder().encode(
                JSON.stringify({
                  eventId: spec.eventId,
                  captionEngine: spec.captionEngine,
                  customCaptionApi: spec.customCaptionApi,
                  ...(spec.rtmpUrl ? { rtmpUrl: spec.rtmpUrl } : {}),
                  ...(spec.streamKeyRef ? { streamKeyRef: spec.streamKeyRef } : {}),
                  ...(spec.desiredCount !== undefined ? { desiredCount: spec.desiredCount } : {}),
                  ...(spec.captionDesiredCount !== undefined
                    ? { captionDesiredCount: spec.captionDesiredCount }
                    : {}),
                }),
              ),
            }),
          );
          if (res.FunctionError) {
            throw new Error(`render template failed: ${res.FunctionError}`);
          }
          const text = res.Payload ? new TextDecoder().decode(res.Payload) : "";
          const parsed = JSON.parse(text) as { template?: string };
          if (!parsed.template) throw new Error("render template returned empty");
          return parsed.template;
        },
        pollIntervalMs: 5000,
        // reconcile は次回 tick (60s 後) で続きを見るため waitForComplete は短く打ち切る。
        maxPolls: 1,
        // CFN にリソース作成権限を委譲する実行ロール (R5, ADR 0005 D-5)。
        roleArn: process.env.CFN_EXEC_ROLE_ARN,
        // ADR 0023 D-1: CloudFormation Express モードでスタック作成を短縮する。
        // 事故時の退避用に CFN_EXPRESS_MODE=false で従来の STANDARD に戻せる。
        expressMode,
        // Express を要求したのに STANDARD で返ってきたら、パラメータが黙って落ちている
        // (SDK / リージョン未対応)。「速くならないが成功する」状態に気づけるよう警告する。
        onObserve: (o) => {
          // DeploymentConfig ごと返ってこない (= パラメータが落ちた) 場合も検知対象。
          if (expressMode && o.deploymentMode !== "EXPRESS") {
            log.warn("express mode not applied", {
              stackName: o.stackName,
              deploymentMode: o.deploymentMode,
            });
          }
          log.info("stack observed", {
            stackName: o.stackName,
            status: o.status,
            deploymentMode: o.deploymentMode,
          });
        },
      });
    })();
    return provisionerPromise;
  }
  return {
    provision: async (spec) => {
      const p = await getProv();
      // maxPolls=1 で in_progress のまま戻ってくることがあるが、次回 tick で wait/destroy を判定する。
      try {
        await p.provision(spec);
      } catch (err) {
        // 「did not complete in time」は許容 (次回 tick で観測)。それ以外は再 throw。
        if (!(err instanceof Error) || !/did not complete in time/.test(err.message)) throw err;
      }
    },
    destroy: async (eventId) => {
      const p = await getProv();
      await p.destroy({
        eventId,
        stackId: eventMediaStackName(eventId),
        status: "destroying",
        sfuUrl: "",
        captionPipelineId: "",
        valkeyNamespace: eventId,
      });
    },
  };
}

/**
 * ADR 0015 Phase 4: EventBridge Scheduler からのウォームアップペイロード。
 * scheduled 状態のイベントを warmup に遷移させ、インフラを事前起動する。
 */
interface WarmupEvent {
  warmupEventIds: string[];
}

function isWarmupEvent(event: unknown): event is WarmupEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    "warmupEventIds" in event &&
    Array.isArray((event as WarmupEvent).warmupEventIds)
  );
}

/**
 * 1 イベント分の ECS サービスを観測し、必要ならスケールアップする
 * (ADR 0016 D-6 / ADR 0023 D-2)。
 *
 * `scaleUp=true` (= live/warmup) のとき、pending で `desiredCount=0` のまま作られた
 * サービスを 1 に引き上げる。スタックが CREATE_IN_PROGRESS でも Express モードでは
 * サービスが先に出来上がっているので、running を待たずに引き上げを試みる。
 */
async function observeAndScale(
  ecs: EcsLike,
  eventId: string,
  scaleUp: boolean,
  captionEnabled: boolean,
): Promise<EventProvisioningInfo["services"]> {
  const names = eventServiceNames(eventId, sharedCluster());
  const observed = await readServiceStatuses(ecs, names);
  if (!scaleUp) return observed;
  // ADR 0017 D-2: 字幕不要なイベントの CaptionWorker=0 は意図した 0 なので引き上げない。
  const targets = { [names.sfu]: 1, [names.captionWorker]: captionEnabled ? 1 : 0 };
  const { scaled, failures, statuses } = await scaleUpServices(ecs, names, observed, targets);
  for (const service of scaled) log.info("scaled up service", { eventId, service });
  for (const f of failures) {
    log.error("scale up failed", { eventId, service: f.name, error: String(f.err) });
  }
  return statuses;
}

/** EventBridge スケジュールまたはウォームアップスケジューラから呼ばれるエントリ。 */
export async function handler(
  _event: ScheduledEvent | WarmupEvent,
  _context?: Context,
): Promise<{ done: number; errors: number; skipped: number; mediaUpdated: number }> {
  const d = await deps();

  // ADR 0015 Phase 4: ウォームアップスケジューラからの呼び出し時、
  // イベントを scheduled→warmup に遷移させて liveStatus を立てる (GSI に載せる)。
  if (isWarmupEvent(_event)) {
    const tableName = process.env.METADATA_TABLE_NAME;
    if (tableName) {
      const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient, UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
      const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
      for (const eventId of _event.warmupEventIds) {
        try {
          await dynamo.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { pk: `EVENT#${eventId}`, sk: "META" },
              UpdateExpression: "SET #st = :warmup, liveStatus = :live, updatedAtMs = :now",
              ConditionExpression: "#st = :scheduled",
              ExpressionAttributeNames: { "#st": "status" },
              ExpressionAttributeValues: {
                ":warmup": "warmup",
                ":live": "live",
                ":scheduled": "scheduled",
                ":now": Date.now(),
              },
            }),
          );
          log.info("warmup transition", { eventId, from: "scheduled", to: "warmup" });
        } catch (err) {
          log.warn("warmup transition skipped", {
            eventId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  const [allDesired, actual] = await Promise.all([d.fetchDesired(), d.fetchActual()]);

  // ADR 0008 D-6: 並列イベント数の soft cap を適用する。超過分は警告ログを出して skip。
  const { allowed: desired, skipped: cappedSkipped } = enforceMaxParallel(
    allDesired,
    actual,
    d.maxParallel,
  );
  for (const s of cappedSkipped) {
    log.warn("event provision skipped (cap exceeded)", {
      eventId: s.eventId,
      reason: "cap exceeded",
      maxParallel: d.maxParallel,
    });
  }
  log.info("parallel event count", {
    desired: allDesired.length,
    allowed: desired.length,
    skipped: cappedSkipped.length,
  });

  // 長時間残存しているスタックを検知して警告する (L3, N-1 コスト暴走の早期発見)。
  const maxAgeMs = process.env.STALE_STACK_MAX_AGE_MS
    ? Number(process.env.STALE_STACK_MAX_AGE_MS)
    : DEFAULT_STALE_STACK_MAX_AGE_MS;
  for (const s of findStaleStacks(actual, desired, { maxAgeMs })) {
    log.warn("stale event-media stack", {
      eventId: s.eventId,
      ageMs: s.ageMs,
      desired: s.desired,
      kind: s.kind,
    });
  }

  const plan = planReconcile(desired, actual);
  const planResult = await executePlan(plan, d.executor, {
    log: (e) => {
      const id = e.action.type === "provision" ? e.action.spec.eventId : e.action.eventId;
      const fields = { action: e.action.type, eventId: id, status: e.status };
      if (e.status === "error") log.error("reconcile step", { ...fields, err: e.err });
      else log.info("reconcile step", fields);
    },
  });

  // 1 イベントずつ「ECS 観測 → スケールアップ → media 確定 → 進捗の書き戻し」を回す。
  //  - ADR 0016 D-6 / ADR 0023 D-2: pending で作った desiredCount=0 を live 遷移後に 1 へ。
  //  - ADR 0008 D-2: task の Public IP から livekitUrl を確定させる。
  //  - ADR 0023 D-3: 上記の観測結果を events.provisioning に書き戻し、管理画面に出す。
  const actualById = new Map(actual.map((a) => [a.eventId, a]));
  let mediaUpdated = 0;
  for (const d2 of desired) {
    const a = actualById.get(d2.eventId);
    const wantTasks = !d2.pending;

    // Express モードでは CREATE_IN_PROGRESS の時点で既にサービスが存在しうるので、
    // running を待たずに観測・引き上げを試みる (無ければ missing として次 tick に持ち越す)。
    // failed / deleting は上の executePlan が既に DeleteStack を出しているので触らない。
    let services: EventProvisioningInfo["services"] = [];
    // ROLLBACK 系は classifyStackStatus が in_progress に落とすが、CFN が巻き戻している
    // 最中なので触らない。引き上げても直後に消されるうえ、管理画面にも「作成中」と誤表示される。
    // (Express はロールバック無効だが、CFN_EXPRESS_MODE=false の退避口では起きる)
    const rollingBack = a?.status?.includes("ROLLBACK") ?? false;
    if (a && !rollingBack && (a.kind === "running" || a.kind === "in_progress")) {
      try {
        // captionEnabled 未指定は有効扱い (reconcile.ts の toSpec と同じ既定, ADR 0017)。
        services = await observeAndScale(d.ecs, d2.eventId, wantTasks, d2.captionEnabled ?? true);
      } catch (err) {
        log.error("ecs observe/scale failed", { eventId: d2.eventId, error: String(err) });
      }
    }

    let mediaReady = false;
    if (a?.kind === "running") {
      const outcome = await d.mediaPublisher.publish(d2.eventId);
      mediaReady = outcome.status === "updated" || outcome.status === "unchanged";
      if (outcome.status === "updated") {
        mediaUpdated++;
        log.info("media publish", { eventId: d2.eventId, status: "updated" });
      } else if (outcome.status === "error") {
        log.error("media publish", { eventId: d2.eventId, err: outcome.err });
      } else {
        log.info("media publish", { eventId: d2.eventId, status: outcome.status });
      }
    }

    const input: ProvisioningInput = {
      ...(a ? { stack: { kind: a.kind, status: a.status } } : {}),
      services,
      mediaReady,
      wantTasks,
    };
    const progress = await d.provisioningPublisher.publish(d2.eventId, input);
    if (progress.status === "error") {
      log.error("provisioning publish", { eventId: d2.eventId, err: progress.err });
    } else if (progress.status === "updated") {
      log.info("provisioning publish", {
        eventId: d2.eventId,
        phase: progress.info.phase,
        stackStatus: progress.info.stackStatus,
      });
    }
  }

  // ADR 0008 D-2: desired に無いのにスタックがあった (= destroy 対象) なら media をクリア。
  // ADR 0023 D-3: 進捗表示も同時に畳む (管理画面に「破棄中」を出してからクリアする)。
  const desiredIds = new Set(desired.map((e) => e.eventId));
  for (const a of actual) {
    if (desiredIds.has(a.eventId)) continue;
    if (a.kind !== "deleting") continue;
    await d.mediaPublisher.clear(a.eventId);
    await d.provisioningPublisher.clear(a.eventId);
    log.info("media clear", { eventId: a.eventId });
  }

  // ADR 0021 D-3: 終了・削除済みイベントの翻訳用語集を回収する。
  // 失敗しても reconcile 全体は止めない (次の tick で拾い直せる)。
  try {
    const removed = await sweepTerminologies(d.terminologySweep);
    if (removed.length > 0) log.info("terminology cleanup", { removed });
  } catch (err) {
    log.error("terminology cleanup failed", { err });
  }

  // ADR 0016 D-3: Route53 クリーンアップ
  const mediaDomainName = process.env.MEDIA_DOMAIN_NAME;
  const hostedZoneId = process.env.MEDIA_HOSTED_ZONE_ID;
  if (mediaDomainName && hostedZoneId) {
    for (const a of actual) {
      if (!desiredIds.has(a.eventId) && a.kind !== "deleting") {
        const recordName = `event-${a.eventId.slice(0, 8)}.${mediaDomainName}`;
        try {
          await deleteRoute53ARecord(hostedZoneId, recordName);
        } catch {
          // レコードが存在しない場合は無視
        }
      }
    }
  }

  return { ...planResult, mediaUpdated };
}
