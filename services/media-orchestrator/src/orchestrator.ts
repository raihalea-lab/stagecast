/**
 * イベント単位オーケストレーション (DESIGN.md 7.1, 7.3, N-5, F-9)。
 *
 * 管理者がイベントを開始するとメディア/字幕スタックを起動し、終了で破棄する。
 * 最大 3 イベントを同時並行で起動でき、各イベントは独立した資源・共有状態名前空間を
 * 持つため相互に干渉しない。非配信時はスタックを保持せず、課金対象を残さない (N-1)。
 */
import type { EventMediaSpec, MediaStackHandle, MediaStackProvisioner } from "./provisioner.js";
import type { SharedStateStore } from "./shared-state.js";

/** 同時並行で起動できる最大イベント数 (DESIGN.md F-9, 7.x)。 */
export const MAX_CONCURRENT_EVENTS = 3;

export class ConcurrencyLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`concurrent event limit reached (${limit})`);
    this.name = "ConcurrencyLimitError";
  }
}

export interface ActiveEvent {
  handle: MediaStackHandle;
  startedAtMs: number;
}

export class MediaOrchestrator {
  private readonly active = new Map<string, ActiveEvent>();

  constructor(
    private readonly provisioner: MediaStackProvisioner,
    private readonly sharedState: SharedStateStore,
    private readonly now: () => number = Date.now,
    private readonly maxConcurrent: number = MAX_CONCURRENT_EVENTS,
  ) {}

  /** 現在稼働中のイベント数。 */
  get activeCount(): number {
    return this.active.size;
  }

  isActive(eventId: string): boolean {
    return this.active.has(eventId);
  }

  listActive(): ActiveEvent[] {
    return [...this.active.values()];
  }

  /**
   * イベントのメディア/字幕スタックを起動する。
   * - 既に起動済みなら冪等にそのハンドルを返す。
   * - 同時起動数が上限なら ConcurrencyLimitError。
   */
  async startEvent(spec: EventMediaSpec): Promise<MediaStackHandle> {
    const existing = this.active.get(spec.eventId);
    if (existing) return existing.handle;

    if (this.active.size >= this.maxConcurrent) {
      throw new ConcurrencyLimitError(this.maxConcurrent);
    }

    const handle = await this.provisioner.provision(spec);
    // イベント名前空間に初期共有状態を書き込む (発表状態の初期化)。他イベントとは隔離される。
    await this.sharedState.set(spec.eventId, "stackId", handle.stackId);
    await this.sharedState.set(spec.eventId, "status", "running");
    this.active.set(spec.eventId, { handle, startedAtMs: this.now() });
    return handle;
  }

  /**
   * イベントのスタックを破棄し、共有状態名前空間をクリアする。
   * 未起動なら何もしない (冪等)。
   */
  async stopEvent(eventId: string): Promise<void> {
    const current = this.active.get(eventId);
    if (!current) return;
    await this.provisioner.destroy(current.handle);
    await this.sharedState.clearNamespace(eventId);
    this.active.delete(eventId);
  }
}
