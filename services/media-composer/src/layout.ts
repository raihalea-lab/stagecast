/**
 * 配信画面のレイアウト合成 (DESIGN.md 5.1, 5.2, F-2/F-5)。
 *
 * 発表状態 (PresentationState) と配信素材 (タイトル・QR) から、合成すべき画面の
 * レイアウト記述を計算する。Egress (LiveKit) はこの記述に従って 1 本の映像を合成し
 * RTMP 出力する。発表者の出し入れは PresentationState に反映され、再計算で即座に映像へ伝わる。
 */
import { liveSpeakers, type PresentationState } from '@stagecast/shared';

/** 正規化された矩形領域 (0..1)。16:9 キャンバス上の相対位置。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpeakerTile {
  speakerId: string;
  region: Rect;
}

export interface CompositionLayout {
  /** スライド (画面共有 or 事前アップロード) の表示領域。未投影なら null。 */
  slide: { region: Rect; source: 'screen-share' | 'uploaded'; page?: number } | null;
  /** 発表中の登壇者タイル一覧。 */
  speakers: SpeakerTile[];
  /** QR コードのオーバーレイ (右下)。 */
  qr: Rect | null;
  /** イベントタイトルのテロップ (下部ロワーサード)。 */
  title: { region: Rect; text: string } | null;
}

export interface BrandingInput {
  title?: string;
  showQr?: boolean;
}

/** 発表中の登壇者を縦に積むときのタイル領域を計算する (スライドの右側カラム)。 */
function speakerColumn(count: number): Rect[] {
  if (count === 0) return [];
  const x = 0.72;
  const w = 0.26;
  const gap = 0.02;
  const h = (1 - gap * (count + 1)) / count;
  return Array.from({ length: count }, (_, i) => ({
    x,
    y: gap + i * (h + gap),
    w,
    h,
  }));
}

/**
 * 発表状態と素材からレイアウトを計算する (DESIGN.md 5.1)。
 * - スライドがあれば左側の大きな領域、登壇者は右側カラム。
 * - スライドが無ければ登壇者をグリッド全面表示。
 */
export function computeLayout(
  state: PresentationState,
  branding: BrandingInput = {},
): CompositionLayout {
  const live = liveSpeakers(state);
  const hasSlide = state.slideSource !== undefined;

  let slide: CompositionLayout['slide'] = null;
  let speakers: SpeakerTile[];

  if (hasSlide) {
    slide = {
      region: { x: 0.02, y: 0.02, w: 0.66, h: 0.82 },
      source: state.slideSource as 'screen-share' | 'uploaded',
      page: state.slidePage,
    };
    const regions = speakerColumn(live.length);
    speakers = live.map((s, i) => ({ speakerId: s.speakerId, region: regions[i]! }));
  } else {
    // スライド無し: 登壇者をグリッド表示。
    speakers = gridTiles(live.map((s) => s.speakerId));
  }

  const qr: Rect | null = branding.showQr ? { x: 0.88, y: 0.7, w: 0.1, h: 0.18 } : null;
  const title: CompositionLayout['title'] = branding.title
    ? { region: { x: 0.02, y: 0.88, w: 0.96, h: 0.1 }, text: branding.title }
    : null;

  return { slide, speakers, qr, title };
}

/** 登壇者をできるだけ正方に近いグリッドへ配置する。 */
function gridTiles(ids: string[]): SpeakerTile[] {
  const n = ids.length;
  if (n === 0) return [];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const gap = 0.01;
  const w = (1 - gap * (cols + 1)) / cols;
  const h = (1 - gap * (rows + 1)) / rows;
  return ids.map((speakerId, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    return {
      speakerId,
      region: { x: gap + c * (w + gap), y: gap + r * (h + gap), w, h },
    };
  });
}
