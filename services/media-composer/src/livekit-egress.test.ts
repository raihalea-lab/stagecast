import { describe, expect, it, vi } from "vitest";
import type { PresentationState } from "@stagecast/shared";
import type { EgressClient } from "livekit-server-sdk";
import {
  LiveKitEgressClient,
  attachComposerToPresentation,
  createLiveKitEgressApi,
  layoutToLiveKit,
  type LiveKitEgressApi,
} from "./livekit-egress.js";
import { StreamComposer } from "./composer.js";
import type { CompositionLayout } from "./layout.js";

class FakeLiveKitEgressApi implements LiveKitEgressApi {
  readonly started: Array<Parameters<LiveKitEgressApi["startRoomCompositeEgress"]>[0]> = [];
  readonly updates: { egressId: string; layout: string }[] = [];
  readonly stopped: string[] = [];
  private seq = 0;
  async startRoomCompositeEgress(
    input: Parameters<LiveKitEgressApi["startRoomCompositeEgress"]>[0],
  ): Promise<{ egressId: string }> {
    this.started.push(input);
    return { egressId: `lk-egress-${++this.seq}` };
  }
  async updateLayout(egressId: string, layout: string): Promise<void> {
    this.updates.push({ egressId, layout });
  }
  async stopEgress(egressId: string): Promise<void> {
    this.stopped.push(egressId);
  }
}

const layout: CompositionLayout = {
  slide: { region: { x: 0, y: 0, w: 0.7, h: 0.8 }, source: "screen-share", page: undefined },
  speakers: [{ speakerId: "s1", region: { x: 0.72, y: 0.02, w: 0.26, h: 0.5 } }],
  qr: null,
  title: null,
};

describe("layoutToLiveKit (T2)", () => {
  it("スライド有りなら speaker レイアウト", () => {
    expect(layoutToLiveKit(layout)).toBe("speaker");
  });
  it("スライド無し・登壇者 1 人なら single-speaker", () => {
    expect(
      layoutToLiveKit({
        slide: null,
        speakers: [{ speakerId: "s1", region: { x: 0, y: 0, w: 1, h: 1 } }],
        qr: null,
        title: null,
      }),
    ).toBe("single-speaker");
  });
  it("スライド無し・複数登壇者なら grid", () => {
    expect(
      layoutToLiveKit({
        slide: null,
        speakers: [
          { speakerId: "a", region: { x: 0, y: 0, w: 0.5, h: 1 } },
          { speakerId: "b", region: { x: 0.5, y: 0, w: 0.5, h: 1 } },
        ],
        qr: null,
        title: null,
      }),
    ).toBe("grid");
  });
});

describe("LiveKitEgressClient (T2)", () => {
  it("RTMP 出力と S3 録画を指定して RoomComposite を起動する", async () => {
    const api = new FakeLiveKitEgressApi();
    const client = new LiveKitEgressClient({ api, s3Region: "us-east-1" });
    const handle = await client.start({
      eventId: "evt-1",
      room: "stagecast-evt-1",
      layout,
      rtmpUrl: "rtmp://yt/live2/key-xyz",
      recording: { s3Bucket: "stagecast-rec", s3KeyPrefix: "recordings/" },
    });
    expect(handle.status).toBe("active");
    expect(handle.recordingS3Uri).toBe("s3://stagecast-rec/recordings/evt-1/lk-egress-1.mp4");
    expect(api.started).toHaveLength(1);
    expect(api.started[0]?.roomName).toBe("stagecast-evt-1");
    expect(api.started[0]?.layout).toBe("speaker");
    expect(api.started[0]?.streamOutputs?.[0]).toMatchObject({
      protocol: "rtmp",
      urls: ["rtmp://yt/live2/key-xyz"],
    });
    expect(api.started[0]?.fileOutputs?.[0]).toMatchObject({
      fileType: "mp4",
      s3: { bucket: "stagecast-rec", region: "us-east-1" },
    });
  });

  it("RTMP 未指定なら defaultRtmpUrl にフォールバック、録画無しなら fileOutputs なし", async () => {
    const api = new FakeLiveKitEgressApi();
    const client = new LiveKitEgressClient({ api, defaultRtmpUrl: "rtmp://default/live2/k" });
    await client.start({ eventId: "evt-1", room: "r", layout });
    expect(api.started[0]?.streamOutputs?.[0]?.urls).toEqual(["rtmp://default/live2/k"]);
    expect(api.started[0]?.fileOutputs).toBeUndefined();
  });

  it("updateLayout / stop が LiveKit API を呼ぶ", async () => {
    const api = new FakeLiveKitEgressApi();
    const client = new LiveKitEgressClient({ api });
    const handle = await client.start({ eventId: "evt-1", room: "r", layout });
    await client.updateLayout(handle, {
      slide: null,
      speakers: [],
      qr: null,
      title: null,
    });
    expect(api.updates[0]).toMatchObject({ egressId: handle.egressId, layout: "single-speaker" });
    await client.stop(handle);
    expect(api.stopped).toEqual([handle.egressId]);
  });
});

