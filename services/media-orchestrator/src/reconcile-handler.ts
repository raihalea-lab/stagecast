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
  executePlan,
  planReconcile,
  type ActualStack,
  type ActualStackKind,
  type DesiredEvent,
  type ReconcileExecutor,
} from "./reconcile.js";

/** 環境変数 → 結線。Lambda の cold start で 1 度だけ評価する。 */
interface HandlerDeps {
  fetchDesired: () => Promise<DesiredEvent[]>;
  fetchActual: () => Promise<ActualStack[]>;
  executor: ReconcileExecutor;
}

let cached: HandlerDeps | undefined;

async function deps(): Promise<HandlerDeps> {
  if (cached) return cached;
  const tableName = process.env.METADATA_TABLE_NAME;
  if (!tableName) throw new Error("METADATA_TABLE_NAME is required");
  // 遅延 import: テストや代替ハンドラから読まれても副作用を発生させない。
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, QueryCommand } = await import("@aws-sdk/lib-dynamodb");
  const { CloudFormationClient, ListStacksCommand } =
    await import("@aws-sdk/client-cloudformation");
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const cfn = new CloudFormationClient({});

  cached = {
    fetchDesired: async () => {
      const res = await dynamo.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: "gsi-live",
          KeyConditionExpression: "liveStatus = :v",
          ExpressionAttributeValues: { ":v": "live" },
        }),
      );
      return (res.Items ?? []).map((it) => ({
        eventId: String(it.eventId ?? it.pk ?? ""),
        captionEngine: (it.captionEngine as DesiredEvent["captionEngine"]) ?? "transcribe",
        customCaptionApi: Boolean(it.customCaptionApi),
        rtmpUrl: (it.rtmpUrl as string | undefined) ?? undefined,
      }));
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
          stacks.push({ eventId, kind: classifyStackStatus(s.StackStatus ?? "") });
        }
        next = res.NextToken;
      } while (next);
      return stacks;
    },
    executor: makeExecutor(),
  };
  return cached;
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

function makeExecutor(): ReconcileExecutor {
  // renderTemplate は CDK synth を伴うため遅延ロード。
  let provisionerPromise: Promise<ReturnType<typeof createAwsMediaStackProvisioner>> | undefined;
  async function getProv(): Promise<ReturnType<typeof createAwsMediaStackProvisioner>> {
    if (provisionerPromise) return provisionerPromise;
    provisionerPromise = (async () => {
      const mod = (await import("@stagecast/infra/render-template")) as {
        renderEventMediaTemplate: (spec: {
          eventId: string;
          captionEngine: DesiredEvent["captionEngine"];
          customCaptionApi: boolean;
        }) => string;
      };
      return createAwsMediaStackProvisioner({
        renderTemplate: (spec) =>
          mod.renderEventMediaTemplate({
            eventId: spec.eventId,
            captionEngine: spec.captionEngine,
            customCaptionApi: spec.customCaptionApi,
          }),
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

/** EventBridge スケジュールから呼ばれるエントリ。 */
export async function handler(
  _event: ScheduledEvent,
  _context?: Context,
): Promise<{ done: number; errors: number; skipped: number }> {
  const d = await deps();
  const [desired, actual] = await Promise.all([d.fetchDesired(), d.fetchActual()]);
  const plan = planReconcile(desired, actual);
  return executePlan(plan, d.executor, {
    log: (e) => {
      const id = e.action.type === "provision" ? e.action.spec.eventId : e.action.eventId;
      const fields = { action: e.action.type, eventId: id, status: e.status };
      if (e.status === "error") log.error("reconcile step", { ...fields, err: e.err });
      else log.info("reconcile step", fields);
    },
  });
}
