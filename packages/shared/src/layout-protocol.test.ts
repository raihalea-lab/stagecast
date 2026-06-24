import { describe, expect, it } from "vitest";
import {
  ALL_LAYOUTS,
  decodeLayoutMessage,
  decodeStageMessage,
  encodeLayoutMessage,
  encodeStageMessage,
  type LayoutChangeMessage,
  type MuteRequestMessage,
} from "./layout-protocol.js";

describe("layout-protocol (R16, ADR 0012 D-4)", () => {
  it("ALL_LAYOUTS は grid / spotlight / pip / screen-share-main の 4 つ", () => {
    expect(ALL_LAYOUTS).toEqual(["grid", "spotlight", "pip", "screen-share-main"]);
  });

  it("encode → decode で往復する", () => {
    const msg: LayoutChangeMessage = { type: "layout-change", layout: "spotlight" };
    const bytes = encodeLayoutMessage(msg);
    const back = decodeLayoutMessage(bytes);
    expect(back).toEqual(msg);
  });

  it("focusIdentity 付きも往復する", () => {
    const msg: LayoutChangeMessage = {
      type: "layout-change",
      layout: "pip",
      focusIdentity: "speaker-abc",
    };
    expect(decodeLayoutMessage(encodeLayoutMessage(msg))).toEqual(msg);
  });

  it("不正な JSON は null", () => {
    expect(decodeLayoutMessage(new TextEncoder().encode("not json"))).toBeNull();
  });

  it("type が違うと null (他種のメッセージは無視)", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "ping" }));
    expect(decodeLayoutMessage(bytes)).toBeNull();
  });

  it("未知の layout は null (将来追加された layout を旧 client が無視)", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: "layout-change", layout: "unknown-layout" }),
    );
    expect(decodeLayoutMessage(bytes)).toBeNull();
  });
});

describe("mute-request (D8)", () => {
  it("encodeStageMessage → decodeStageMessage で mute-request が往復する", () => {
    const msg: MuteRequestMessage = { type: "mute-request", targetIdentity: "speaker-xyz" };
    const bytes = encodeStageMessage(msg);
    expect(decodeStageMessage(bytes)).toEqual(msg);
  });

  it("decodeStageMessage は layout-change も decode できる", () => {
    const msg: LayoutChangeMessage = { type: "layout-change", layout: "grid" };
    expect(decodeStageMessage(encodeLayoutMessage(msg))).toEqual(msg);
  });

  it("decodeStageMessage は不正な JSON は null", () => {
    expect(decodeStageMessage(new TextEncoder().encode("garbage"))).toBeNull();
  });

  it("decodeStageMessage は targetIdentity が無い mute-request は null", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "mute-request" }));
    expect(decodeStageMessage(bytes)).toBeNull();
  });
});
