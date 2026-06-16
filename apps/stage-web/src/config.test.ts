import { describe, expect, it } from "vitest";
import { resolveRuntimeConfig } from "./config.js";

describe("resolveRuntimeConfig (stage-web ランタイム設定)", () => {
  it("config.json があればそれを優先する", () => {
    expect(
      resolveRuntimeConfig(
        { controlApiUrl: "https://from-json" },
        {
          VITE_CONTROL_API_URL: "https://from-env",
        },
      ),
    ).toEqual({ controlApiUrl: "https://from-json" });
  });

  it("config.json が無ければ build-time env にフォールバックする", () => {
    expect(resolveRuntimeConfig(undefined, { VITE_CONTROL_API_URL: "https://from-env" })).toEqual({
      controlApiUrl: "https://from-env",
    });
  });

  it("どちらも無ければ空文字 (相対パス扱い)", () => {
    expect(resolveRuntimeConfig(undefined, {})).toEqual({ controlApiUrl: "" });
  });
});
