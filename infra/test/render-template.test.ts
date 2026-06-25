import { describe, expect, it } from "vitest";
import { renderEventMediaTemplate } from "../lib/render-template";

describe("renderEventMediaTemplate (DESIGN.md 7.1)", () => {
  it("produces a valid CloudFormation template JSON with the expected resources", () => {
    const json = renderEventMediaTemplate({
      eventId: "evt-a",
      captionEngine: "transcribe",
      customCaptionApi: false,
    });
    const template = JSON.parse(json) as { Resources: Record<string, { Type: string }> };
    const types = Object.values(template.Resources).map((r) => r.Type);

    // メディアスタックの要となるリソースが含まれること
    // ADR 0015: ElastiCache 廃止 → Fargate Valkey + CloudMap。
    expect(types).toContain("AWS::ServiceDiscovery::PrivateDnsNamespace");
    // ADR 0015: Valkey + SFU + CaptionWorker = 3 サービス。
    expect(types.filter((t) => t === "AWS::ECS::Service")).toHaveLength(3);
    expect(types).toContain("AWS::ECS::Cluster");
    expect(types).toContain("AWS::EC2::VPC");
  });

  it("is deterministic for the same spec", () => {
    const a = renderEventMediaTemplate({
      eventId: "evt-x",
      captionEngine: "llm",
      customCaptionApi: true,
    });
    const b = renderEventMediaTemplate({
      eventId: "evt-x",
      captionEngine: "llm",
      customCaptionApi: true,
    });
    expect(a).toBe(b);
  });

  it("CAPTION_WORKER_IMAGE env を caption-worker イメージに反映する (R4)", () => {
    const uri = "111111111111.dkr.ecr.ap-northeast-1.amazonaws.com/stagecast/caption-worker:latest";
    const prev = process.env.CAPTION_WORKER_IMAGE;
    process.env.CAPTION_WORKER_IMAGE = uri;
    try {
      const json = renderEventMediaTemplate({
        eventId: "evt-r4",
        captionEngine: "transcribe",
        customCaptionApi: false,
      });
      // ECR URI がテンプレートに現れ、実行ロールに ECR pull 権限が付く。
      expect(json).toContain(uri);
      expect(json).toContain("ecr:GetAuthorizationToken");
    } finally {
      if (prev === undefined) delete process.env.CAPTION_WORKER_IMAGE;
      else process.env.CAPTION_WORKER_IMAGE = prev;
    }
  });
});
