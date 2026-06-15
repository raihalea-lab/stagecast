import { describe, expect, it, beforeEach } from "vitest";
import { buildControlApi } from "../factory.js";
import { DefaultLiveKitTokenMinter } from "../auth/livekit-minter.js";
import type { App, HttpRequest } from "../http/app.js";

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

describe("join (招待トークン → LiveKit トークン) (DESIGN.md 4.1, F-1)", () => {
  let app: App;
  let counter: number;

  beforeEach(() => {
    counter = 0;
    app = buildControlApi({
      inviteSecret: "test-secret",
      newId: () => `id-${++counter}`,
      livekitMinter: new DefaultLiveKitTokenMinter({
        url: "wss://sfu.test",
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
      livekitUrl: "wss://sfu.test",
    });
    expect(body.livekitToken.split(".")).toHaveLength(3); // JWT
  });

  it("rejects an invalid/forged invite token", async () => {
    const res = await app.handle(req({ method: "POST", path: "/join", body: { token: "bad" } }));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ ok: false });
  });

  it("returns 503 when LiveKit is not configured", async () => {
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
});
