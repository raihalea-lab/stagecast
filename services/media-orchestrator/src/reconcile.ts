/**
 * オーケストレータ調整ループ (T4, ADR 0003 D-2)。
 *
 * 望ましい状態 (DynamoDB の live イベント集合) と実際の状態 (CloudFormation スタック集合)
 * を照合し、収束させるための操作プランを計算する。プランの実行は副作用付きの実装
 * (Provisioner) に委ねる。これにより純粋関数として単体テストできる。
 *
 * 遷移ルール:
 *  - live なのにスタックが無い        → provision
 *  - live なのにスタックが FAILED     → destroy 後に provision (クリーン再構築, D-2)
 *  - live なのにスタックが destroying → 待機 (削除完了後に再判定)
 *  - ended (= desired に無い) かつ動作中 → destroy
 *  - 既に provisioning 中             → 待機 (二重起動を避ける)
 */
import type { CaptionEngineKind } from "@stagecast/shared";
import type { EventMediaSpec } from "./provisioner.js";

/** ある時点での望ましいイベント定義 (live と扱うべきイベント)。 */
export interface DesiredEvent {
  eventId: string;
  captionEngine: CaptionEngineKind;
  customCaptionApi: boolean;
  rtmpUrl?: string | undefined;
}

/** CloudFormation 観測時点のスタック状態。 */
export type ActualStackKind = "running" | "in_progress" | "failed" | "deleting";

export interface ActualStack {
  eventId: string;
  kind: ActualStackKind;
  /** スタック作成からの経過時間 (ms)。観測できないなら未設定。stale 検知に使う (L3)。 */
  ageMs?: number;
}

/** reconcile が出すアクション (副作用なし)。 */
export type ReconcileAction =
  | { type: "provision"; spec: EventMediaSpec; reason: string }
  | { type: "destroy"; eventId: string; reason: string }
  | { type: "wait"; eventId: string; reason: string };

export interface ReconcilePlan {
  actions: ReconcileAction[];
}

/**
 * 純粋関数: 現在の desired / actual から次に取るべきアクションのリストを返す。
 */
export function planReconcile(desired: DesiredEvent[], actual: ActualStack[]): ReconcilePlan {
  const desiredById = new Map<string, DesiredEvent>(desired.map((d) => [d.eventId, d]));
  const actualById = new Map<string, ActualStack>(actual.map((a) => [a.eventId, a]));
  const seen = new Set<string>();
  const actions: ReconcileAction[] = [];

  for (const d of desired) {
    seen.add(d.eventId);
    const a = actualById.get(d.eventId);
    if (!a) {
      actions.push({ type: "provision", spec: toSpec(d), reason: "live event missing stack" });
      continue;
    }
    if (a.kind === "failed") {
      actions.push({
        type: "destroy",
        eventId: d.eventId,
        reason: "stack failed/rollback — destroy before re-provision",
      });
      continue;
    }
    if (a.kind === "deleting" || a.kind === "in_progress") {
      actions.push({
        type: "wait",
        eventId: d.eventId,
        reason: `stack ${a.kind} — wait for terminal state`,
      });
      continue;
    }
    // a.kind === "running": 何もしない (目的達成)。
  }

  for (const a of actual) {
    if (seen.has(a.eventId)) continue;
    // desired に無いのにスタックがある → 終了済みイベントの取り壊し対象。
    if (a.kind === "deleting") {
      // 既に消し中ならスキップ。
      continue;
    }
    actions.push({
      type: "destroy",
      eventId: a.eventId,
      reason: "stack exists for non-live event",
    });
  }

  // desiredById は将来の拡張 (関連処理) で使うが今は参照のみ。
  void desiredById;
  return { actions };
}

/** 長時間残存しているスタックの検知結果 (L3 コスト暴走の早期発見)。 */
export interface StaleStack {
  eventId: string;
  ageMs: number;
  /** desired (live) なのに長時間残っている = 終了し忘れの暴走イベントの可能性。 */
  desired: boolean;
  kind: ActualStackKind;
}

/**
 * 純粋関数: `maxAgeMs` を超えて存続しているスタックを抽出する (削除中は除く)。
 *
 * - desired=true: 終了操作され忘れた live イベントが課金され続けている可能性 (N-1)。
 *   reconcile は running な desired を放置するため、これが唯一の検知シグナルになる。
 * - desired=false: 破棄が継続失敗して残っている可能性 (DeleteStack が stuck)。
 *
 * 破棄や provision の判断 (planReconcile) は変えない。検知 (通知/可観測性) のみを担う。
 */
export function findStaleStacks(
  actual: ActualStack[],
  desired: DesiredEvent[],
  opts: { maxAgeMs: number },
): StaleStack[] {
  const desiredIds = new Set(desired.map((d) => d.eventId));
  const stale: StaleStack[] = [];
  for (const a of actual) {
    if (a.kind === "deleting") continue;
    if (a.ageMs === undefined || a.ageMs <= opts.maxAgeMs) continue;
    stale.push({
      eventId: a.eventId,
      ageMs: a.ageMs,
      desired: desiredIds.has(a.eventId),
      kind: a.kind,
    });
  }
  return stale;
}

function toSpec(d: DesiredEvent): EventMediaSpec {
  return {
    eventId: d.eventId,
    captionEngine: d.captionEngine,
    customCaptionApi: d.customCaptionApi,
    rtmpUrl: d.rtmpUrl,
  };
}

/** 実行側の最小依存。テストでは fake を注入する。 */
export interface ReconcileExecutor {
  provision(spec: EventMediaSpec): Promise<void>;
  destroy(eventId: string): Promise<void>;
}

export interface ExecuteOptions {
  /** 同時実行数の上限。既定 3 (N-5: 最大 3 並列の精神に合わせる)。 */
  concurrency?: number;
  log?: (event: {
    action: ReconcileAction;
    status: "started" | "done" | "error";
    err?: unknown;
  }) => void;
}

/**
 * プランを実行する。provision / destroy のみが副作用を持ち、wait は no-op。
 * 例外は握りつぶさず log に出した後、Promise.allSettled の慣習で個別失敗を許容する。
 */
export async function executePlan(
  plan: ReconcilePlan,
  executor: ReconcileExecutor,
  options: ExecuteOptions = {},
): Promise<{ done: number; errors: number; skipped: number }> {
  const concurrency = options.concurrency ?? 3;
  const queue = [...plan.actions];
  let done = 0;
  let errors = 0;
  let skipped = 0;
  const log = options.log ?? (() => {});

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const action = queue.shift();
      if (!action) return;
      if (action.type === "wait") {
        skipped++;
        log({ action, status: "done" });
        continue;
      }
      log({ action, status: "started" });
      try {
        if (action.type === "provision") await executor.provision(action.spec);
        else await executor.destroy(action.eventId);
        done++;
        log({ action, status: "done" });
      } catch (err) {
        errors++;
        log({ action, status: "error", err });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { done, errors, skipped };
}
