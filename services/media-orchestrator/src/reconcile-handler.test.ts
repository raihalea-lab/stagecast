import { describe, expect, it } from "vitest";
import { classifyStackStatus } from "./reconcile-handler.js";

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
