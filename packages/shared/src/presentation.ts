/**
 * 発表者の制御状態 (DESIGN.md 5.3)。
 *
 * 管理者が各登壇者を「発表中」「待機」に切り替える。本型はその共有状態のスキーマ。
 * 永続化は制御層の DynamoDB (`DynamoPresentationRepository`)。
 * 投影状態 (どのデッキの何ページ目か) の**正もここに置く** (ADR 0022 D-1)。
 * レイアウトの正も同じ理由でここに置く (ADR 0025 D-1)。
 */
import type { LayoutKind } from "./layout-protocol.js";

/** 登壇者の表示状態。`live` = 発表中 (画面に出す) / `standby` = 待機。 */
export type SpeakerVisibility = "live" | "standby";

/** スライド投影の方式 (DESIGN.md 5.2, F-3)。 */
export type SlideSource = "screen-share" | "uploaded";

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
 * 投影中のデッキの参照 (ADR 0022 D-1)。
 *
 * 実体は ADR 0021 の `assets/materials/{eventId}/{assetId}/{filename}` にあり、ここでは
 * 参照だけを持つ。署名付き URL は失効するので**保存しない**。状態を読むときに都度発行する。
 */
export interface DeckRef {
  assetId: string;
  filename: string;
  /** PDF の総ページ数。最終ページの判定に使う。 */
  pageCount: number;
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
  /** 投影中のデッキ (ADR 0022 D-1)。`slideSource === "uploaded"` のときだけ意味を持つ。 */
  deck?: DeckRef;
  /** 投影状態の最終更新時刻 (UNIX ミリ秒)。競合時は新しい方を採る (ADR 0022 D-2)。 */
  slideUpdatedAtMs?: number;
  /** 現在のレイアウト (ADR 0025 D-1)。未設定なら composer の既定 (grid)。 */
  layout?: LayoutKind;
  /** `spotlight` / `pip` で主役にする participant の identity。 */
  focusIdentity?: string;
  /** レイアウトの最終更新時刻 (UNIX ミリ秒)。競合時は新しい方を採る。 */
  layoutUpdatedAtMs?: number;
}

/** 発表中 (live) の登壇者だけを抽出する。 */
export function liveSpeakers(state: PresentationState): SpeakerState[] {
  return state.speakers.filter((s) => s.visibility === "live");
}
