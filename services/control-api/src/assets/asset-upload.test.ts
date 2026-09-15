import { describe, expect, it, beforeEach } from "vitest";
import { buildControlApi } from "../factory.js";
import {
  createAssetUploadService,
  createDeckUploadService,
  type AssetUploadSigner,
} from "./asset-upload.js";
import type { App, HttpRequest } from "../http/app.js";

const adminAuth = { authorization: "Bearer fake:admin-1:admin@example.com" };
const req = (p: Partial<HttpRequest> & Pick<HttpRequest, "method" | "path">): HttpRequest => ({
  headers: {},
  ...p,
});

class FakeSigner implements AssetUploadSigner {
  async presignPut(key: string, contentType: string): Promise<string> {
    return `https://s3.test/${key}?ct=${encodeURIComponent(contentType)}&sig=abc`;
  }
}

describe("asset upload service", () => {
  it("namespaces the key under library/ and sanitizes the filename", async () => {
    let n = 0;
    const svc = createAssetUploadService({ signer: new FakeSigner(), newId: () => `id-${++n}` });
    const out = await svc.createUploadUrl("my slides (v2).pdf", "application/pdf");
    expect(out.key).toBe("assets/library/id-1-my_slides__v2_.pdf");
    expect(out.assetId).toBe("id-1");
    expect(out.uploadUrl).toContain("assets/library/id-1-my_slides__v2_.pdf");
  });
});

