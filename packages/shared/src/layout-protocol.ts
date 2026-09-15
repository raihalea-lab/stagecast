/**
 * Layout 切替 + stage 間メッセージプロトコル (ADR 0012 D-4, R16, D8)。
 *
 * LiveKit room の data channel (`room.localParticipant.publishData`) を経由するメッセージ仕様。
 *
 * メッセージ種別:
 *   - layout-change: レイアウト切替 (admin/moderator → composer-template)
 *   - mute-request:  ミュート要請 (moderator/admin → speaker)
 *
 * composer-template 側は `RoomEvent.DataReceived` で受信し、 React state を更新する。
 * stage-web 側は mute-request を受信して通知を表示し、speaker が任意でミュートする。
 */

export type LayoutKind = "grid" | "spotlight" | "pip" | "screen-share-main";

export const ALL_LAYOUTS: readonly LayoutKind[] = ["grid", "spotlight", "pip", "screen-share-main"];

/** Layout の表示用ラベル (admin-web の切替ボタンで使う)。 */
export const LAYOUT_LABELS: Record<LayoutKind, string> = {
  grid: "グリッド",
  spotlight: "スポットライト",
  pip: "ピクチャー・イン・ピクチャー",
  "screen-share-main": "画面共有メイン",
};

/** Layout 切替メッセージ (admin-web → composer-template)。 */
export interface LayoutChangeMessage {
  type: "layout-change";
  layout: LayoutKind;
  /** spotlight / pip / screen-share-main で main 表示する participant identity (省略可)。 */
  focusIdentity?: string;
}

/** ミュート要請メッセージ (moderator/admin → speaker, D8)。 */
export interface MuteRequestMessage {
  type: "mute-request";
  /** ミュート要請先の participant identity。 */
  targetIdentity: string;
}

/** 強制ミュートメッセージ (admin/moderator → speaker)。受信側は自動的にマイクをオフにする。 */
export interface ForceMuteMessage {
  type: "force-mute";
  /** 強制ミュート先の participant identity。 */
  targetIdentity: string;
}

/** 登壇者の表示状態変更メッセージ (admin/moderator → composer-template)。 */
export interface VisibilityChangeMessage {
  type: "visibility-change";
  /** 対象の登壇者 identity。 */
  speakerId: string;
  /** 変更後の表示状態。 */
  visibility: "live" | "standby";
}

/** バックステージチャットメッセージ (Phase 2)。配信スタッフ間の内部通信。 */
export interface ChatMessage {
  type: "chat";
  /** dedup 用 ID。 */
  id: string;
  senderIdentity: string;
  senderName?: string;
  text: string;
  timestampMs: number;
}

/** バナー（下部テロップ）表示メッセージ (Phase 3)。 */
export interface BannerShowMessage {
  type: "banner-show";
  text: string;
  subtext?: string;
  position: "bottom" | "top";
  autoHideMs?: number;
}

/** バナー非表示メッセージ (Phase 3)。 */
export interface BannerHideMessage {
  type: "banner-hide";
}

/** オーバーレイ表示メッセージ (Phase 4: QRコード/画像/動画)。 */
export interface OverlayShowMessage {
  type: "overlay-show";
  kind: "qr" | "image" | "video";
  url: string;
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  sizePercent?: number;
  autoHideMs?: number;
}

/** オーバーレイ非表示メッセージ (Phase 4)。 */
export interface OverlayHideMessage {
  type: "overlay-hide";
}

/** 事前アップロードスライドのデッキ読み込みメッセージ (F-3, DESIGN.md 5.2)。 */
export interface SlideDeckMessage {
  type: "slide-deck";
  /** 署名付き GET URL (PDF の取得先)。 */
  url: string;
}

/** 事前アップロードスライドのページ送りメッセージ (F-3, DESIGN.md 5.2)。 */
export interface SlidePageMessage {
  type: "slide-page";
  /** 表示ページ番号 (1 始まり)。 */
  page: number;
}

