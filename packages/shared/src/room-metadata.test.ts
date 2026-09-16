import { describe, expect, it } from "vitest";
import { decodeRoomMetadata, encodeRoomMetadata, ROOM_METADATA_VERSION } from "./room-metadata.js";

describe("room metadata (ADR 0022 D-1)", () => {
  const deck = { assetId: "a-1", filename: "deck.pdf", pageCount: 7 };

  it("往復する", () => {
    const raw = encodeRoomMetadata({ slideSource: "uploaded", slidePage: 3, deck, deckUrl: "u" });
    expect(decodeRoomMetadata(raw)).toEqual({
      v: ROOM_METADATA_VERSION,
      slideSource: "uploaded",
      slidePage: 3,
      deck,
      deckUrl: "u",
    });
  });

  it("空・壊れた JSON は undefined (composer を壊さない)", () => {
    expect(decodeRoomMetadata(undefined)).toBeUndefined();
    expect(decodeRoomMetadata("")).toBeUndefined();
    expect(decodeRoomMetadata("{壊れた")).toBeUndefined();
  });

  it("投影以外の用途で使われている metadata は黙って無視する", () => {
    expect(decodeRoomMetadata(JSON.stringify({ someoneElse: true }))).toBeUndefined();
  });

  it("未知の版は無視する (古い composer が新しい形を読まない)", () => {
    expect(decodeRoomMetadata(JSON.stringify({ v: 99, slidePage: 1 }))).toBeUndefined();
  });
});
