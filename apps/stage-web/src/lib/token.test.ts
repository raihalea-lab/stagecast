import { describe, expect, it } from "vitest";
import { parseInviteToken } from "./token.js";

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
