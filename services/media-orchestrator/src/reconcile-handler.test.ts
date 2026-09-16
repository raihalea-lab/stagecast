import { describe, expect, it } from "vitest";
import { classifyStackStatus, toDesiredEvent } from "./reconcile-handler.js";

describe("toDesiredEvent (gsi-live item → DesiredEvent)", () => {
  it("caption.engine / caption.customApiEnabled / youtube.rtmpUrl / streamKeyRef を正しく取り出す (R12)", () => {
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
      captionEnabled: true,
      customCaptionApi: true,
      rtmpUrl: "rtmp://a/b",
      streamKeyRef: "stagecast/sk",
    });
  });

  it("欠損時は安全な既定 (transcribe / false / rtmpUrl 無し) にフォールバックする", () => {
    expect(toDesiredEvent({ id: "evt-2" })).toEqual({
      eventId: "evt-2",
      captionEngine: "transcribe",
      captionEnabled: true,
      customCaptionApi: false,
      rtmpUrl: undefined,
      streamKeyRef: undefined,
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

describe("classifyStackStatus: ROLLBACK 中の扱い (ADR 0023 D-2)", () => {
  // ROLLBACK_*_IN_PROGRESS は末尾一致で in_progress に落ちる。ここを failed にすると
  // planReconcile が巻き戻し中のスタックへ DeleteStack を撃つので、分類は変えない。
  // 代わりに handler 側が stack.status の "ROLLBACK" を見てサービス引き上げを止める。
  it("ROLLBACK 中は in_progress のまま (分類を変えると destroy が走る)", () => {
    expect(classifyStackStatus("ROLLBACK_IN_PROGRESS")).toBe("in_progress");
    expect(classifyStackStatus("UPDATE_ROLLBACK_IN_PROGRESS")).toBe("in_progress");
  });

  it("巻き戻しが終われば failed (destroy → 再作成に載る)", () => {
    expect(classifyStackStatus("ROLLBACK_COMPLETE")).toBe("failed");
    expect(classifyStackStatus("UPDATE_ROLLBACK_COMPLETE")).toBe("failed");
    expect(classifyStackStatus("ROLLBACK_FAILED")).toBe("failed");
  });
});

describe("toDesiredEvent: 字幕オフの配線 (ADR 0017 D-2)", () => {
  // ここが埋まっていないと reconcile が常に captionEnabled=true として扱い、
  // ADR 0017 の -35% が永久に効かない (D14 で実際にそうなっていた)。
  it("caption.enabled=false を captionEnabled に伝える", () => {
    const d = toDesiredEvent({ id: "e1", caption: { engine: "transcribe", enabled: false } });
    expect(d.captionEnabled).toBe(false);
  });

  it("未指定は有効扱い (既存イベントの字幕を黙って止めない)", () => {
    expect(toDesiredEvent({ id: "e1", caption: { engine: "transcribe" } }).captionEnabled).toBe(
      true,
    );
    expect(toDesiredEvent({ id: "e1" }).captionEnabled).toBe(true);
  });
});
