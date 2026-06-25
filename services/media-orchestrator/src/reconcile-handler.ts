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

/**
 * ECS Cluster 名を解決する (ADR 0015 Phase 3)。
 * SHARED_CLUSTER_NAME が設定されていれば共有 Cluster を使い、なければ per-event Cluster。
 */
function clusterName(eventId: string): string {
  return process.env.SHARED_CLUSTER_NAME ?? `stagecast-event-${eventId}`;
}

/**
 * SFU サービス名を解決する (ADR 0015 Phase 3)。
 * 共有 Cluster 時は `sfu-{eventId}` で衝突回避、per-event Cluster 時は固定 `sfu`。
 */
function sfuServiceName(eventId: string): string {
  return process.env.SHARED_CLUSTER_NAME ? `sfu-${eventId}` : "sfu";
}

import { createMediaPublisher, type MediaResolver, type MediaStore } from "./media-publisher.js";
import type { EventMediaInfo } from "@stagecast/shared";

/** 環境変数 → 結線。Lambda の cold start で 1 度だけ評価する。 */
interface HandlerDeps {
  fetchDesired: () => Promise<DesiredEvent[]>;
  fetchActual: () => Promise<ActualStack[]>;
  executor: ReconcileExecutor;
  mediaPublisher: ReturnType<typeof createMediaPublisher>;
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
      // 1) CFN Output から NLB + ACM 構成の per-event ドメインを引く (ADR 0009)
      try {
        const stackName = eventMediaStackName(eventId);
        const stacks = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
        const outputs = stacks.Stacks?.[0]?.Outputs ?? [];
        const livekitDomain = outputs.find(
          (o: { OutputKey?: string }) => o.OutputKey === "LivekitDomainName",
        )?.OutputValue;
        if (livekitDomain) {
          return `wss://${livekitDomain}`;
        }
      } catch {
        // スタック存在しない / Output 未定義 → Public IP fallback に進む。
      }

      // 2) Fallback: ECS task の Public IP を解決する (ADR 0008 D-2)。
      const cluster = clusterName(eventId);
      const listed = await ecs.send(
        new ListTasksCommand({
          cluster,
          serviceName: sfuServiceName(eventId),
          desiredStatus: "RUNNING",
        }),
      );
      const taskArn = listed.taskArns?.[0];
      if (!taskArn) return undefined;
      const described = await ecs.send(new DescribeTasksCommand({ cluster, tasks: [taskArn] }));
      const attachment = described.tasks?.[0]?.attachments?.find(
        (a: { type?: string }) => a.type === "ElasticNetworkInterface",
      );
      const eniId = attachment?.details?.find(
        (d: { name?: string }) => d.name === "networkInterfaceId",
      )?.value;
      if (!eniId) return undefined;
      const enis = await ec2.send(
        new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }),
      );
      const publicIp = enis.NetworkInterfaces?.[0]?.Association?.PublicIp;
      if (!publicIp) return undefined;

      // 3) ADR 0016 D-3: Route53 A レコードを動的 UPSERT する。
      const mediaDomain = process.env.MEDIA_DOMAIN_NAME;
      const zoneId = process.env.MEDIA_HOSTED_ZONE_ID;
      if (mediaDomain && zoneId) {
        const recordName = `event-${eventId.slice(0, 8)}.${mediaDomain}`;
        try {
          await upsertRoute53ARecord(zoneId, recordName, publicIp);
          return `wss://${recordName}`;
        } catch (err) {
          log.warn("route53 upsert failed, falling back to IP", {
            eventId,
            error: String(err),
          });
        }
      }

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
          stacks.push({ eventId, kind: classifyStackStatus(s.StackStatus ?? ""), ageMs });
        }
        next = res.NextToken;
      } while (next);
      return stacks;
    },
    executor: makeExecutor(),
    mediaPublisher,
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
                  // R12: youtube.rtmpUrl と streamKeyRef を RenderTemplateFunction にも伝播させる。
                  // 現時点では Egress コンテナ起動時に直接使われないが、将来の自動 Egress 起動に備える。
                  ...(spec.rtmpUrl ? { rtmpUrl: spec.rtmpUrl } : {}),
                  ...(spec.streamKeyRef ? { streamKeyRef: spec.streamKeyRef } : {}),
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
 * ADR 0016 D-6: pending → live 遷移時に desiredCount=0 のサービスを 1 に引き上げる。
 * 全 ECS サービスの desiredCount が 0 なら 1 に更新する。
 */
async function scaleUpIfNeeded(eventId: string): Promise<void> {
  const { ECSClient, DescribeServicesCommand, UpdateServiceCommand } =
    await import("@aws-sdk/client-ecs");
  const ecsClient = new ECSClient({});
  const cluster = clusterName(eventId);
  const serviceNames = [
    sfuServiceName(eventId),
    process.env.SHARED_CLUSTER_NAME ? `valkey-${eventId}` : "valkey",
    process.env.SHARED_CLUSTER_NAME ? `captionworker-${eventId}` : "captionworker",
  ];
  const desc = await ecsClient.send(
    new DescribeServicesCommand({ cluster, services: serviceNames }),
  );
  for (const svc of desc.services ?? []) {
    if (svc.desiredCount === 0 && svc.serviceName) {
      await ecsClient.send(
        new UpdateServiceCommand({
          cluster,
          service: svc.serviceName,
          desiredCount: 1,
        }),
      );
      log.info("scaled up service", { eventId, service: svc.serviceName });
    }
  }
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

  // ADR 0016 D-6: live イベントで running スタックの desiredCount が 0 の場合、1 に引き上げる。
  const actualById = new Map(actual.map((a) => [a.eventId, a]));
  for (const d2 of desired.filter((d) => !d.pending)) {
    const a = actualById.get(d2.eventId);
    if (a?.kind === "running") {
      try {
        await scaleUpIfNeeded(d2.eventId);
      } catch (err) {
        log.error("scale-up failed", { eventId: d2.eventId, error: String(err) });
      }
    }
  }

  // ADR 0008 D-2: live + 既にスタック running の各イベントに対して media を確定させる。
  const runningIds = new Set(actual.filter((a) => a.kind === "running").map((a) => a.eventId));
  const liveRunning = desired.filter((d) => runningIds.has(d.eventId));
  let mediaUpdated = 0;
  for (const d2 of liveRunning) {
    const outcome = await d.mediaPublisher.publish(d2.eventId);
    if (outcome.status === "updated") {
      mediaUpdated++;
      log.info("media publish", { eventId: d2.eventId, status: "updated" });
    } else if (outcome.status === "error") {
      log.error("media publish", { eventId: d2.eventId, err: outcome.err });
    } else {
      log.info("media publish", { eventId: d2.eventId, status: outcome.status });
    }
  }
  // ADR 0008 D-2: desired に無いのにスタックがあった (= destroy 対象) なら media をクリア。
  const desiredIds = new Set(desired.map((e) => e.eventId));
  for (const a of actual) {
    if (desiredIds.has(a.eventId)) continue;
    if (a.kind !== "deleting") continue;
    await d.mediaPublisher.clear(a.eventId);
    log.info("media clear", { eventId: a.eventId });
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
