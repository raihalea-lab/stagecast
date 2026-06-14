import { describe, expect, it } from "vitest";
import type { CaptionStreamMessage } from "./custom-api-sink.js";
import {
  CaptionConnectionHub,
  parseClientMessage,
  type CaptionStreamConnection,
  type ServerMessage,
} from "./caption-hub.js";

class FakeConnection implements CaptionStreamConnection {
  readonly received: ServerMessage[] = [];
  closed = false;
  constructor(readonly id: string) {}
  send(message: ServerMessage): void {
    this.received.push(message);
  }
  close(): void {
    this.closed = true;
  }
  captions(): CaptionStreamMessage[] {
    return this.received.filter((m): m is CaptionStreamMessage => m.type === "caption");
  }
}

function caption(language: "ja" | "en", text: string, final = true): CaptionStreamMessage {
  return { v: 1, type: "caption", language, text, startMs: 0, endMs: 1, final };
}

describe("CaptionConnectionHub protocol (DESIGN.md 6.3.2, 9.1)", () => {
  const cfg = { supportedLanguages: ["ja", "en"] as const };

  it("sends a welcome with supported languages on connect", () => {
    const hub = new CaptionConnectionHub({ ...cfg });
    const c = new FakeConnection("c1");
    hub.addConnection(c);
    expect(c.received[0]).toMatchObject({ type: "welcome", protocol: "stagecast-captions" });
  });

  it("only delivers subscribed languages", () => {
    const hub = new CaptionConnectionHub({ ...cfg });
    const c = new FakeConnection("c1");
    hub.addConnection(c);
    hub.handleMessage("c1", { action: "subscribe", languages: ["en"] });

    hub.broadcast(caption("ja", "こんにちは"));
    hub.broadcast(caption("en", "Hello"));
    expect(c.captions().map((m) => m.text)).toEqual(["Hello"]);
  });

  it("replays recent finals to a (re)subscribing client for catch-up", () => {
    const hub = new CaptionConnectionHub({ ...cfg });
    // 配信が先行して進む
    hub.broadcast(caption("ja", "一"));
    hub.broadcast(caption("ja", "二"));
    hub.broadcast(caption("ja", "暫定", false)); // 暫定はバックログに残さない

    // 後から接続して購読 → 確定分を追いつき受信
    const late = new FakeConnection("late");
    hub.addConnection(late);
    hub.handleMessage("late", { action: "subscribe", languages: ["ja"] });
    expect(late.captions().map((m) => m.text)).toEqual(["一", "二"]);
  });

  it("answers ping with pong and rejects malformed messages", () => {
    const hub = new CaptionConnectionHub({ ...cfg });
    const c = new FakeConnection("c1");
    hub.addConnection(c);
    hub.handleMessage("c1", { action: "ping" });
    hub.handleMessage("c1", { nonsense: true });
    expect(c.received.some((m) => m.type === "pong")).toBe(true);
    expect(c.received.some((m) => m.type === "error")).toBe(true);
  });

  it("unsubscribe stops delivery", () => {
    const hub = new CaptionConnectionHub({ ...cfg });
    const c = new FakeConnection("c1");
    hub.addConnection(c);
    hub.handleMessage("c1", { action: "subscribe", languages: ["ja", "en"] });
    hub.handleMessage("c1", { action: "unsubscribe", languages: ["ja"] });
    hub.broadcast(caption("ja", "x"));
    hub.broadcast(caption("en", "y"));
    expect(c.captions().map((m) => m.text)).toEqual(["y"]);
  });

  it("rejects unauthorized connections", () => {
    const hub = new CaptionConnectionHub({ ...cfg, authorize: (t) => t === "secret" });
    const bad = new FakeConnection("bad");
    const ok = hub.addConnection(bad, "wrong");
    expect(ok).toBe(false);
    expect(bad.closed).toBe(true);
    expect(hub.connectionCount).toBe(0);
  });

  it("parseClientMessage accepts JSON strings and objects", () => {
    expect(parseClientMessage('{"action":"ping"}')).toEqual({ action: "ping" });
    expect(parseClientMessage({ action: "subscribe", languages: ["ja"] })).toEqual({
      action: "subscribe",
      languages: ["ja"],
    });
    expect(parseClientMessage("not json")).toBeUndefined();
  });
});
