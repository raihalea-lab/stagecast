import { describe, expect, it, beforeEach } from "vitest";
import { buildControlApi } from "../factory.js";
import { DefaultLiveKitTokenMinter } from "../auth/livekit-minter.js";
import { MemoryEventRepository } from "../repo/memory.js";
import type { App, HttpRequest } from "../http/app.js";
import type { EventDefinition } from "@stagecast/shared";

const adminAuth = { authorization: "Bearer fake:admin-1:admin@example.com" };
const caption = {
  languages: ["ja"],
  youtubeLanguage: "ja",
  engine: "transcribe",
  customApiEnabled: false,
};

function req(p: Partial<HttpRequest> & Pick<HttpRequest, "method" | "path">): HttpRequest {
  return { headers: {}, ...p };
}

async function makeEvent(target: App): Promise<string> {
  const res = await target.handle(
    req({
      method: "POST",
      path: "/events",
      headers: adminAuth,
      body: { title: "E", startsAt: "2026-07-01T09:00:00Z", caption },
    }),
  );
  return (res.body as { id: string }).id;
}

/** ADR 0008 D-2: reconcile が events 行に media を書き戻したのを模倣する。 */
async function setMedia(
  repo: MemoryEventRepository,
  eventId: string,
  livekitUrl: string,
): Promise<void> {
  const e = await repo.get(eventId);
  if (!e) throw new Error("event not in repo");
  const next: EventDefinition = {
    ...e,
    media: { livekitUrl, readyAt: 1_000_001 },
  };
  await repo.put(next);
}

describe("join (招待トークン → LiveKit トークン) (DESIGN.md 4.1, F-1, ADR 0008 D-3)", () => {
  let app: App;
  let repo: MemoryEventRepository;
  let counter: number;

  beforeEach(() => {
    counter = 0;
    repo = new MemoryEventRepository();
    app = buildControlApi({
      inviteSecret: "test-secret",
      eventRepo: repo,
      newId: () => `id-${++counter}`,
      // ADR 0008 D-5: minter は URL を持たず apiKey/apiSecret のみ。
      livekitMinter: new DefaultLiveKitTokenMinter({
        apiKey: "devkey",
        apiSecret: "devsecret",
      }),
    });
  });

  async function issueInvite(
    role: "speaker" | "moderator",
  ): Promise<{ token: string; eventId: string }> {
    const eventId = await makeEvent(app);
    const res = await app.handle(
      req({
        method: "POST",
        path: `/events/${eventId}/invites`,
        headers: adminAuth,
        body: { role, ttlSec: 3600 },
      }),
    );
    return { token: (res.body as { token: string }).token, eventId };
  }

  it("mints a LiveKit token for a valid invite, scoping the room to the event", async () => {
    const { token, eventId } = await issueInvite("speaker");
    // ADR 0008 D-1: reconcile が media を書き戻した状態を作る。
    await setMedia(repo, eventId, "wss://1.2.3.4:7880");
    const res = await app.handle(req({ method: "POST", path: "/join", body: { token } }));
    expect(res.status).toBe(200);
    const body = res.body as {
      ok: boolean;
      role: string;
      room: string;
      livekitUrl: string;
      livekitToken: string;
    };
    expect(body).toMatchObject({
      ok: true,
      role: "speaker",
      room: eventId,
      // ADR 0008: per-event URL (events.media.livekitUrl) が返る。
      livekitUrl: "wss://1.2.3.4:7880",
    });
    expect(body.livekitToken.split(".")).toHaveLength(3); // JWT
  });

  it("rejects an invalid/forged invite token", async () => {
    const res = await app.handle(req({ method: "POST", path: "/join", body: { token: "bad" } }));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false });
  });

  it("returns 503 when LiveKit is not configured (no minter)", async () => {
    const noMedia = buildControlApi({ inviteSecret: "test-secret", newId: () => "x" });
    const eventId = await makeEvent(noMedia);
    const issued = await noMedia.handle(
      req({
        method: "POST",
        path: `/events/${eventId}/invites`,
        headers: adminAuth,
        body: { role: "speaker", ttlSec: 3600 },
      }),
    );
    const token = (issued.body as { token: string }).token;
    const res = await noMedia.handle(req({ method: "POST", path: "/join", body: { token } }));
    expect(res.status).toBe(503);
  });

  it("returns 503 with Retry-After when event.media is not yet set (ADR 0008 D-3)", async () => {
    const { token } = await issueInvite("speaker");
    // media を書き戻さずに /join。
    const res = await app.handle(req({ method: "POST", path: "/join", body: { token } }));
    expect(res.status).toBe(503);
    expect(res.headers?.["Retry-After"]).toBe("30");
  });
});
