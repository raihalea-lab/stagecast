/**
 * 独自字幕配信 API のプロトコル実装 (DESIGN.md 6.3.2, 2.3, F-11, 9.1)。
 *
 * 接続中クライアントへ字幕を配るトランスポート非依存のハブ。WebSocket / SSE サーバは
 * CaptionStreamConnection を実装して addConnection するだけでよい。提供範囲はプロトコル
 * (メッセージスキーマ・購読・再接続時の追いつき・認証) で、視聴ページは利用側が実装する。
 *
 * プロトコル (v1):
 *  - クライアント→サーバ: { action:'subscribe', languages } / { action:'unsubscribe', languages? } /
 *    { action:'ping' }
 *  - サーバ→クライアント: welcome / caption / pong / error
 *  - 再接続: クライアントは再接続後に再 subscribe する。subscribe 時に直近の確定字幕を
 *    バックログから再送して追いつきを助ける。
 *  - 認証: 接続時に任意のトークン検証を行う (未設定なら誰でも可)。
 */
import type { LanguageCode } from "@stagecast/shared";
import type { CaptionStreamMessage, CaptionBroadcaster } from "./custom-api-sink.js";

export interface WelcomeMessage {
  v: 1;
  type: "welcome";
  protocol: "stagecast-captions";
  supportedLanguages: LanguageCode[];
}
export interface PongMessage {
  v: 1;
  type: "pong";
}
export interface ErrorMessage {
  v: 1;
  type: "error";
  message: string;
}
export type ServerMessage = CaptionStreamMessage | WelcomeMessage | PongMessage | ErrorMessage;

export type ClientMessage =
  | { action: "subscribe"; languages: LanguageCode[] }
  | { action: "unsubscribe"; languages?: LanguageCode[] }
  | { action: "ping" };

/** トランスポート (WS/SSE) が実装する 1 接続の抽象。 */
export interface CaptionStreamConnection {
  readonly id: string;
  send(message: ServerMessage): void;
  close(): void;
}

/** クライアントから受信した生メッセージを検証付きでパースする。 */
export function parseClientMessage(raw: unknown): ClientMessage | undefined {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (typeof obj !== "object" || obj === null) return undefined;
  const m = obj as Record<string, unknown>;
  if (m.action === "ping") return { action: "ping" };
  if (m.action === "subscribe" && Array.isArray(m.languages)) {
    return { action: "subscribe", languages: m.languages as LanguageCode[] };
  }
  if (m.action === "unsubscribe") {
    return { action: "unsubscribe", languages: m.languages as LanguageCode[] | undefined };
  }
  return undefined;
}

export interface CaptionHubConfig {
  supportedLanguages: LanguageCode[];
  /** 接続認証 (任意)。false を返すと接続を閉じる。 */
  authorize?: (token: string | undefined) => boolean;
  /** 言語ごとに保持する直近の確定字幕数 (再接続時の追いつき用)。 */
  backlogSize?: number;
}

interface Subscriber {
  conn: CaptionStreamConnection;
  languages: Set<LanguageCode>;
}

export class CaptionConnectionHub {
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly backlog = new Map<LanguageCode, CaptionStreamMessage[]>();
  private readonly backlogSize: number;

  constructor(private readonly config: CaptionHubConfig) {
    this.backlogSize = config.backlogSize ?? 20;
  }

  get connectionCount(): number {
    return this.subscribers.size;
  }

  /** 接続を受け入れる。認証 NG なら error を送って閉じ false を返す。 */
  addConnection(conn: CaptionStreamConnection, token?: string): boolean {
    if (this.config.authorize && !this.config.authorize(token)) {
      conn.send({ v: 1, type: "error", message: "unauthorized" });
      conn.close();
      return false;
    }
    this.subscribers.set(conn.id, { conn, languages: new Set() });
    conn.send({
      v: 1,
      type: "welcome",
      protocol: "stagecast-captions",
      supportedLanguages: this.config.supportedLanguages,
    });
    return true;
  }

  removeConnection(id: string): void {
    this.subscribers.delete(id);
  }

  /** クライアントメッセージを処理する。 */
  handleMessage(id: string, raw: unknown): void {
    const sub = this.subscribers.get(id);
    if (!sub) return;
    const msg = parseClientMessage(raw);
    if (!msg) {
      sub.conn.send({ v: 1, type: "error", message: "malformed message" });
      return;
    }
    if (msg.action === "ping") {
      sub.conn.send({ v: 1, type: "pong" });
      return;
    }
    if (msg.action === "subscribe") {
      for (const lang of msg.languages) {
        if (!this.config.supportedLanguages.includes(lang)) continue;
        sub.languages.add(lang);
        // 再接続時の追いつき: バックログを再送する。
        for (const past of this.backlog.get(lang) ?? []) sub.conn.send(past);
      }
      return;
    }
    if (msg.action === "unsubscribe") {
      if (!msg.languages) sub.languages.clear();
      else for (const lang of msg.languages) sub.languages.delete(lang);
    }
  }

  /** 字幕メッセージを購読言語に応じて配信し、確定字幕はバックログに蓄える。 */
  broadcast(message: CaptionStreamMessage): void {
    if (message.final) this.appendBacklog(message);
    for (const sub of this.subscribers.values()) {
      if (sub.languages.has(message.language)) sub.conn.send(message);
    }
  }

  private appendBacklog(message: CaptionStreamMessage): void {
    const list = this.backlog.get(message.language) ?? [];
    list.push(message);
    if (list.length > this.backlogSize) list.shift();
    this.backlog.set(message.language, list);
  }
}

/** CaptionConnectionHub を CustomCaptionApiSink の出力先に繋ぐ Broadcaster。 */
export class HubCaptionBroadcaster implements CaptionBroadcaster {
  constructor(private readonly hub: CaptionConnectionHub) {}
  async broadcast(message: CaptionStreamMessage): Promise<void> {
    this.hub.broadcast(message);
  }
}
