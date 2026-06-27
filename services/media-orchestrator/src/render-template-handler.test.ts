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
    // ADR 0017: Valkey は SFU sidecar に統合、CloudMap は不要。
    // SFU(+Egress+Valkey sidecar) + CaptionWorker = 2 サービス。
    expect(types.filter((t) => t === "AWS::ECS::Service")).toHaveLength(2);
  });
});
