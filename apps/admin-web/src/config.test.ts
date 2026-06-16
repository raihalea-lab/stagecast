import { describe, expect, it } from "vitest";
import { resolveRuntimeConfig } from "./config.js";

const emptyEnv = {} as ImportMetaEnv;

describe("resolveRuntimeConfig (admin-web ランタイム設定)", () => {
  it("config.json があればそれを優先する", () => {
    const env = {
      VITE_CONTROL_API_URL: "https://from-env",
      VITE_COGNITO_DOMAIN: "env-domain",
      VITE_COGNITO_USER_POOL_CLIENT_ID: "env-client",
    } as ImportMetaEnv;
    expect(
      resolveRuntimeConfig(
        { controlApiUrl: "https://from-json", cognito: { domain: "d", clientId: "c" } },
        env,
      ),
    ).toEqual({ controlApiUrl: "https://from-json", cognito: { domain: "d", clientId: "c" } });
  });

  it("config.json が無ければ build-time env にフォールバックする (ローカル開発)", () => {
    const env = {
      VITE_CONTROL_API_URL: "https://from-env",
      VITE_COGNITO_DOMAIN: "env-domain",
      VITE_COGNITO_USER_POOL_CLIENT_ID: "env-client",
    } as ImportMetaEnv;
    expect(resolveRuntimeConfig(undefined, env)).toEqual({
      controlApiUrl: "https://from-env",
      cognito: { domain: "env-domain", clientId: "env-client" },
    });
  });

  it("Cognito 設定が無ければ cognito は付かない (認証スキップ)", () => {
    expect(resolveRuntimeConfig(undefined, emptyEnv)).toEqual({ controlApiUrl: "" });
    expect(resolveRuntimeConfig({ controlApiUrl: "https://x" }, emptyEnv)).toEqual({
      controlApiUrl: "https://x",
    });
  });
});
