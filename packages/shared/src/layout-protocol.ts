/**
 * Layout 切替プロトコル (ADR 0012 D-4, R16)。
 *
 * admin-web から composer-template に layout 切替を broadcast するための JSON 仕様。
 * LiveKit room の data channel (`room.localParticipant.publishData`) を経由する。
 *
 * メッセージ format:
 *   { type: "layout-change", layout: "spotlight", focusIdentity?: "speaker-XXX" }
 *
 * composer-template 側は `RoomEvent.DataReceived` で受信し、 React state を更新する。
 * focusIdentity は spotlight / pip / screen-share-main で「メイン表示する participant」を
 * 指定する。 未指定なら自動選択 (最初の publisher / 画面共有 publisher)。
 *
 * admin-web と composer-template の両方が import するため、 共有パッケージに集約する。
 */

export type LayoutKind = "grid" | "spotlight" | "pip" | "screen-share-main";

export const ALL_LAYOUTS: readonly LayoutKind[] = [
  "grid",
  "spotlight",
  "pip",
  "screen-share-main",
];

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

/** メッセージを Uint8Array にエンコードする (LiveKit publishData の引数型に合わせる)。 */
export function encodeLayoutMessage(msg: LayoutChangeMessage): Uint8Array {
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
