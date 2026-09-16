import { describe, expect, it, beforeEach } from "vitest";
import { buildControlApi } from "../factory.js";
import {
  createAssetUploadService,
  createMaterialUploadService,
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

describe("material upload service (ADR 0021 D-1)", () => {
  it("assetId と filename を / で分ける (抽出 Lambda が 3 段ちょうどを期待する)", async () => {
    let n = 0;
    const svc = createMaterialUploadService({ signer: new FakeSigner(), newId: () => `id-${++n}` });
    const out = await svc.createUploadUrl("evt-1", "my slides (v2).pdf", "application/pdf");
    expect(out.key).toBe("assets/materials/evt-1/id-1/my_slides__v2_.pdf");
    expect(out.assetId).toBe("id-1");
    expect(out.uploadUrl).toContain("assets/materials/evt-1/id-1/my_slides__v2_.pdf");
  });

  it("ファイル名の / はサニタイズされ、段数は増えない", async () => {
    const svc = createMaterialUploadService({ signer: new FakeSigner(), newId: () => "id" });
    const out = await svc.createUploadUrl("evt-1", "slides/deck.pdf", "application/pdf");
    expect(out.key).toBe("assets/materials/evt-1/id/slides_deck.pdf");
    expect(out.key.split("/")).toHaveLength(5);
  });

  it("PDF 以外の対応形式も受け付ける (PPTX / md / txt)", async () => {
    const svc = createMaterialUploadService({ signer: new FakeSigner(), newId: () => "id" });
    const pptx = await svc.createUploadUrl(
      "evt-1",
      "slides.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(pptx.key).toContain("slides.pptx");
    const md = await svc.createUploadUrl("evt-1", "notes.md", "text/markdown");
    expect(md.key).toContain("notes.md");
  });

  it("抽出できない content-type は弾く", async () => {
    const svc = createMaterialUploadService({ signer: new FakeSigner(), newId: () => "id" });
    await expect(
      svc.createUploadUrl("evt-1", "slides.ppt", "application/vnd.ms-powerpoint"),
    ).rejects.toThrow("unsupported material content-type");
  });

  it("拡張子と content-type が食い違うものは弾く (抽出器は拡張子で分岐する)", async () => {
    const svc = createMaterialUploadService({ signer: new FakeSigner(), newId: () => "id" });
    await expect(svc.createUploadUrl("evt-1", "slides.pptx", "application/pdf")).rejects.toThrow(
      "filename extension does not match content-type",
    );
  });
});

describe("POST /stage/materials/upload-url", () => {
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
        path: "/stage/materials/upload-url",
        body: { inviteToken, filename: "deck.pdf", contentType: "application/pdf" },
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      key: expect.stringContaining("assets/materials/"),
      assetId: expect.any(String),
      uploadUrl: expect.stringContaining("assets/materials/"),
    });
  });

  it("rejects non-PDF content types with 400", async () => {
    const inviteToken = await moderatorToken();
    const res = await app.handle(
      req({
        method: "POST",
        path: "/stage/materials/upload-url",
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
        path: "/stage/materials/upload-url",
        body: { inviteToken, filename: "deck.pdf", contentType: "application/pdf" },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /stage/materials/download-url", () => {
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
        path: "/stage/materials/download-url",
        body: { inviteToken: token, assetKey: `assets/materials/${eventId}/id-1-deck.pdf` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ downloadUrl: expect.stringContaining("assets/materials/") });
  });

  it("rejects keys outside the event's deck prefix", async () => {
    const { token } = await moderatorToken();
    const res = await app.handle(
      req({
        method: "POST",
        path: "/stage/materials/download-url",
        body: { inviteToken: token, assetKey: "assets/materials/other-event/id-1-deck.pdf" },
      }),
    );
    expect(res.status).toBe(404);
  });
});
