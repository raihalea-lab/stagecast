/**
 * 公開ルート一覧 (`packages/shared/public-routes.json`) と実装の突き合わせ (NEXT_WORK D10)。
 *
 * この一覧は API Gateway の JWT authorizer をバイパスさせるルートを決める (ADR 0001 D-10)。
 * 一覧に無いと **Lambda に届く前に 401** になり、一覧にあるのに実装が無ければ 404 になる。
 * どちらもユニットテストが `createApp` を直接叩くぶんには気づけない。ここで両方を潰す。
 *
 * 一覧の JSON は infra (CJS) も同じものを読んでいる。JSON なのは infra から
 * ESM 専用の `@stagecast/shared` を require できないため。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildControlApi } from "../factory.js";
import type { HttpRequest } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
const routesPath = join(here, "..", "..", "..", "..", "packages", "shared", "public-routes.json");
const PUBLIC_ROUTES = (JSON.parse(readFileSync(routesPath, "utf8")) as { routes: string[] }).routes;

/** `POST /stage/presets/{presetId}` → `{ method, path }`。パラメータは適当な値で埋める。 */
function toRequest(routeKey: string): HttpRequest {
  const [method, template] = routeKey.split(" ") as [string, string];
  const path = template.replace(/\{[^}]+\}/g, "x");
  return { method, path, headers: {} };
}

describe("公開ルートの一覧と実装が対応している (D10)", () => {
  const app = buildControlApi();

  it("一覧が空でない (JSON の読み込み自体が壊れていたら気づく)", () => {
    expect(PUBLIC_ROUTES.length).toBeGreaterThan(5);
  });

  for (const routeKey of PUBLIC_ROUTES) {
    // `{proxy+}` は API Gateway 側のワイルドカードで、control-api には対応する分岐が無い。
    if (routeKey.includes("{proxy+}")) continue;

    it(`${routeKey} は実装がある (404 にならない)`, async () => {
      const res = await app.handle(toRequest(routeKey));
      // 認証・バリデーションで弾かれるのは想定どおり (401/400/403)。
      // 404 だけは「一覧にあるのにルーターが知らない」= 一覧が腐っている証拠。
      expect(res.status).not.toBe(404);
    });
  }
});
