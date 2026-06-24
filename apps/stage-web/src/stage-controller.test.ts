import { describe, expect, it } from "vitest";
import { StageController } from "./stage-controller.js";
import { FakeRoomConnector } from "./lib/room.js";
import type { JoinResponse, StageClient } from "./api/stage-client.js";

class FakeStageClient implements StageClient {
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
  });

  it("forbids a moderator from publishing (進行補助のみ)", async () => {
    const room = new FakeRoomConnector();
    const ctrl = new StageController(
      new FakeStageClient({ ...speakerJoin, role: "moderator", identity: "moderator-1" }),
      room,
    );
    await ctrl.join("token");
    expect(ctrl.currentSession?.canPublish).toBe(false);
    await expect(ctrl.toggleCamera(true)).rejects.toThrow(/cannot publish/);
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
});
