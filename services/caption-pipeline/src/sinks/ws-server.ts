/**
 * 独自字幕配信 API の WebSocket トランスポート (DESIGN.md 6.3.2, 9.1)。
 *
 * CaptionConnectionHub を WebSocket 上に載せる。接続ごとに ws を CaptionStreamConnection に
 * 橋渡しし、メッセージ/切断をハブへ転送する。プロトコル本体はハブ側にあり、本モジュールは
 * トランスポートのみを担う。視聴ページは利用側が実装する。
 *
 * 接続は `wss://.../?token=...&lang=ja,en` を想定 (token は任意認証, lang は初期購読)。
 */
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { LanguageCode } from '@stagecast/shared';
import type { CaptionConnectionHub, ServerMessage } from './caption-hub.js';

/** ws の最小サブセット (テストで fake を渡せるよう抽象化)。 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  on(event: 'message', handler: (data: unknown) => void): void;
  on(event: 'close', handler: () => void): void;
}

let connectionSeq = 0;

/** 1 本の WebSocket をハブに接続する。初期購読言語があれば即 subscribe する。 */
export function attachConnection(
  hub: CaptionConnectionHub,
  socket: WebSocketLike,
  opts: { id?: string; token?: string; languages?: LanguageCode[] } = {},
): string | undefined {
  const id = opts.id ?? `ws-${++connectionSeq}`;
  const conn = {
    id,
    send: (message: ServerMessage) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
  if (!hub.addConnection(conn, opts.token)) return undefined;
  if (opts.languages?.length) {
    hub.handleMessage(id, { action: 'subscribe', languages: opts.languages });
  }
  socket.on('message', (data: unknown) => {
    hub.handleMessage(id, typeof data === 'string' ? data : String(data));
  });
  socket.on('close', () => hub.removeConnection(id));
  return id;
}

/** クエリ文字列から token と初期購読言語を取り出す。 */
export function parseConnectionQuery(url: string | undefined): {
  token?: string;
  languages?: LanguageCode[];
} {
  const params = new URL(url ?? '', 'http://localhost').searchParams;
  const token = params.get('token') ?? undefined;
  const langParam = params.get('lang');
  const languages = langParam
    ? (langParam.split(',').filter((l) => l) as LanguageCode[])
    : undefined;
  return { token, languages };
}

export class WebSocketCaptionServer {
  private wss?: WebSocketServer;

  constructor(
    private readonly hub: CaptionConnectionHub,
    private readonly options: { port: number },
  ) {}

  /** サーバを起動し、listen 開始で解決する (port:0 でエフェメラルポート)。 */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.options.port });
      this.wss.on('connection', (socket, req: IncomingMessage) => {
        const { token, languages } = parseConnectionQuery(req.url);
        attachConnection(this.hub, socket as unknown as WebSocketLike, { token, languages });
      });
      this.wss.on('listening', () => resolve());
    });
  }

  /** 実際に listen しているポート番号 (未起動なら undefined)。 */
  get port(): number | undefined {
    const addr = this.wss?.address();
    return typeof addr === 'object' && addr !== null ? addr.port : undefined;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.wss) this.wss.close(() => resolve());
      else resolve();
    });
  }
}
