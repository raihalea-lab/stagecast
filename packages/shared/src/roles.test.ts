import { describe, expect, it } from "vitest";
import { isInvitedRole, isRole, roleFromIdentity } from "./roles.js";

describe("roleFromIdentity (LiveKit identity の接頭辞、ADR 0020 D-4)", () => {
  it("接頭辞からロールを返し、無ければ undefined", () => {
    expect(roleFromIdentity("speaker-1")).toBe("speaker");
    expect(roleFromIdentity("moderator-abc")).toBe("moderator");
    expect(roleFromIdentity("admin-user-uuid")).toBe("admin");
    expect(roleFromIdentity("preview-fake")).toBeUndefined();
    expect(roleFromIdentity("")).toBeUndefined();
  });
});

describe("roles", () => {
  it("isRole recognizes the four DESIGN.md roles", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("moderator")).toBe(true);
    expect(isRole("speaker")).toBe(true);
    expect(isRole("viewer")).toBe(true);
    expect(isRole("superuser")).toBe(false);
  });

  it("isInvitedRole only matches invite-URL roles (moderator/speaker)", () => {
    expect(isInvitedRole("moderator")).toBe(true);
    expect(isInvitedRole("speaker")).toBe(true);
    expect(isInvitedRole("admin")).toBe(false);
    expect(isInvitedRole("viewer")).toBe(false);
  });
});
