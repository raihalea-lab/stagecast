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
    expect(types).toContain("AWS::ElastiCache::ServerlessCache");
    expect(types.filter((t) => t === "AWS::ECS::Service")).toHaveLength(3);
  });
});
