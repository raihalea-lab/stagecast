import { describe, expect, it } from "vitest";
import {
  createArtifactDownloadService,
  type ArtifactObject,
  type ArtifactStore,
} from "./artifact-download.js";

class FakeStore implements ArtifactStore {
  readonly listed: string[] = [];
  constructor(private readonly objects: Record<string, ArtifactObject[]>) {}
  async list(prefix: string): Promise<ArtifactObject[]> {
    this.listed.push(prefix);
    return this.objects[prefix] ?? [];
  }
  async presignGet(key: string): Promise<string> {
    return `https://signed/${key}`;
  }
  async deletePrefix(): Promise<void> {}
}

describe("createArtifactDownloadService (N1)", () => {
  it("録画と確定字幕をイベント配下から一覧し DL URL を付ける", async () => {
    const store = new FakeStore({
      "recordings/evt-1/": [{ key: "recordings/evt-1/lk-egress-1.mp4", size: 1024 }],
      "captions/evt-1/": [{ key: "captions/evt-1/ja.srt" }, { key: "captions/evt-1/en.vtt" }],
    });
    const svc = createArtifactDownloadService({ store });
    const { artifacts } = await svc.listArtifacts("evt-1");

    expect(store.listed).toEqual(["recordings/evt-1/", "captions/evt-1/"]);
    expect(artifacts).toEqual([
      {
        kind: "recording",
        key: "recordings/evt-1/lk-egress-1.mp4",
        name: "lk-egress-1.mp4",
        downloadUrl: "https://signed/recordings/evt-1/lk-egress-1.mp4",
        size: 1024,
      },
      {
        kind: "caption",
        key: "captions/evt-1/ja.srt",
        name: "ja.srt",
        downloadUrl: "https://signed/captions/evt-1/ja.srt",
      },
      {
        kind: "caption",
        key: "captions/evt-1/en.vtt",
        name: "en.vtt",
        downloadUrl: "https://signed/captions/evt-1/en.vtt",
      },
    ]);
  });

  it("成果物が無ければ空配列を返す", async () => {
    const svc = createArtifactDownloadService({ store: new FakeStore({}) });
    const { artifacts } = await svc.listArtifacts("evt-x");
    expect(artifacts).toEqual([]);
  });
});
