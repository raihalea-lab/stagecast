import { describe, expect, it } from "vitest";
import { decodeStageMessage } from "@stagecast/shared";
import { StageController } from "./stage-controller.js";
import { FakeRoomConnector, type ParticipantSnapshot } from "./lib/room.js";
import type {
  JoinResponse,
  PresentationSnapshot,
  SlideStateUpdate,
  StageClient,
} from "./api/stage-client.js";
import type { SpeakerVisibility } from "@stagecast/shared";

/** identity だけが意味を持つテスト用の participant。 */
const p = (identity: string): ParticipantSnapshot => ({
  identity,
  isTalking: false,
  isMuted: false,
  isScreenSharing: false,
});

class FakeStageClient implements StageClient {
  readonly visibilityCalls: { eventId: string; speakerId: string; visibility: string }[] = [];
  constructor(private readonly response: JoinResponse) {}
  async join(): Promise<JoinResponse> {
    return this.response;
  }
  async issuePreviewToken() {
    return {
      livekitUrl: "wss://sfu.test",
      livekitToken: "preview.token.fake",
      identity: "preview-fake",
      room: "evt-1",
    };
  }
  async setSpeakerVisibility(
    _inviteToken: string,
    eventId: string,
    speakerId: string,
    visibility: SpeakerVisibility,
  ): Promise<void> {
    this.visibilityCalls.push({ eventId, speakerId, visibility });
  }
  /** ADR 0022 D-1: 投影状態はサーバーが持つ。フェイクはメモリに置く。 */
  presentation: PresentationSnapshot = { eventId: "evt-1", speakers: [] };
  async getPresentationState(): Promise<PresentationSnapshot> {
    return this.presentation;
  }
  async setSlideState(
    _inviteToken: string,
    update: SlideStateUpdate,
  ): Promise<PresentationSnapshot> {
    this.presentation = { ...this.presentation, ...update };
    return this.presentation;
  }
  async listAssets() {
    return [];
  }
  async getAssetDownloadUrl() {
    return "https://fake-download-url";
  }
  async listPresets() {
    return [];
  }
  async createPreset(_t: string, label: string, config: unknown) {
    return {
      presetId: "fake-id",
      eventId: "evt-1",
      config: config as import("@stagecast/shared").Preset["config"],
      label,
      sortOrder: 0,
      createdAt: new Date().toISOString(),
    };
  }
  async deletePreset() {}
  async getMaterialUploadUrl() {
    return { assetId: "deck-1", key: "assets/decks/evt-1/deck-1.pdf", uploadUrl: "https://put" };
  }
  async getMaterialDownloadUrl() {
    return "https://signed/deck.pdf";
  }
}

const speakerJoin: JoinResponse = {
  ok: true,
  eventId: "evt-1",
  role: "speaker",
  room: "evt-1",
  identity: "speaker-1",
  livekitUrl: "wss://sfu.test",
  livekitToken: "jwt.token.here",
};

