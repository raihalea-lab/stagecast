/**
 * per-event LiveKit URL を ECS Task の Public IP から取得し、DynamoDB の events 行に
 * 書き戻す責務 (ADR 0008 D-1, D-2)。
 *
 * 純粋ロジック (interface 注入) と SDK 実装 (handler から組み立て) を分離する。
 * ECS describe-tasks → ENI describe-network-interfaces → DynamoDB update の流れを抽象化する。
 */
import type { EventMediaInfo } from "@stagecast/shared";

/** LiveKit Server (Fargate task) の Public IP を解決する。テストでは fake を注入する。 */
export interface MediaResolver {
  /**
   * 指定イベントの EventMediaStack で動いている LiveKit task の Public IP を返す。
   * task 起動完了前 / ENI 未割当の場合は undefined。
   */
  resolveLivekitUrl(eventId: string): Promise<string | undefined>;
}

/** events 行の media フィールドを読み書きする。テストでは fake を注入する。 */
export interface MediaStore {
  /** 現在の media フィールドを返す (なければ undefined)。 */
  get(eventId: string): Promise<EventMediaInfo | undefined>;
  /** media フィールドを書き換える (DynamoDB UpdateItem)。 */
  put(eventId: string, media: EventMediaInfo): Promise<void>;
  /** media フィールドをクリアする (status=ended / stack destroy 時)。 */
  clear(eventId: string): Promise<void>;
}

export interface MediaPublisherDeps {
  resolver: MediaResolver;
  store: MediaStore;
  /** 現在時刻 (テストでは固定値を注入)。 */
  now?: () => number;
}

export type PublishOutcome =
  | { eventId: string; status: "updated"; media: EventMediaInfo }
  | { eventId: string; status: "unchanged"; media: EventMediaInfo }
  | { eventId: string; status: "not-ready" }
  | { eventId: string; status: "cleared" }
  | { eventId: string; status: "error"; err: unknown };

export function createMediaPublisher(deps: MediaPublisherDeps) {
  const now = deps.now ?? Date.now;

  /**
   * 1 イベントに対して media を確定させる:
   * - task の Public IP を取得
   * - 取れていれば current と比較して必要なら DynamoDB を更新
   * - 取れていなければ "not-ready"
   */
  async function publish(eventId: string): Promise<PublishOutcome> {
    try {
      const url = await deps.resolver.resolveLivekitUrl(eventId);
      if (!url) return { eventId, status: "not-ready" };
      const current = await deps.store.get(eventId);
      if (current?.livekitUrl === url) {
        return { eventId, status: "unchanged", media: current };
      }
      const next: EventMediaInfo = { livekitUrl: url, readyAt: now() };
      await deps.store.put(eventId, next);
      return { eventId, status: "updated", media: next };
    } catch (err) {
      return { eventId, status: "error", err };
    }
  }

  /** events 行の media をクリアする (status=ended / stack destroy 時)。 */
  async function clear(eventId: string): Promise<PublishOutcome> {
    try {
      await deps.store.clear(eventId);
      return { eventId, status: "cleared" };
    } catch (err) {
      return { eventId, status: "error", err };
    }
  }

  return { publish, clear };
}
