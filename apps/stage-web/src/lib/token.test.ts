import { describe, expect, it } from "vitest";
import { parseAdminDirectParams, parseInviteToken } from "./token.js";

describe("parseInviteToken", () => {
  it("extracts token from a query string (with or without leading ?)", () => {
    expect(parseInviteToken("?token=abc.def")).toBe("abc.def");
    expect(parseInviteToken("token=xyz")).toBe("xyz");
  });
  it("returns undefined when absent", () => {
    expect(parseInviteToken("?foo=bar")).toBeUndefined();
    expect(parseInviteToken("")).toBeUndefined();
  });
});

describe("parseAdminDirectParams", () => {
  it("previewToken を含めて取り出す", () => {
    const params = parseAdminDirectParams("?token=lk&url=wss://x&eventId=e1&previewToken=pv");
    expect(params).toEqual({
      livekitToken: "lk",
      livekitUrl: "wss://x",
      eventId: "e1",
      previewToken: "pv",
    });
  });
  it("previewToken が無くても admin 接続自体は成立する (Lambda が旧版のとき)", () => {
    const params = parseAdminDirectParams("?token=lk&url=wss://x&eventId=e1");
    expect(params?.previewToken).toBeUndefined();
    expect(params?.livekitToken).toBe("lk");
  });
});
