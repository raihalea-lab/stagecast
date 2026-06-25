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
    // ADR 0015: ElastiCache 廃止 → Fargate Valkey + CloudMap。
    expect(types).toContain("AWS::ServiceDiscovery::PrivateDnsNamespace");
    // ADR 0015: Valkey + SFU + CaptionWorker = 3 サービス。
    expect(types.filter((t) => t === "AWS::ECS::Service")).toHaveLength(3);
  });
});