describe("createLiveKitEgressApi (D3: 実 livekit-server-sdk シグネチャ整合)", () => {
  type StartArgs = {
    roomName: string;
    output: { stream?: unknown; file?: unknown };
    opts: unknown;
  };
  function fakeClient() {
    const starts: StartArgs[] = [];
    const updates: { id: string; layout: string }[] = [];
    const stops: string[] = [];
    const client = {
      async startRoomCompositeEgress(roomName: string, output: StartArgs["output"], opts: unknown) {
        starts.push({ roomName, output, opts });
        return { egressId: "eg-real-1" };
      },
      async updateLayout(id: string, layout: string) {
        updates.push({ id, layout });
        return {};
      },
      async stopEgress(id: string) {
        stops.push(id);
        return {};
      },
    } as unknown as EgressClient;
    return { client, starts, updates, stops };
  }

  it("RoomComposite を (roomName, output, {layout}) で起動し stream/file 出力を生成する", async () => {
    const { client, starts } = fakeClient();
    const api = createLiveKitEgressApi(client);
    const res = await api.startRoomCompositeEgress({
      roomName: "stagecast-evt-1",
      layout: "speaker",
      streamOutputs: [{ protocol: "rtmp", urls: ["rtmp://yt/live2/k"] }],
      fileOutputs: [
        {
          fileType: "mp4",
          filepath: "recordings/evt-1/x.mp4",
          s3: { bucket: "b", region: "us-east-1" },
        },
      ],
    });
    expect(res.egressId).toBe("eg-real-1");
    expect(starts).toHaveLength(1);
    const call = starts[0]!;
    // 現行 SDK: roomName は第 1 引数、layout は opts に渡る。
    expect(call.roomName).toBe("stagecast-evt-1");
    expect((call.opts as { layout?: string }).layout).toBe("speaker");
    // 出力は実 protobuf (StreamOutput / EncodedFileOutput) に変換される。
    expect((call.output.stream as { urls: string[] }).urls).toEqual(["rtmp://yt/live2/k"]);
    expect((call.output.file as { filepath: string }).filepath).toBe("recordings/evt-1/x.mp4");
  });

  it("updateLayout / stopEgress を実 client に転送する", async () => {
    const { client, updates, stops } = fakeClient();
    const api = createLiveKitEgressApi(client);
    await api.updateLayout("eg-9", "grid");
    await api.stopEgress("eg-9");
    expect(updates).toEqual([{ id: "eg-9", layout: "grid" }]);
    expect(stops).toEqual(["eg-9"]);
  });
});

describe("attachComposerToPresentation (T2)", () => {
  it("PresentationState の通知 → composer.onPresentationChanged を呼ぶ", async () => {
    const api = new FakeLiveKitEgressApi();
    const composer = new StreamComposer(new LiveKitEgressClient({ api }), {
      eventId: "e",
      room: "r",
      branding: { title: "T", showQr: true },
    });
    const initial: PresentationState = {
      eventId: "e",
      speakers: [{ speakerId: "s1", visibility: "live", updatedAtMs: 0 }],
    };
    await composer.start(initial);
    const sub = attachComposerToPresentation(composer);
    sub.notify({
      ...initial,
      speakers: [...initial.speakers, { speakerId: "s2", visibility: "live", updatedAtMs: 0 }],
    });
    // notify は非同期発火なので少し待つ。
    await new Promise((r) => setTimeout(r, 0));
    expect(api.updates.length).toBeGreaterThan(0);
  });

  it("失敗時は onError コールバック (未指定なら console.error)", async () => {
    const errors: unknown[] = [];
    const composer = {
      onPresentationChanged: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as StreamComposer;
    const sub = attachComposerToPresentation(composer, { onError: (e) => errors.push(e) });
    sub.notify({ eventId: "e", speakers: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
  });
});
