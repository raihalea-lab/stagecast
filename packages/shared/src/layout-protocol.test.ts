import { describe, expect, it } from "vitest";
import {
  ALL_LAYOUTS,
  decodeLayoutMessage,
  decodeStageMessage,
  encodeLayoutMessage,
  encodeStageMessage,
  type BannerHideMessage,
  type BannerShowMessage,
  type ChatMessage,
  type OverlayHideMessage,
  type OverlayShowMessage,
  type ForceMuteMessage,
  type LayoutChangeMessage,
  type MuteRequestMessage,
  type VisibilityChangeMessage,
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

describe("force-mute (Phase 1: ミュート強化)", () => {
  it("encodeStageMessage → decodeStageMessage で force-mute が往復する", () => {
    const msg: ForceMuteMessage = { type: "force-mute", targetIdentity: "speaker-abc" };
    const bytes = encodeStageMessage(msg);
    expect(decodeStageMessage(bytes)).toEqual(msg);
  });

  it("targetIdentity が無い force-mute は null", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ type: "force-mute" }));
    expect(decodeStageMessage(bytes)).toBeNull();
  });
});

describe("visibility-change (Phase 1: ステージ管理)", () => {
  it("encodeStageMessage → decodeStageMessage で visibility-change が往復する", () => {
    const msg: VisibilityChangeMessage = {
      type: "visibility-change",
      speakerId: "speaker-1",
      visibility: "live",
    };
    const bytes = encodeStageMessage(msg);
    expect(decodeStageMessage(bytes)).toEqual(msg);
  });

  it("standby も正しく往復する", () => {
    const msg: VisibilityChangeMessage = {
      type: "visibility-change",
      speakerId: "speaker-2",
      visibility: "standby",
    };
    expect(decodeStageMessage(encodeStageMessage(msg))).toEqual(msg);
  });

  it("speakerId が無い visibility-change は null", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: "visibility-change", visibility: "live" }),
    );
    expect(decodeStageMessage(bytes)).toBeNull();
  });

  it("visibility が不正な値の場合は null", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: "visibility-change", speakerId: "s1", visibility: "hidden" }),
    );
    expect(decodeStageMessage(bytes)).toBeNull();
  });
});

describe("chat (Phase 2: バックステージチャット)", () => {
  it("encodeStageMessage → decodeStageMessage で chat が往復する", () => {
    const msg: ChatMessage = {
      type: "chat",
      id: "msg-001",
      senderIdentity: "moderator-1",
      senderName: "Alice",
      text: "準備できましたか？",
      timestampMs: 1719450000000,
    };
    const bytes = encodeStageMessage(msg);
    expect(decodeStageMessage(bytes)).toEqual(msg);
  });

  it("senderName 省略でも往復する", () => {
    const msg: ChatMessage = {
      type: "chat",
      id: "msg-002",
      senderIdentity: "speaker-1",
      text: "はい",
      timestampMs: 1719450001000,
    };
    expect(decodeStageMessage(encodeStageMessage(msg))).toEqual(msg);
  });

  it("必須フィールドが欠けた chat は null", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: "chat", id: "x", senderIdentity: "s1" }),
    );
    expect(decodeStageMessage(bytes)).toBeNull();
  });
});

describe("banner-show / banner-hide (Phase 3: バナー)", () => {
  it("banner-show が往復する", () => {
    const msg: BannerShowMessage = {
      type: "banner-show",
      text: "ゲスト: 田中太郎",
      subtext: "プロダクトマネージャー",
      position: "bottom",
      autoHideMs: 5000,
    };
    expect(decodeStageMessage(encodeStageMessage(msg))).toEqual(msg);
  });

  it("subtext/autoHideMs 省略でも往復する", () => {
    const msg: BannerShowMessage = {
      type: "banner-show",
      text: "お知らせ",
      position: "top",
    };
    expect(decodeStageMessage(encodeStageMessage(msg))).toEqual(msg);
  });

  it("banner-hide が往復する", () => {
    const msg: BannerHideMessage = { type: "banner-hide" };
    expect(decodeStageMessage(encodeStageMessage(msg))).toEqual(msg);
  });

  it("text が無い banner-show は null", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: "banner-show", position: "bottom" }),
    );
    expect(decodeStageMessage(bytes)).toBeNull();
  });

  it("position が不正な banner-show は null", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: "banner-show", text: "test", position: "center" }),
    );
    expect(decodeStageMessage(bytes)).toBeNull();
  });
});

describe("overlay-show / overlay-hide (Phase 4: QRコード/ムービー)", () => {
  it("overlay-show が往復する", () => {
    const msg: OverlayShowMessage = {
      type: "overlay-show",
      kind: "qr",
      url: "https://cdn.example.com/qr.png",
      position: "bottom-right",
      sizePercent: 15,
      autoHideMs: 10000,
    };
    expect(decodeStageMessage(encodeStageMessage(msg))).toEqual(msg);
  });

  it("video 種別 + sizePercent 省略でも往復する", () => {
    const msg: OverlayShowMessage = {
      type: "overlay-show",
      kind: "video",
      url: "https://cdn.example.com/promo.mp4",
      position: "top-left",
    };
    expect(decodeStageMessage(encodeStageMessage(msg))).toEqual(msg);
  });

  it("overlay-hide が往復する", () => {
    const msg: OverlayHideMessage = { type: "overlay-hide" };
    expect(decodeStageMessage(encodeStageMessage(msg))).toEqual(msg);
  });

  it("url が無い overlay-show は null", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: "overlay-show", kind: "qr", position: "top-right" }),
    );
    expect(decodeStageMessage(bytes)).toBeNull();
  });

  it("kind が不正な overlay-show は null", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: "overlay-show", kind: "audio", url: "x", position: "top-left" }),
    );
    expect(decodeStageMessage(bytes)).toBeNull();
  });

  it("position が不正な overlay-show は null", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: "overlay-show", kind: "image", url: "x", position: "center" }),
    );
    expect(decodeStageMessage(bytes)).toBeNull();
  });
});
