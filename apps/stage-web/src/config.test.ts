import { describe, expect, it } from "vitest";
import { resolveRuntimeConfig } from "./config.js";

describe("resolveRuntimeConfig (stage-web ランタイム設定)", () => {
  it("config.json があればそれを優先する", () => {
    expect(
      resolveRuntimeConfig({ controlApiUrl: "https://from-json" }, "https://from-env"),
    ).toEqual({ controlApiUrl: "https://from-json" });
  });

  it("config.json が無ければ build-time env にフォールバックする", () => {
    expect(resolveRuntimeConfig(undefined, "https://from-env")).toEqual({
      controlApiUrl: "https://from-env",
    });
  });

  it("どちらも無ければ空文字 (相対パス扱い)", () => {
    expect(resolveRuntimeConfig(undefined, undefined)).toEqual({ controlApiUrl: "" });
  });
});