describe("StageController (DESIGN.md 4.1, F-1, F-3)", () => {
  it("joins and connects to the SFU with the minted token", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);

    const res = await ctrl.join("token", "Alice");
    expect(res.ok).toBe(true);
    expect(room.state).toBe("connected");
    expect(room.calls).toContain("connect:wss://sfu.test");
    expect(ctrl.currentSession?.canPublish).toBe(true);
  });

  it("lets a speaker publish camera/mic/screen-share (F-3)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    await ctrl.join("token");

    await ctrl.toggleMic(true);
    await ctrl.toggleCamera(true);
    await ctrl.toggleScreenShare(true);
    expect(room.mic && room.camera && room.screenShare).toBe(true);
  });

  it("broadcasts slide page changes for uploaded decks (5.2)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    await ctrl.join("token");
    ctrl.setDeck(3);

    expect(await ctrl.slideNext()).toBe(2);
    expect(await ctrl.slideNext()).toBe(3);
    expect(await ctrl.slideNext()).toBe(3); // 上限でクランプ
    expect(room.slides.map((s) => s.page)).toEqual([2, 3, 3]);
    expect(room.slides[0]?.type).toBe("slide-page");
  });

  it("setDeckUrl は slide-deck メッセージを DataChannel に送信する (F-3, 5.2)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    await ctrl.join("token");
    await ctrl.setDeckUrl("https://signed/deck.pdf");
    expect(room.publishedData).toHaveLength(1);
    const msg = decodeStageMessage(room.publishedData[0]!);
    expect(msg).toEqual({ type: "slide-deck", url: "https://signed/deck.pdf", totalPages: 1 });
  });

  it("setDeck で入れた総ページ数は setDeckUrl 後も維持される (F-3, 5.2)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    await ctrl.join("token");
    // stage-web は pdf.js で総ページ数を解決してから deck URL を配る (App.tsx handleUploadDeck)。
    ctrl.setDeck(4);
    await ctrl.setDeckUrl("https://signed/deck.pdf");
    expect(ctrl.slideDeck).toEqual({ page: 1, totalPages: 4 });
    expect(await ctrl.slideNext()).toBe(2);
  });

  it("hideDeck は slide-hide を broadcast して投影状態を捨てる (F-3, 5.2)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    await ctrl.join("token");
    ctrl.setDeck(3);
    await ctrl.setDeckUrl("https://signed/deck.pdf");
    await ctrl.hideDeck();
    expect(decodeStageMessage(room.publishedData.at(-1)!)).toEqual({ type: "slide-hide" });
    expect(ctrl.slideDeck).toEqual({ page: 1, totalPages: 1 });
  });

  it("republishDeck は後から来た participant 向けに URL と現在ページを配り直す (F-3, 5.2)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    await ctrl.join("token");
    ctrl.setDeck(3);
    await ctrl.setDeckUrl("https://signed/deck.pdf");
    expect(await ctrl.slideNext()).toBe(2);

    await ctrl.republishDeck("https://signed/deck.pdf?renewed");
    expect(decodeStageMessage(room.publishedData.at(-1)!)).toEqual({
      type: "slide-deck",
      url: "https://signed/deck.pdf?renewed",
      totalPages: 3,
    });
    // composer は slide-deck で 1 ページ目に戻るので、現在ページを追送する。
    expect(room.slides.at(-1)).toEqual({ type: "slide-page", page: 2 });
    expect(ctrl.slideDeck).toEqual({ page: 2, totalPages: 3 });
  });

  it("onParticipantsChanged は新しく入室した identity だけを joined で渡す (F-3, 5.2)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    await ctrl.join("token");
    const seen: string[][] = [];
    ctrl.onParticipantsChanged((_participants, joined) => seen.push(joined));

    room.emitParticipantsChanged([p("moderator"), p("speaker-1")]);
    room.emitParticipantsChanged([p("moderator"), p("speaker-1"), p("composer-preview")]);
    // 退出しただけの変化では joined は空になる。
    room.emitParticipantsChanged([p("moderator"), p("composer-preview")]);
    expect(seen).toEqual([["moderator", "speaker-1"], ["composer-preview"], []]);

    // 切断後に入り直したら全員を新規として扱う (既知セットが残っていると配り直せない)。
    ctrl.onDisconnected(() => {});
    room.emitDisconnect();
    room.emitParticipantsChanged([p("moderator")]);
    expect(seen.at(-1)).toEqual(["moderator"]);
  });

  it("applyRemotePage は publish せずに自分のデッキ位置だけ同期する (F-3, 5.2)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    await ctrl.join("token");
    ctrl.setDeck(13);

    // 他のクライアントが 5 ページ目に送った、という受信を再現する。
    expect(ctrl.applyRemotePage(5)).toBe(5);
    expect(room.slides).toHaveLength(0);
    expect(room.publishedData).toHaveLength(0);

    // 同期後の「次へ」は 6 ページ目から続く (同期しないと 2 に戻ってしまう)。
    expect(await ctrl.slideNext()).toBe(6);
    // 総ページ数を超える指定は最終ページに丸める。
    expect(ctrl.applyRemotePage(99)).toBe(13);
  });

  it("1 ページ目を投影中の republishDeck は余計な slide-page を送らない (F-3, 5.2)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    await ctrl.join("token");
    ctrl.setDeck(3);
    await ctrl.setDeckUrl("https://signed/deck.pdf");
    await ctrl.republishDeck("https://signed/deck.pdf?renewed");
    expect(room.slides).toHaveLength(0);
  });

  it("新しいデッキを入れるとページは 1 に戻る (F-3, 5.2)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    await ctrl.join("token");
    ctrl.setDeck(4);
    expect(await ctrl.slideNext()).toBe(2);
    ctrl.setDeck(2);
    await ctrl.setDeckUrl("https://signed/deck2.pdf");
    expect(ctrl.slideDeck).toEqual({ page: 1, totalPages: 2 });
  });

  it("allows a moderator to publish (D8: 進行補助 + メディア制御)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(
      new FakeStageClient({ ...speakerJoin, role: "moderator", identity: "moderator-1" }),
      room,
    );
    await ctrl.join("token");
    expect(ctrl.currentSession?.canPublish).toBe(true);
    await ctrl.toggleCamera(true);
    expect(room.calls).toContain("camera:true");
  });

  it("surfaces a failed join (invalid token) without connecting", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient({ ok: false, reason: "revoked" }), room);
    const res = await ctrl.join("bad");
    expect(res.ok).toBe(false);
    expect(room.state).toBe("idle");
    expect(ctrl.currentSession).toBeUndefined();
  });

  it("入室前に選んだデバイスを room に伝える (N7)", () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    ctrl.setPreferredDevices({ microphoneId: "mic-2", cameraId: "cam-1" });
    expect(room.preferredDevices).toEqual({ microphoneId: "mic-2", cameraId: "cam-1" });
  });

  it("SFU 切断でセッションを無効化し onDisconnected を呼ぶ", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    let notified = false;
    ctrl.onDisconnected(() => {
      notified = true;
    });
    await ctrl.join("t");
    expect(ctrl.currentSession).toBeDefined();
    room.emitDisconnect();
    expect(notified).toBe(true);
    expect(ctrl.currentSession).toBeUndefined();
  });

  it("一時的な再接続ではセッションを保ち onReconnecting/onReconnected を呼ぶ", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    const events: string[] = [];
    ctrl.onReconnecting(() => events.push("reconnecting"));
    ctrl.onReconnected(() => events.push("reconnected"));
    await ctrl.join("t");

    room.emitReconnecting();
    expect(ctrl.currentSession).toBeDefined(); // セッションは維持される
    room.emitReconnected();
    expect(ctrl.currentSession).toBeDefined();
    expect(events).toEqual(["reconnecting", "reconnected"]);
  });

  it("連打 (同時 join) でも SFU 接続は 1 回 (in-flight 共有)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    const [a, b] = await Promise.all([ctrl.join("t"), ctrl.join("t")]);
    expect(a.ok && b.ok).toBe(true);
    expect(room.calls.filter((c) => c.startsWith("connect:"))).toHaveLength(1);
  });

  it("入室済みなら再 join で再接続しない", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    await ctrl.join("t");
    await ctrl.join("t");
    expect(room.calls.filter((c) => c.startsWith("connect:"))).toHaveLength(1);
  });

  it("leave は冪等: 二重退室で disconnect を重ねず、未入室では何もしない", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    // 未入室で leave しても disconnect を呼ばない。
    await ctrl.leave();
    expect(room.calls.filter((c) => c === "disconnect")).toHaveLength(0);

    await ctrl.join("t");
    await ctrl.leave();
    await ctrl.leave(); // 二重退室
    expect(room.calls.filter((c) => c === "disconnect")).toHaveLength(1);
    expect(ctrl.currentSession).toBeUndefined();
  });

  it("切断後は再 join で再接続できる", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    ctrl.onDisconnected(() => {});
    await ctrl.join("t");
    room.emitDisconnect();
    await ctrl.join("t");
    expect(room.calls.filter((c) => c.startsWith("connect:"))).toHaveLength(2);
  });

  it("forceMute は force-mute メッセージを DataChannel に送信する (Phase 1)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    await ctrl.join("token");
    await ctrl.forceMute("speaker-abc");
    expect(room.publishedData).toHaveLength(1);
    const msg = decodeStageMessage(room.publishedData[0]!);
    expect(msg).toEqual({ type: "force-mute", targetIdentity: "speaker-abc" });
    // 対象者にだけ届ける (broadcast だと全員が自分をミュートする)。
    expect(room.publishedDestinations[0]).toEqual(["speaker-abc"]);
  });

  it("setSpeakerVisibility は REST API + DataChannel の両方を呼ぶ (Phase 1)", async () => {
    const client = new FakeStageClient(speakerJoin);
    const room = new FakeRoomConnector();
    const ctrl = new StageController(client, room);
    await ctrl.join("token");
    await ctrl.setSpeakerVisibility("speaker-1", "standby", "invite-token");
    expect(client.visibilityCalls).toEqual([
      { eventId: "evt-1", speakerId: "speaker-1", visibility: "standby" },
    ]);
    expect(room.publishedData).toHaveLength(1);
    const msg = decodeStageMessage(room.publishedData[0]!);
    expect(msg).toEqual({
      type: "visibility-change",
      speakerId: "speaker-1",
      visibility: "standby",
    });
  });

  it("setSpeakerVisibility で inviteToken なしなら REST API を呼ばず DataChannel のみ (Phase 1)", async () => {
    const client = new FakeStageClient(speakerJoin);
    const room = new FakeRoomConnector();
    const ctrl = new StageController(client, room);
    await ctrl.join("token");
    await ctrl.setSpeakerVisibility("speaker-2", "live");
    expect(client.visibilityCalls).toHaveLength(0);
    expect(room.publishedData).toHaveLength(1);
  });

  it("sendChat は chat メッセージを DataChannel に broadcast する (Phase 2)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(new FakeStageClient(speakerJoin), room);
    await ctrl.join("token");
    await ctrl.sendChat("こんにちは", "Alice");
    expect(room.publishedData).toHaveLength(1);
    const msg = decodeStageMessage(room.publishedData[0]!);
    expect(msg).not.toBeNull();
    expect(msg?.type).toBe("chat");
    if (msg?.type === "chat") {
      expect(msg.senderIdentity).toBe("speaker-1");
      expect(msg.senderName).toBe("Alice");
      expect(msg.text).toBe("こんにちは");
      expect(msg.id).toBeTruthy();
      expect(msg.timestampMs).toBeGreaterThan(0);
    }
  });
});

describe("StageController.localIdentity", () => {
  it("接続後の自分の identity を room から返す", async () => {
    const room = new FakeRoomConnector();
    const controller = new StageController(new FakeStageClient(speakerJoin), room);
    expect(controller.localIdentity).toBeUndefined();

    // admin は identity をサーバが uuid 付きで決めるので、URL からは導出できない。
    room.localIdentity = "admin-user-1-abcdef";
    await controller.connectAdmin("wss://x", "lk-token", "evt-1");

    expect(controller.localIdentity).toBe("admin-user-1-abcdef");
  });
});
