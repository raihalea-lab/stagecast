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

/** DataChannel メッセージ共用型。 */
export type StageMessage = LayoutChangeMessage | MuteRequestMessage;

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
    return null;
  } catch {
    return null;
  }
}
