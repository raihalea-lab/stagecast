import { describe, expect, it } from "vitest";
import {
  isInviteTokenTimeValid,
  isValidInviteTokenPayload,
  type InviteTokenPayload,
} from "./invite.js";

const payload: InviteTokenPayload = {
  jti: "tok-1",
  eventId: "evt-1",
  role: "speaker",
  iat: 1000,
  exp: 2000,
  version: 1,
};

describe("invite", () => {
  it("validates time window (iat <= now < exp)", () => {
    expect(isInviteTokenTimeValid(payload, 1500)).toBe(true);
    expect(isInviteTokenTimeValid(payload, 999)).toBe(false);
    expect(isInviteTokenTimeValid(payload, 2000)).toBe(false);
  });

  it("validates payload shape and rejects admin/viewer roles", () => {
    expect(isValidInviteTokenPayload(payload)).toBe(true);
    expect(isValidInviteTokenPayload({ ...payload, role: "admin" })).toBe(false);
    expect(isValidInviteTokenPayload({})).toBe(false);
  });
});
