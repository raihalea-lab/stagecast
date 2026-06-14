import { describe, expect, it } from "vitest";
import { isInvitedRole, isRole } from "./roles.js";

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
