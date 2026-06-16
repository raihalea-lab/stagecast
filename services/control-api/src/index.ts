/**
 * Lambda エントリ (API Gateway HTTP API v2 アダプタ)。
 *
 * cold start で `buildControlApiFromEnv` を 1 回だけ実行し、招待トークン秘密や LiveKit
 * 鍵を Secrets Manager から取得する (T5/T7, ADR D-10)。warm 中はキャッシュして使い回す。
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { buildControlApiFromEnv } from "./lambda.js";
import type { App, HttpRequest } from "./http/app.js";

export * from "./http/app.js";
export * from "./factory.js";
export * from "./lambda.js";
export * from "./usecases/events.js";
export * from "./usecases/invites.js";
export * from "./usecases/presentation.js";
export * from "./usecases/join.js";
export * from "./usecases/settings.js";
export * from "./auth/livekit-minter.js";
export * from "./assets/asset-upload.js";
export * from "./invite/token.js";
export * from "./auth/admin-auth.js";
export * from "./repo/types.js";
export * from "./repo/memory.js";
export * from "./repo/dynamo-mapper.js";
export * from "./repo/dynamo.js";

let appPromise: Promise<App> | undefined;

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  appPromise ??= buildControlApiFromEnv();
  const app = await appPromise;
  const req: HttpRequest = {
    method: event.requestContext.http.method,
    path: event.rawPath,
    headers: event.headers,
    body: event.body ? safeJson(event.body) : undefined,
  };
  const res = await app.handle(req);
  return {
    statusCode: res.status,
    headers: { "content-type": "application/json" },
    body: res.body === null ? "" : JSON.stringify(res.body),
  };
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
