/**
 * ストリーム合成オーケストレーション (DESIGN.md 5.1, 5.3, F-2/F-4/F-5/F-6, N-4)。
 *
 * 発表状態 (PresentationState) を受け取り、レイアウトを計算して Egress に渡す。
 * 発表者の出し入れ (管理者操作 → Valkey) が状態に反映されると、レイアウトを再計算して
 * Egress に即時反映する (F-4)。録画は S3 に保存する (N-4)。
 */
import type { PresentationState } from '@stagecast/shared';
import { computeLayout, type BrandingInput, type CompositionLayout } from './layout.js';
import type { EgressClient, EgressHandle, RecordingConfig } from './egress.js';

export interface StreamComposerConfig {
  eventId: string;
  room: string;
  branding: BrandingInput;
  rtmpUrl?: string;
  recording?: RecordingConfig;
}

export class StreamComposer {
  private handle?: EgressHandle;
  private lastLayout?: CompositionLayout;

  constructor(
    private readonly egress: EgressClient,
    private readonly config: StreamComposerConfig,
  ) {}

  get egressHandle(): EgressHandle | undefined {
    return this.handle;
  }

  get currentLayout(): CompositionLayout | undefined {
    return this.lastLayout;
  }

  /** 初期状態でレイアウトを計算し、Egress を開始する。 */
  async start(initialState: PresentationState): Promise<EgressHandle> {
    const layout = computeLayout(initialState, this.config.branding);
    this.lastLayout = layout;
    this.handle = await this.egress.start({
      eventId: this.config.eventId,
      room: this.config.room,
      layout,
      rtmpUrl: this.config.rtmpUrl,
      recording: this.config.recording,
    });
    return this.handle;
  }

  /**
   * 発表状態の変化を反映する (F-4)。レイアウトに変化があれば Egress を更新する。
   * 変化なし (冪等) のときは Egress を呼ばない。
   * @returns レイアウトが更新されたら true。
   */
  async onPresentationChanged(state: PresentationState): Promise<boolean> {
    if (!this.handle) throw new Error('composer not started');
    const next = computeLayout(state, this.config.branding);
    if (this.lastLayout && layoutEquals(this.lastLayout, next)) return false;
    this.lastLayout = next;
    await this.egress.updateLayout(this.handle, next);
    return true;
  }

  async stop(): Promise<void> {
    if (!this.handle) return;
    await this.egress.stop(this.handle);
    this.handle = undefined;
  }
}

function layoutEquals(a: CompositionLayout, b: CompositionLayout): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
