/**
 * Lambda エントリ (API Gateway HTTP API v2 アダプタ)。
 * フェーズ1の CDK プレースホルダはフェーズ2でこのハンドラ資産に差し替える。
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { buildControlApi } from './factory.js';
import type { HttpRequest } from './http/app.js';

export * from './http/app.js';
export * from './factory.js';
export * from './usecases/events.js';
export * from './usecases/invites.js';
export * from './usecases/presentation.js';
export * from './invite/token.js';
export * from './auth/admin-auth.js';
export * from './repo/types.js';
export * from './repo/memory.js';

const app = buildControlApi();

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const req: HttpRequest = {
    method: event.requestContext.http.method,
    path: event.rawPath,
    headers: event.headers,
    body: event.body ? safeJson(event.body) : undefined,
  };
  const res = await app.handle(req);
  return {
    statusCode: res.status,
    headers: { 'content-type': 'application/json' },
    body: res.body === null ? '' : JSON.stringify(res.body),
  };
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
