import { describe, expect, it } from "vitest";
import { signInviteToken, verifyInviteToken } from "./token.js";

const secret = "test-secret";
const base = {
  eventId: "evt-1",
  role: "speaker" as const,
  jti: "tok-1",
  issuedAtSec: 1000,
  ttlSec: 3600,
  version: 1,
};

describe("invite token sign/verify", () => {
  it("round-trips a valid token", () => {
    const token = signInviteToken(base, secret);
    const res = verifyInviteToken(token, secret, 1500);
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.payload.eventId).toBe("evt-1");
      expect(res.payload.role).toBe("speaker");
    }
  });

  it("rejects a tampered signature", () => {
    const token = signInviteToken(base, secret);
    const res = verifyInviteToken(token + "x", secret, 1500);
    expect(res).toEqual({ valid: false, reason: "bad-signature" });
  });

  it("rejects a wrong secret", () => {
    const token = signInviteToken(base, secret);
    const res = verifyInviteToken(token, "other-secret", 1500);
    expect(res.valid).toBe(false);
  });

  it("rejects an expired token", () => {
    const token = signInviteToken(base, secret);
    const res = verifyInviteToken(token, secret, 1000 + 3600);
    expect(res).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects malformed input", () => {
    expect(verifyInviteToken("not-a-token", secret, 1500)).toEqual({
      valid: false,
      reason: "malformed",
    });
  });
});
