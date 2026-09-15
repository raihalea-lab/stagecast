/**
 * EventMediaStack の ECS サービス観測とスケールアップ (ADR 0016 D-6, ADR 0020 D-2)。
 *
 * reconcile が 60s tick ごとに
 *   1. サービスの desired/running を読む (管理画面に出す進捗, ADR 0020 D-3)
 *   2. pending (desiredCount=0) で作られたサービスを live 遷移後に 1 へ引き上げる
 * を行う。AWS SDK には直接依存せず `EcsLike` に抽象化し、テストは fake を注入する。
 */
import type { EcsServiceStatus } from "@stagecast/shared";

/** EventMediaStack が作る ECS サービスの論理名 (infra の service 名と一致させる規約)。 */
export const SFU_SERVICE = "sfu";
export const CAPTION_WORKER_SERVICE = "captionworker";

/** 観測対象サービス名の解決結果。 */
export interface EventServiceNames {
  cluster: string;
  sfu: string;
  captionWorker: string;
  /** DescribeServices に渡す ECS service 名 (宣言順が管理画面の表示順になる)。 */
  services: string[];
}

/**
 * ECS Cluster 名を解決する (ADR 0015 Phase 3)。
 * 共有 Cluster があればそれを使い、無ければ per-event Cluster。
 */
export function clusterName(eventId: string, sharedClusterName?: string): string {
  return sharedClusterName ?? `stagecast-event-${eventId}`;
}

/**
 * ECS service 名を解決する (ADR 0015 Phase 3)。
 * 共有 Cluster では per-event に名前を分けて衝突を避ける。
 */
export function serviceName(
  logicalName: string,
  eventId: string,
  sharedClusterName?: string,
): string {
  return sharedClusterName ? `${logicalName}-${eventId}` : logicalName;
}

export function sfuServiceName(eventId: string, sharedClusterName?: string): string {
  return serviceName(SFU_SERVICE, eventId, sharedClusterName);
}

export function captionWorkerServiceName(eventId: string, sharedClusterName?: string): string {
  return serviceName(CAPTION_WORKER_SERVICE, eventId, sharedClusterName);
}

/**
 * 1 イベントが持つ ECS サービス名を列挙する。
 *
 * ADR 0017 で Valkey は SFU Task の sidecar になったので独立サービスとしては存在しない。
 * (旧実装はここに `valkey` を残していたため、存在しないサービスを毎 tick 問い合わせていた。)
 */
export function eventServiceNames(eventId: string, sharedClusterName?: string): EventServiceNames {
  const sfu = sfuServiceName(eventId, sharedClusterName);
  const captionWorker = captionWorkerServiceName(eventId, sharedClusterName);
  return {
    cluster: clusterName(eventId, sharedClusterName),
    sfu,
    captionWorker,
    services: [sfu, captionWorker],
  };
}

/** ECS の最小サブセット。テストでは fake を注入する。 */
export interface EcsLike {
  /**
   * 指定サービスの desired/running を返す。存在しないサービスは結果に含めない
   * (AWS SDK も failures として返し、例外にはしない)。
   */
  describeServices(
    cluster: string,
    services: string[],
  ): Promise<{ name: string; desiredCount: number; runningCount: number }[]>;
  updateDesiredCount(cluster: string, service: string, desiredCount: number): Promise<void>;
}

/**
 * サービスの現況を、要求した順序どおりに返す。見つからないサービスは
 * `missing: true` + カウント 0 として残す (スタック作成途中を「未作成」と表示するため)。
 */
export async function readServiceStatuses(
  ecs: EcsLike,
  names: EventServiceNames,
): Promise<EcsServiceStatus[]> {
  const described = await ecs.describeServices(names.cluster, names.services);
  const byName = new Map(described.map((s) => [s.name, s]));
  return names.services.map((name) => {
    const found = byName.get(name);
    if (!found) return { name, desiredCount: 0, runningCount: 0, missing: true };
    return { name, desiredCount: found.desiredCount, runningCount: found.runningCount };
  });
}

/**
 * ADR 0016 D-6: pending (desiredCount=0) で事前プロビジョニングしたサービスを目標数に引き上げる。
 *
 * `targets` はサービス名 → 目標タスク数。目標が 0 のサービスは引き上げない
 * (ADR 0017 D-2: 字幕不要なイベントで CaptionWorker を起動しないのは意図した 0 なので、
 * 「desiredCount=0 だから上げる」と一律に扱うとコスト削減が無効化される)。
 *
 * 引き上げたサービス名を返す。`missing` なサービス (まだ CFN が作っていない) は次の tick に任せる。
 * 戻り値の statuses は引き上げ後の desired を反映した観測値で、そのまま管理画面に出せる。
 */
export async function scaleUpServices(
  ecs: EcsLike,
  names: EventServiceNames,
  statuses: EcsServiceStatus[],
  targets: Record<string, number>,
): Promise<{ scaled: string[]; statuses: EcsServiceStatus[] }> {
  const scaled: string[] = [];
  const next: EcsServiceStatus[] = [];
  for (const s of statuses) {
    const target = targets[s.name] ?? 0;
    if (s.missing || s.desiredCount !== 0 || target <= 0) {
      next.push(s);
      continue;
    }
    await ecs.updateDesiredCount(names.cluster, s.name, target);
    scaled.push(s.name);
    next.push({ ...s, desiredCount: target });
  }
  return { scaled, statuses: next };
}
