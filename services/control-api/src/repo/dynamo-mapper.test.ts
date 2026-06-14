import { describe, expect, it } from "vitest";
import type { EventDefinition, PresentationState } from "@stagecast/shared";
import {
  eventToItem,
  itemToEvent,
  inviteToItem,
  itemToInvite,
  presentationToItem,
  itemToPresentation,
} from "./dynamo-mapper.js";
import type { InviteTokenRecord } from "./types.js";

const event: EventDefinition = {
  id: "evt-1",
  title: "Conf",
  startsAt: "2026-07-01T09:00:00Z",
  status: "draft",
  caption: {
    languages: ["ja", "en"],
    youtubeLanguage: "ja",
    engine: "transcribe",
    customApiEnabled: true,
  },
  qrAsset: { key: "assets/evt-1/qr.png" },
  createdAtMs: 1000,
  updatedAtMs: 2000,
};

describe("dynamo single-table mapping (DESIGN.md 3.1)", () => {
  it("round-trips an event and sets keys/GSI for listing", () => {
    const item = eventToItem(event);
    expect(item.pk).toBe("EVENT#evt-1");
    expect(item.sk).toBe("META");
    expect(item.gsi1pk).toBe("EVENT");
    expect(item.gsi1sk).toBe("2026-07-01T09:00:00Z#evt-1");
    expect(itemToEvent(item)).toEqual(event);
  });

  it("round-trips an invite record with event-scoped GSI", () => {
    const rec: InviteTokenRecord = {
      jti: "tok-1",
      eventId: "evt-1",
      role: "speaker",
      currentVersion: 2,
      revoked: false,
    };
    const item = inviteToItem(rec);
    expect(item.pk).toBe("INVITE#tok-1");
    expect(item.gsi1pk).toBe("INVITE#evt-1");
    expect(itemToInvite(item)).toEqual(rec);
  });

  it("round-trips presentation state under the event partition", () => {
    const state: PresentationState = {
      eventId: "evt-1",
      speakers: [{ speakerId: "a", visibility: "live", updatedAtMs: 5 }],
      slideSource: "uploaded",
      slidePage: 3,
    };
    const item = presentationToItem(state);
    expect(item.pk).toBe("EVENT#evt-1");
    expect(item.sk).toBe("PRESENTATION");
    expect(itemToPresentation(item)).toEqual(state);
  });

  it("defaults speakers to an empty array when missing", () => {
    expect(itemToPresentation({ eventId: "evt-2" }).speakers).toEqual([]);
  });
});