/** DataChannel メッセージ共用型。 */
export type StageMessage =
  | LayoutChangeMessage
  | MuteRequestMessage
  | ForceMuteMessage
  | VisibilityChangeMessage
  | ChatMessage
  | BannerShowMessage
  | BannerHideMessage
  | OverlayShowMessage
  | OverlayHideMessage
  | SlideDeckMessage
  | SlidePageMessage;

/** メッセージを Uint8Array にエンコードする (LiveKit publishData の引数型に合わせる)。 */
export function encodeLayoutMessage(msg: LayoutChangeMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

/** 任意の StageMessage を Uint8Array にエンコードする。 */
export function encodeStageMessage(msg: StageMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

/**
 * 受信した Uint8Array をメッセージに decode する。 unknown 形式は null を返す
 * (data channel には他のメッセージ種別も来る可能性があるため、 防御的に判定)。
 */
export function decodeLayoutMessage(payload: Uint8Array): LayoutChangeMessage | null {
  try {
    const text = new TextDecoder().decode(payload);
    const obj = JSON.parse(text) as unknown;
    if (
      typeof obj === "object" &&
      obj !== null &&
      (obj as { type?: unknown }).type === "layout-change" &&
      ALL_LAYOUTS.includes((obj as { layout?: LayoutKind }).layout as LayoutKind)
    ) {
      return obj as LayoutChangeMessage;
    }
    return null;
  } catch {
    return null;
  }
}

/** 受信した Uint8Array を StageMessage に decode する。 */
export function decodeStageMessage(payload: Uint8Array): StageMessage | null {
  try {
    const text = new TextDecoder().decode(payload);
    const obj = JSON.parse(text) as unknown;
    if (typeof obj !== "object" || obj === null) return null;
    const type = (obj as { type?: unknown }).type;
    if (type === "layout-change") return decodeLayoutMessage(payload);
    if (
      type === "mute-request" &&
      typeof (obj as { targetIdentity?: unknown }).targetIdentity === "string"
    ) {
      return obj as MuteRequestMessage;
    }
    if (
      type === "force-mute" &&
      typeof (obj as { targetIdentity?: unknown }).targetIdentity === "string"
    ) {
      return obj as ForceMuteMessage;
    }
    if (
      type === "visibility-change" &&
      typeof (obj as { speakerId?: unknown }).speakerId === "string" &&
      ((obj as { visibility?: unknown }).visibility === "live" ||
        (obj as { visibility?: unknown }).visibility === "standby")
    ) {
      return obj as VisibilityChangeMessage;
    }
    if (
      type === "chat" &&
      typeof (obj as { id?: unknown }).id === "string" &&
      typeof (obj as { senderIdentity?: unknown }).senderIdentity === "string" &&
      typeof (obj as { text?: unknown }).text === "string" &&
      typeof (obj as { timestampMs?: unknown }).timestampMs === "number"
    ) {
      return obj as ChatMessage;
    }
    if (
      type === "banner-show" &&
      typeof (obj as { text?: unknown }).text === "string" &&
      ((obj as { position?: unknown }).position === "bottom" ||
        (obj as { position?: unknown }).position === "top")
    ) {
      return obj as BannerShowMessage;
    }
    if (type === "banner-hide") {
      return obj as BannerHideMessage;
    }
    const OVERLAY_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"];
    const OVERLAY_KINDS = ["qr", "image", "video"];
    if (
      type === "overlay-show" &&
      typeof (obj as { url?: unknown }).url === "string" &&
      OVERLAY_KINDS.includes((obj as { kind?: string }).kind as string) &&
      OVERLAY_POSITIONS.includes((obj as { position?: string }).position as string)
    ) {
      return obj as OverlayShowMessage;
    }
    if (type === "overlay-hide") {
      return obj as OverlayHideMessage;
    }
    if (type === "slide-deck" && typeof (obj as { url?: unknown }).url === "string") {
      return obj as SlideDeckMessage;
    }
    const slidePage = (obj as { page?: unknown }).page;
    if (
      type === "slide-page" &&
      typeof slidePage === "number" &&
      Number.isInteger(slidePage) &&
      slidePage >= 1
    ) {
      return obj as SlidePageMessage;
    }
    return null;
  } catch {
    return null;
  }
}
