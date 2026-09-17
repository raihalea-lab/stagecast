/**
 * メディア層の起動進捗を判定し、events 行に書き戻す責務 (ADR 0023 D-3)。
 *
 * CloudFormation の CREATE_COMPLETE は「配信できる」ことを意味しない。特に Express モード
 * (ADR 0023 D-1) では CFN は設定適用の時点で完了を返すため、ECS タスクはまだ起動途中である。
 * そこで CFN の状態 + ECS の desired/running + LiveKit URL の確定有無を 1 つの
 * `EventProvisioningInfo` に畳み込み、管理画面が「どこまで進んだか」を出せるようにする。
 *
 * 判定は純粋関数、書き込みは注入した store に委ねる (テストは fake で完結する)。
 */
import type { EcsServiceStatus, EventProvisioningInfo, ProvisioningPhase } from "@stagecast/shared";
import type { ActualStackKind } from "./reconcile.js";

export interface ProvisioningInput {
  /** CloudFormation の観測結果。スタックがまだ無いなら undefined。 */
  stack?: { kind: ActualStackKind; status?: string | undefined } | undefined;
  /** ECS サービスの desired/running (表示順を保つ)。 */
  services: EcsServiceStatus[];
  /** LiveKit URL が確定済みか (events.media が埋まっているか)。 */
  mediaReady: boolean;
  /**
   * シグナリングが外から応答したか (ADR 0027 D-1)。probe を打たなかった tick は undefined。
   * `false` のときだけ ready を止める (未実施で starting に落とすと逆に嘘になる)。
   */
  signalingReady?: boolean | undefined;
  /** シグナリングに到達できなかった理由。 */
  signalingError?: string | undefined;
  /**
   * タスクが起動しているべきか。live/warmup は true、scheduled の事前プロビジョニング
   * (desiredCount=0, ADR 0016 D-4) は false。false のときはスタック完成をもって ready とする。
   */
  wantTasks: boolean;
  /**
   * 直近の provision/destroy の失敗理由 (D16)。成功した tick では undefined。
   * スタックがまだ無い状態でもこれがあれば「失敗」として見せる。
   */
  error?: string | undefined;
}

/** 全サービスが desired 分だけ RUNNING になっているか (desired=0 のサービスは対象外)。 */
export function tasksRunning(services: EcsServiceStatus[]): boolean {
  const scaled = services.filter((s) => !s.missing && s.desiredCount > 0);
  if (scaled.length === 0) return false;
  return scaled.every((s) => s.runningCount >= s.desiredCount);
}

/** 純粋関数: 観測値から phase を決める。 */
export function computePhase(input: ProvisioningInput): ProvisioningPhase {
  const kind = input.stack?.kind;
  // スタックがまだ無くても、作ろうとして失敗しているなら「未作成」ではなく「失敗」。
  // ここを none のままにすると、毎分失敗していても画面は作成待ちに見える (D16)。
  if (!kind) return input.error ? "failed" : "none";
  if (kind === "deleting") return "deleting";
  if (kind === "failed") return "failed";
  if (kind === "in_progress") return "creating";
  // kind === "running": スタックは完成。タスク起動待ちかどうかで分かれる。
  // 事前プロビジョニング (desiredCount=0, ADR 0016 D-4) はタスクを動かさないので、
  // シグナリングが応答しないのが正常。スタック完成をもって ready とする。
  if (!input.wantTasks) return "ready";
  // ADR 0027 D-2: タスクが RUNNING でも配信できるとは限らない。外から実際に
  // 到達できるまで ready にしない (2026-09-17 に「タスクはあるのに誰も入れない」を踏んだ)。
  if (!tasksRunning(input.services) || !input.mediaReady) return "starting";
  return input.signalingReady === false ? "starting" : "ready";
}

/** 純粋関数: 管理画面に出す観測結果を組み立てる。 */
export function computeProvisioning(
  input: ProvisioningInput,
  observedAtMs: number,
): EventProvisioningInfo {
  return {
    phase: computePhase(input),
    ...(input.stack?.status ? { stackStatus: input.stack.status } : {}),
    services: input.services,
    mediaReady: input.mediaReady,
    ...(input.signalingReady === undefined ? {} : { signalingReady: input.signalingReady }),
    ...(input.signalingError ? { signalingError: input.signalingError } : {}),
    ...(input.error ? { error: input.error } : {}),
    observedAtMs,
  };
}

/** events 行の provisioning フィールドを読み書きする。テストでは fake を注入する。 */
export interface ProvisioningStore {
  get(eventId: string): Promise<EventProvisioningInfo | undefined>;
  put(eventId: string, info: EventProvisioningInfo): Promise<void>;
  clear(eventId: string): Promise<void>;
}

/**
 * observedAtMs だけの差分は「変化なし」とみなす (毎 tick の無駄な書き込みを避ける, N-1)。
 *
 * 比較対象の片方は DynamoDB から戻ってきた項目で、キー順は保証されない。
 * そのため JSON 文字列化ではなくフィールドごとに突き合わせる。
 */
export function sameProvisioning(
  a: EventProvisioningInfo | undefined,
  b: EventProvisioningInfo,
): boolean {
  if (!a) return false;
  if (a.phase !== b.phase) return false;
  if (a.stackStatus !== b.stackStatus) return false;
  if (a.mediaReady !== b.mediaReady) return false;
  // 配信できる/できないが切り替わったら書き戻す。ここを見ないと画面が古い状態を出し続ける。
  if (a.signalingReady !== b.signalingReady) return false;
  if (a.signalingError !== b.signalingError) return false;
  // 失敗理由が変わった / 直ったときに書き戻されないと、画面が古い理由を出し続ける。
  if (a.error !== b.error) return false;
  if (a.services.length !== b.services.length) return false;
  return a.services.every((s, i) => {
    const t = b.services[i];
    return (
      t !== undefined &&
      s.name === t.name &&
      s.desiredCount === t.desiredCount &&
      s.runningCount === t.runningCount &&
      Boolean(s.missing) === Boolean(t.missing)
    );
  });
}

export type ProvisioningOutcome =
  | { eventId: string; status: "updated"; info: EventProvisioningInfo }
  | { eventId: string; status: "unchanged"; info: EventProvisioningInfo }
  | { eventId: string; status: "cleared" }
  | { eventId: string; status: "error"; err: unknown };

export function createProvisioningPublisher(deps: {
  store: ProvisioningStore;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;

  async function publish(eventId: string, input: ProvisioningInput): Promise<ProvisioningOutcome> {
    try {
      const info = computeProvisioning(input, now());
      const current = await deps.store.get(eventId);
      if (sameProvisioning(current, info)) {
        return { eventId, status: "unchanged", info };
      }
      await deps.store.put(eventId, info);
      return { eventId, status: "updated", info };
    } catch (err) {
      return { eventId, status: "error", err };
    }
  }

  async function clear(eventId: string): Promise<ProvisioningOutcome> {
    try {
      await deps.store.clear(eventId);
      return { eventId, status: "cleared" };
    } catch (err) {
      return { eventId, status: "error", err };
    }
  }

  return { publish, clear };
}
