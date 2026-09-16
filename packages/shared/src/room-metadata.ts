/**
 * LiveKit の room metadata に載せる投影状態 (ADR 0022 D-1)。
 *
 * composer (egress の headless Chrome) は LiveKit の token と url しか受け取らず、
 * 制御 API を叩く術がない。room metadata なら**接続時に必ず届き**、更新も
 * `RoomMetadataChanged` で拾えるので、CORS も追加の認証も要らない。
 *
 * これにより composer は「配り直されるのを待つ」side から「状態を読む」side になる。
 */
import type { DeckRef, SlideSource } from "./presentation.js";

/** metadata のスキーマ版。読めない版は無視する (composer を壊さない)。 */
export const ROOM_METADATA_VERSION = 1;

/** room metadata の中身。 */
export interface RoomPresentationMetadata {
  v: typeof ROOM_METADATA_VERSION;
  slideSource?: SlideSource;
  slidePage?: number;
  deck?: DeckRef;
  /**
   * デッキの署名付き GET URL。
   *
   * 署名は失効するので、composer は**受け取ったらすぐ取りに行く**前提。
   * 同じデッキの URL だけが変わった場合に読み直さないよう、同一性は `deck.assetId` で見る
   * (URL 文字列で比べると再発行のたびに配信画面がちらつく)。
   */
  deckUrl?: string;
}

export function encodeRoomMetadata(meta: Omit<RoomPresentationMetadata, "v">): string {
  return JSON.stringify({ v: ROOM_METADATA_VERSION, ...meta } satisfies RoomPresentationMetadata);
}

/**
 * room metadata を読む。空・壊れている・未知の版は undefined。
 *
 * metadata は投影以外の用途にも使われうるので、`v` が無いものも黙って無視する。
 */
export function decodeRoomMetadata(raw: string | undefined): RoomPresentationMetadata | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<RoomPresentationMetadata>;
    if (parsed?.v !== ROOM_METADATA_VERSION) return undefined;
    return parsed as RoomPresentationMetadata;
  } catch {
    return undefined;
  }
}
