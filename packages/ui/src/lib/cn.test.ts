import { describe, expect, it } from "vitest";
import { cn } from "./cn.js";

describe("cn", () => {
  it("結合する", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("falsy を除外する", () => {
    expect(cn("a", false, undefined, null, "b")).toBe("a b");
  });

  it("tailwind の衝突は後者で上書きする (twMerge)", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("オブジェクト記法もサポートする (clsx)", () => {
    expect(cn("base", { active: true, disabled: false })).toBe("base active");
  });
});
