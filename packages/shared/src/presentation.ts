/**
 * 発表者の制御状態 (DESIGN.md 5.3)。
 *
 * 管理者が各登壇者を「発表中」「待機」に切り替える。状態は Valkey に保持され、
 * 合成処理 (Egress) が即座に反映する。本型はその共有状態のスキーマ。
 */

/** 登壇者の表示状態。`live` = 発表中 (画面に出す) / `standby` = 待機。 */
export type SpeakerVisibility = 'live' | 'standby';

/** スライド投影の方式 (DESIGN.md 5.2, F-3)。 */
export type SlideSource = 'screen-share' | 'uploaded';

/** 1 名の登壇者の状態。 */
export interface SpeakerState {
  /** 登壇者 (参加者) ID。 */
  speakerId: string;
  /** 発表中 / 待機。 */
  visibility: SpeakerVisibility;
  /** 最終更新時刻 (UNIX ミリ秒)。 */
  updatedAtMs: number;
}

/**
 * 1 イベントの発表状態スナップショット。
 * 合成処理はこれを読み、登壇者映像とスライドのレイアウトを決定する (5.1)。
 */
export interface PresentationState {
  eventId: string;
  /** 現在の登壇者状態の一覧。`live` のものが画面に表示される (複数同時可)。 */
  speakers: SpeakerState[];
  /** 現在投影中のスライド方式 (未投影なら undefined)。 */
  slideSource?: SlideSource;
  /** 事前アップロード方式のときの表示ページ番号 (1 始まり)。 */
  slidePage?: number;
}

/** 発表中 (live) の登壇者だけを抽出する。 */
export function liveSpeakers(state: PresentationState): SpeakerState[] {
  return state.speakers.filter((s) => s.visibility === 'live');
}