describe("POST /assets/upload-url", () => {
  let app: App;
  beforeEach(() => {
    app = buildControlApi({ inviteSecret: "s", assetSigner: new FakeSigner(), newId: () => "fix" });
  });

  it("returns a presigned upload URL for admins", async () => {
    const res = await app.handle(
      req({
        method: "POST",
        path: "/assets/upload-url",
        headers: adminAuth,
        body: { filename: "qr.png", contentType: "image/png" },
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ key: "assets/library/fix-qr.png", assetId: "fix" });
  });

  it("requires admin auth", async () => {
    const res = await app.handle(req({ method: "POST", path: "/assets/upload-url", body: {} }));
    expect(res.status).toBe(401);
  });

  it("returns 503 when no signer is configured", async () => {
    const noAssets = buildControlApi({ inviteSecret: "s" });
    const res = await noAssets.handle(
      req({
        method: "POST",
        path: "/assets/upload-url",
        headers: adminAuth,
        body: { filename: "x", contentType: "text/plain" },
      }),
    );
    expect(res.status).toBe(503);
  });
});

describe("deck upload service (F-3, DESIGN.md 5.2)", () => {
  it("namespaces the key under decks/{eventId}/ and sanitizes the filename", async () => {
    let n = 0;
    const svc = createDeckUploadService({ signer: new FakeSigner(), newId: () => `id-${++n}` });
    const out = await svc.createUploadUrl("evt-1", "my slides (v2).pdf", "application/pdf");
    expect(out.key).toBe("assets/decks/evt-1/id-1-my_slides__v2_.pdf");
    expect(out.assetId).toBe("id-1");
    expect(out.uploadUrl).toContain("assets/decks/evt-1/id-1-my_slides__v2_.pdf");
  });

  it("rejects non-PDF content types", async () => {
    const svc = createDeckUploadService({ signer: new FakeSigner(), newId: () => "id" });
    await expect(
      svc.createUploadUrl("evt-1", "slides.pptx", "application/vnd.ms-powerpoint"),
    ).rejects.toThrow("deck must be application/pdf");
  });
});

describe("POST /stage/decks/upload-url", () => {
  let app: App;
  let counter: number;

  beforeEach(() => {
    counter = 0;
    app = buildControlApi({
      inviteSecret: "s",
      assetSigner: new FakeSigner(),
      newId: () => `id-${++counter}`,
      artifactStore: {
        async list() {
          return [];
        },
        async presignGet(key) {
          return `https://signed/${key}`;
        },
        async deletePrefix() {},
      },
    });
  });

  async function moderatorToken(): Promise<string> {
    const create = await app.handle(
      req({
        method: "POST",
        path: "/events",
        headers: adminAuth,
        body: {
          title: "E",
          startsAt: "2026-07-01T09:00:00Z",
          caption: {
            languages: ["ja"],
            youtubeLanguage: "ja",
            engine: "transcribe",
            customApiEnabled: false,
          },
        },
      }),
    );
    const eventId = (create.body as { id: string }).id;
    const issued = await app.handle(
      req({
        method: "POST",
        path: `/events/${eventId}/invites`,
        headers: adminAuth,
        body: { role: "moderator", ttlSec: 3600 },
      }),
    );
    return (issued.body as { token: string }).token;
  }

  it("returns a presigned upload URL under decks/{eventId}/ for moderators", async () => {
    const inviteToken = await moderatorToken();
    const res = await app.handle(
      req({
        method: "POST",
        path: "/stage/decks/upload-url",
        body: { inviteToken, filename: "deck.pdf", contentType: "application/pdf" },
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      key: expect.stringContaining("assets/decks/"),
      assetId: expect.any(String),
      uploadUrl: expect.stringContaining("assets/decks/"),
    });
  });

  it("rejects non-PDF content types with 400", async () => {
    const inviteToken = await moderatorToken();
    const res = await app.handle(
      req({
        method: "POST",
        path: "/stage/decks/upload-url",
        body: { inviteToken, filename: "deck.pptx", contentType: "application/vnd.ms-powerpoint" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("requires moderator role", async () => {
    const create = await app.handle(
      req({
        method: "POST",
        path: "/events",
        headers: adminAuth,
        body: {
          title: "E",
          startsAt: "2026-07-01T09:00:00Z",
          caption: {
            languages: ["ja"],
            youtubeLanguage: "ja",
            engine: "transcribe",
            customApiEnabled: false,
          },
        },
      }),
    );
    const eventId = (create.body as { id: string }).id;
    const issued = await app.handle(
      req({
        method: "POST",
        path: `/events/${eventId}/invites`,
        headers: adminAuth,
        body: { role: "speaker", ttlSec: 3600 },
      }),
    );
    const inviteToken = (issued.body as { token: string }).token;
    const res = await app.handle(
      req({
        method: "POST",
        path: "/stage/decks/upload-url",
        body: { inviteToken, filename: "deck.pdf", contentType: "application/pdf" },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /stage/decks/download-url", () => {
  let app: App;
  let counter: number;

  beforeEach(() => {
    counter = 0;
    app = buildControlApi({
      inviteSecret: "s",
      assetSigner: new FakeSigner(),
      newId: () => `id-${++counter}`,
      artifactStore: {
        async list() {
          return [];
        },
        async presignGet(key) {
          return `https://signed/${key}`;
        },
        async deletePrefix() {},
      },
    });
  });

  async function moderatorToken(): Promise<{ token: string; eventId: string }> {
    const create = await app.handle(
      req({
        method: "POST",
        path: "/events",
        headers: adminAuth,
        body: {
          title: "E",
          startsAt: "2026-07-01T09:00:00Z",
          caption: {
            languages: ["ja"],
            youtubeLanguage: "ja",
            engine: "transcribe",
            customApiEnabled: false,
          },
        },
      }),
    );
    const eventId = (create.body as { id: string }).id;
    const issued = await app.handle(
      req({
        method: "POST",
        path: `/events/${eventId}/invites`,
        headers: adminAuth,
        body: { role: "moderator", ttlSec: 3600 },
      }),
    );
    return { token: (issued.body as { token: string }).token, eventId };
  }

  it("presigns a GET URL for a deck key in the event's prefix", async () => {
    const { token, eventId } = await moderatorToken();
    const res = await app.handle(
      req({
        method: "POST",
        path: "/stage/decks/download-url",
        body: { inviteToken: token, assetKey: `assets/decks/${eventId}/id-1-deck.pdf` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ downloadUrl: expect.stringContaining("assets/decks/") });
  });

  it("rejects keys outside the event's deck prefix", async () => {
    const { token } = await moderatorToken();
    const res = await app.handle(
      req({
        method: "POST",
        path: "/stage/decks/download-url",
        body: { inviteToken: token, assetKey: "assets/decks/other-event/id-1-deck.pdf" },
      }),
    );
    expect(res.status).toBe(404);
  });
});
