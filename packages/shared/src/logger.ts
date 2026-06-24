/**
 * 構造化ログ (N3)。
 *
 * CloudWatch Logs Insights で `eventId` / `component` などで絞り込めるよう、1 行 1 JSON で
 * 出力する軽量ロガー。pino を使わない理由: Lambda/Fargate のバンドルを軽く保ちたいこと、
 * フロントを含む全層で同じ型を共有する `@stagecast/shared` に node 専用依存を持ち込みたくない
 * こと。出力は `console` 経由なのでブラウザ/Node の双方で動く。
 *
 * 使い方:
 *   const log = createLogger({ component: "caption-worker", eventId });
 *   log.info("started", { wsPort });
 *   log.error("pushAudio failed", { err });
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** ログ行に常に付与する文脈 (component / eventId 等)。 */
export type LogBindings = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogBindings): void;
  info(msg: string, fields?: LogBindings): void;
  warn(msg: string, fields?: LogBindings): void;
  error(msg: string, fields?: LogBindings): void;
  /** 追加の束縛を足した子ロガーを返す (元のロガーは変更しない)。 */
  child(bindings: LogBindings): Logger;
}

/** 環境変数 LOG_LEVEL を node/ブラウザ非依存に読む (未設定なら info)。 */
function resolveLevel(explicit?: LogLevel): LogLevel {
  if (explicit) return explicit;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const raw = env?.LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return "info";
}

/** Error を JSON 化可能な形へ正規化する (message/stack を残す)。 */
function normalize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/** ブラウザ/Node の双方で使える console を型安全に取得する (shared は node/dom 非依存)。 */
type ConsoleLike = {
  log(line: string): void;
  warn(line: string): void;
  error(line: string): void;
};
function getConsole(): ConsoleLike | undefined {
  return (globalThis as { console?: ConsoleLike }).console;
}

function emit(level: LogLevel, bindings: LogBindings, msg: string, fields?: LogBindings): void {
  const record: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    msg,
    ...bindings,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) record[k] = normalize(v);
  }
  const c = getConsole();
  if (!c) return;
  // level に応じて適切な console メソッドへ (CloudWatch では stream が分かれる)。
  const line = JSON.stringify(record);
  if (level === "error") c.error(line);
  else if (level === "warn") c.warn(line);
  else c.log(line);
}

export interface CreateLoggerOptions {
  /** 最小出力レベル (未指定なら LOG_LEVEL 環境変数、なければ info)。 */
  level?: LogLevel;
}

export function createLogger(
  bindings: LogBindings = {},
  options: CreateLoggerOptions = {},
): Logger {
  const min = LEVEL_ORDER[resolveLevel(options.level)];
  const make = (level: LogLevel) => (msg: string, fields?: LogBindings) => {
    if (LEVEL_ORDER[level] >= min) emit(level, bindings, msg, fields);
  };
  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    child(extra: LogBindings): Logger {
      return createLogger({ ...bindings, ...extra }, options);
    },
  };
}
