import { describe, expect, it } from "vitest";
import { CaptionConnectionHub } from "./caption-hub.js";
import { attachConnection, parseConnectionQuery, type WebSocketLike } from "./ws-server.js";

class FakeSocket implements WebSocketLike {
  readonly sent: string[] = [];
  closed = false;
  private handlers: Record<string, (data: unknown) => void> = {};
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  on(event: "message" | "close", handler: (data: unknown) => void): void {
    this.handlers[event] = handler;
  }
  emitMessage(data: unknown): void {
    this.handlers.message?.(data);
  }
  emitClose(): void {
    this.handlers.close?.(undefined);
  }
  parsedSent(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

describe("ws-server transport (DESIGN.md 6.3.2, 9.1)", () => {
  it("parses token and initial languages from the connection URL", () => {
    expect(parseConnectionQuery("/?token=abc&lang=ja,en")).toEqual({
      token: "abc",
      languages: ["ja", "en"],
    });
    expect(parseConnectionQuery("/")).toEqual({ token: undefined, languages: undefined });
  });

  it("bridges a socket to the hub: welcome, initial subscribe, then live captions", () => {
    const hub = new CaptionConnectionHub({ supportedLanguages: ["ja", "en"] });
    const socket = new FakeSocket();
    attachConnection(hub, socket, { id: "c1", languages: ["en"] });

    // welcome を受信
    expect(socket.parsedSent()[0]).toMatchObject({ type: "welcome" });

    // 初期購読 en のみ配信される
    hub.broadcast({
      v: 1,
      type: "caption",
      language: "ja",
      text: "x",
      startMs: 0,
      endMs: 1,
      final: true,
    });
    hub.broadcast({
      v: 1,
      type: "caption",
      language: "en",
      text: "Hello",
      startMs: 0,
      endMs: 1,
      final: true,
    });
    const captions = socket.parsedSent().filter((m): m is { type: string; text: string } => {
      return (m as { type?: string }).type === "caption";
    });
    expect(captions.map((c) => c.text)).toEqual(["Hello"]);
  });

  it("forwards client messages and removes the connection on close", () => {
    const hub = new CaptionConnectionHub({ supportedLanguages: ["ja", "en"] });
    const socket = new FakeSocket();
    attachConnection(hub, socket, { id: "c1" });

    socket.emitMessage(JSON.stringify({ action: "ping" }));
    expect(socket.parsedSent().some((m) => (m as { type?: string }).type === "pong")).toBe(true);

    expect(hub.connectionCount).toBe(1);
    socket.emitClose();
    expect(hub.connectionCount).toBe(0);
  });

  it("rejects unauthorized connections (no subscription, socket closed)", () => {
    const hub = new CaptionConnectionHub({
      supportedLanguages: ["ja"],
      authorize: (t) => t === "secret",
    });
    const socket = new FakeSocket();
    const id = attachConnection(hub, socket, { id: "c1", token: "wrong" });
    expect(id).toBeUndefined();
    expect(socket.closed).toBe(true);
    expect(hub.connectionCount).toBe(0);
  });
});
