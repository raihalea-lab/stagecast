import { describe, expect, it } from "vitest";
import { classifyStackStatus, toDesiredEvent } from "./reconcile-handler.js";

describe("toDesiredEvent (gsi-live item → DesiredEvent)", () => {
  it("caption.engine / caption.customApiEnabled / youtube.rtmpUrl を正しく取り出す", () => {
    // dynamo-mapper.eventToItem が格納する EventDefinition 相当の item。
    const item = {
      id: "evt-1",
      eventId: "evt-1",
      status: "live",
      caption: { engine: "llm", customApiEnabled: true, languages: ["ja"], youtubeLanguage: "ja" },
      youtube: { rtmpUrl: "rtmp://a/b", streamKeyRef: "stagecast/sk" },
    };
    expect(toDesiredEvent(item)).toEqual({
      eventId: "evt-1",
      captionEngine: "llm",
      customCaptionApi: true,
      rtmpUrl: "rtmp://a/b",
    });
  });

  it("欠損時は安全な既定 (transcribe / false / rtmpUrl 無し) にフォールバックする", () => {
    expect(toDesiredEvent({ id: "evt-2" })).toEqual({
      eventId: "evt-2",
      captionEngine: "transcribe",
      customCaptionApi: false,
      rtmpUrl: undefined,
    });
  });
});

describe("classifyStackStatus (T4)", () => {
  it("CREATE_COMPLETE / UPDATE_COMPLETE は running", () => {
    expect(classifyStackStatus("CREATE_COMPLETE")).toBe("running");
    expect(classifyStackStatus("UPDATE_COMPLETE")).toBe("running");
  });

  it("DELETE_IN_PROGRESS は deleting", () => {
    expect(classifyStackStatus("DELETE_IN_PROGRESS")).toBe("deleting");
  });

  it("CREATE_IN_PROGRESS / UPDATE_IN_PROGRESS は in_progress", () => {
    expect(classifyStackStatus("CREATE_IN_PROGRESS")).toBe("in_progress");
    expect(classifyStackStatus("UPDATE_IN_PROGRESS")).toBe("in_progress");
  });

  it("FAILED / ROLLBACK 系は failed として再構築の対象", () => {
    expect(classifyStackStatus("CREATE_FAILED")).toBe("failed");
    expect(classifyStackStatus("ROLLBACK_COMPLETE")).toBe("failed");
    expect(classifyStackStatus("ROLLBACK_FAILED")).toBe("failed");
    expect(classifyStackStatus("UPDATE_ROLLBACK_COMPLETE")).toBe("failed");
  });

  it("不明状態は安全側で failed (= 次回 tick で再構築)", () => {
    expect(classifyStackStatus("WEIRD_STATE")).toBe("failed");
  });
});
