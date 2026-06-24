import { describe, expect, it } from "vitest";
import { handler } from "./render-template-handler.js";

describe("render-template-handler (D1)", () => {
  it("EventMediaStack の CloudFormation テンプレート JSON を返す", async () => {
    const { template } = await handler({
      eventId: "evt-a",
      captionEngine: "transcribe",
      customCaptionApi: false,
    });
    const parsed = JSON.parse(template) as { Resources: Record<string, { Type: string }> };
    const types = Object.values(parsed.Resources).map((r) => r.Type);
    // ADR 0010 D-6: Valkey は ServerlessCache から ReplicationGroup (cluster mode disabled) に切替。
    expect(types).toContain("AWS::ElastiCache::ReplicationGroup");
    // ADR 0010: Egress は SFU の sidecar として同 Task に同居するので独立 Service は 2 つ。
    expect(types.filter((t) => t === "AWS::ECS::Service")).toHaveLength(2);
  });
});
