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

  it("R17-Phase3: composerTemplateUrl は config.json から取れる", () => {
    expect(
      resolveRuntimeConfig(
        { controlApiUrl: "https://api", composerTemplateUrl: "https://composer" },
        undefined,
      ),
    ).toEqual({ controlApiUrl: "https://api", composerTemplateUrl: "https://composer" });
  });

  it("R17-Phase3: composerTemplateUrl は env fallback も効く", () => {
    expect(resolveRuntimeConfig(undefined, "https://api", "https://composer-env")).toEqual({
      controlApiUrl: "https://api",
      composerTemplateUrl: "https://composer-env",
    });
  });

  it("R17-Phase3: composerTemplateUrl は無くても他フィールドだけで動く (後方互換)", () => {
    expect(resolveRuntimeConfig(undefined, "https://api")).toEqual({
      controlApiUrl: "https://api",
    });
  });
});
