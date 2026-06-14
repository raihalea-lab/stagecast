import { describe, expect, it, beforeEach } from "vitest";
import type { PresentationState } from "@stagecast/shared";
import { StreamComposer } from "./composer.js";
import { FakeEgressClient } from "./egress.js";

function state(speakers: PresentationState["speakers"]): PresentationState {
  return { eventId: "evt-a", speakers };
}

describe("StreamComposer (DESIGN.md 5.1, 5.3, F-4, F-6, N-4)", () => {
  let egress: FakeEgressClient;
  let composer: StreamComposer;

  beforeEach(() => {
    egress = new FakeEgressClient();
    composer = new StreamComposer(egress, {
      eventId: "evt-a",
      room: "evt-a",
      branding: { title: "Conf", showQr: true },
      rtmpUrl: "rtmp://youtube/live/key",
      recording: { s3Bucket: "stagecast-assets", s3KeyPrefix: "recordings/evt-a/" },
    });
  });

  it("starts egress to RTMP and records to S3 (F-6, N-4)", async () => {
    const handle = await composer.start(state([]));
    expect(handle.status).toBe("active");
    expect(handle.rtmpUrl).toBe("rtmp://youtube/live/key");
    expect(handle.recordingS3Uri).toMatch(/^s3:\/\/stagecast-assets\/recordings\/evt-a\//);
  });

  it("reflects a presenter being brought live into the egress layout (F-4)", async () => {
    await composer.start(state([]));
    const changed = await composer.onPresentationChanged(
      state([{ speakerId: "spk-1", visibility: "live", updatedAtMs: 2 }]),
    );
    expect(changed).toBe(true);
    expect(egress.layoutUpdates).toHaveLength(1);
    const updated = egress.layoutUpdates[0]!.layout;
    expect(updated.speakers.map((s) => s.speakerId)).toContain("spk-1");
  });

  it("does not call egress when the layout is unchanged (idempotent)", async () => {
    const s = state([{ speakerId: "spk-1", visibility: "live", updatedAtMs: 1 }]);
    await composer.start(s);
    const changed = await composer.onPresentationChanged(s);
    expect(changed).toBe(false);
    expect(egress.layoutUpdates).toHaveLength(0);
  });

  it("stop tears down the egress", async () => {
    const handle = await composer.start(state([]));
    await composer.stop();
    expect(egress.stopped).toContain(handle.egressId);
    expect(composer.egressHandle).toBeUndefined();
  });
});
