import { describe, expect, it } from "vitest";
import {
  CloudFormationMediaStackProvisioner,
  type CloudFormationLike,
  type DescribeResult,
} from "./cfn-provisioner.js";
import type { EventMediaSpec } from "./provisioner.js";

function spec(eventId: string, customCaptionApi = false): EventMediaSpec {
  return { eventId, captionEngine: "transcribe", customCaptionApi };
}

const stackName = (eventId: string) => `StagecastEventMedia-${eventId}`;

class FakeCfn implements CloudFormationLike {
  readonly created: string[] = [];
  readonly deleted: string[] = [];
  /** createStack に渡された DeploymentMode (ADR 0023 D-1)。 */
  readonly createModes: (string | undefined)[] = [];
  constructor(private readonly describe: () => DescribeResult) {}
  async createStack(input: {
    StackName: string;
    DeploymentMode?: string | undefined;
  }): Promise<{ StackId?: string }> {
    this.created.push(input.StackName);
    this.createModes.push(input.DeploymentMode);
    return { StackId: `arn:${input.StackName}` };
  }
  async deleteStack(input: { StackName: string }): Promise<void> {
    this.deleted.push(input.StackName);
  }
  async describeStacks(): Promise<DescribeResult> {
    return this.describe();
  }
}

const noDelay = async () => {};

describe("CloudFormationMediaStackProvisioner (DESIGN.md 7.1)", () => {
  it("creates the stack, waits for completion and maps outputs", async () => {
    const cfn = new FakeCfn(() => ({
      Stacks: [
        {
          StackStatus: "CREATE_COMPLETE",
          Outputs: [{ OutputKey: "SfuUrl", OutputValue: "wss://sfu.real" }],
        },
      ],
    }));
    const p = new CloudFormationMediaStackProvisioner({
      cfn,
      renderTemplate: () => '{"Resources":{}}',
      stackName,
      delay: noDelay,
    });

    const handle = await p.provision(spec("evt-a", true));
    expect(cfn.created).toEqual(["StagecastEventMedia-evt-a"]);
    expect(handle.stackId).toBe("arn:StagecastEventMedia-evt-a");
    expect(handle.sfuUrl).toBe("wss://sfu.real"); // 出力を採用
    expect(handle.valkeyNamespace).toBe("evt-a");
    expect(handle.customCaptionApiUrl).toContain("evt-a"); // 規約で補完
  });

  it("polls until the stack reaches COMPLETE", async () => {
    let calls = 0;
    const cfn = new FakeCfn(() => ({
      Stacks: [{ StackStatus: ++calls < 3 ? "CREATE_IN_PROGRESS" : "CREATE_COMPLETE" }],
    }));
    const p = new CloudFormationMediaStackProvisioner({
      cfn,
      renderTemplate: () => "{}",
      stackName,
      delay: noDelay,
    });
    await p.provision(spec("evt-b"));
    expect(calls).toBe(3);
  });

  it("throws when the stack fails/rolls back", async () => {
    const cfn = new FakeCfn(() => ({ Stacks: [{ StackStatus: "ROLLBACK_COMPLETE" }] }));
    const p = new CloudFormationMediaStackProvisioner({
      cfn,
      renderTemplate: () => "{}",
      stackName,
      delay: noDelay,
    });
    await expect(p.provision(spec("evt-c"))).rejects.toThrow(/failed/);
  });

  it("destroy deletes the event stack by name", async () => {
    const cfn = new FakeCfn(() => ({ Stacks: [{ StackStatus: "CREATE_COMPLETE" }] }));
    const p = new CloudFormationMediaStackProvisioner({
      cfn,
      renderTemplate: () => "{}",
      stackName,
      delay: noDelay,
    });
    const handle = await p.provision(spec("evt-d"));
    await p.destroy(handle);
    expect(cfn.deleted).toEqual(["StagecastEventMedia-evt-d"]);
  });

  it("roleArn 指定時は createStack に RoleARN を渡す (R5)", async () => {
    let captured: { RoleARN?: string } | undefined;
    const cfn: CloudFormationLike = {
      async createStack(input) {
        captured = input;
        return { StackId: "id" };
      },
      async deleteStack() {},
      async describeStacks() {
        return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: [] }] };
      },
    };
    const p = new CloudFormationMediaStackProvisioner({
      cfn,
      renderTemplate: () => "{}",
      stackName,
      delay: noDelay,
      roleArn: "arn:aws:iam::111111111111:role/EventMediaCfnExecRole",
    });
    await p.provision(spec("evt-r5"));
    expect(captured?.RoleARN).toBe("arn:aws:iam::111111111111:role/EventMediaCfnExecRole");
  });

  it("renderTemplate が async (別 Lambda invoke 想定) でも待って TemplateBody に渡す (D1)", async () => {
    let body: string | undefined;
    const cfn: CloudFormationLike = {
      async createStack(input) {
        body = input.TemplateBody;
        return { StackId: "id" };
      },
      async deleteStack() {},
      async describeStacks() {
        return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: [] }] };
      },
    };
    const p = new CloudFormationMediaStackProvisioner({
      cfn,
      // Promise を返す renderTemplate (Lambda invoke を模す)。
      renderTemplate: async () => Promise.resolve('{"rendered":true}'),
      stackName,
      delay: noDelay,
    });
    await p.provision(spec("evt-async"));
    expect(body).toBe('{"rendered":true}');
  });

  it("roleArn 未指定時は RoleARN を渡さない", async () => {
    let captured: { RoleARN?: string } | undefined;
    const cfn: CloudFormationLike = {
      async createStack(input) {
        captured = input;
        return { StackId: "id" };
      },
      async deleteStack() {},
      async describeStacks() {
        return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: [] }] };
      },
    };
    const p = new CloudFormationMediaStackProvisioner({
      cfn,
      renderTemplate: () => "{}",
      stackName,
      delay: noDelay,
    });
    await p.provision(spec("evt-r5b"));
    expect(captured?.RoleARN).toBeUndefined();
  });

  it("describeStacks の一過性失敗は再試行で回復する (D8 横展開)", async () => {
    let calls = 0;
    const cfn = new FakeCfn(() => {
      calls += 1;
      if (calls === 1) throw new Error("Throttling");
      return { Stacks: [{ StackStatus: "CREATE_COMPLETE", Outputs: [] }] };
    });
    const p = new CloudFormationMediaStackProvisioner({
      cfn,
      renderTemplate: () => "{}",
      stackName,
      delay: noDelay,
    });
    const handle = await p.provision(spec("evt-retry"));
    expect(handle.status).toBe("running");
    expect(calls).toBeGreaterThanOrEqual(2); // 初回 throw → 再試行で COMPLETE
  });
});

describe("Express モード (ADR 0023 D-1)", () => {
  const completed = (): DescribeResult => ({ Stacks: [{ StackStatus: "CREATE_COMPLETE" }] });

  it("expressMode=true のとき createStack に EXPRESS を渡す", async () => {
    const cfn = new FakeCfn(completed);
    const p = new CloudFormationMediaStackProvisioner({
      cfn,
      renderTemplate: () => '{"Resources":{}}',
      stackName,
      delay: noDelay,
      expressMode: true,
    });
    await p.provision(spec("evt-express"));
    expect(cfn.createModes).toEqual(["EXPRESS"]);
  });

  it("既定 (未指定) では DeploymentMode を渡さない = CFN 既定の STANDARD", async () => {
    const cfn = new FakeCfn(completed);
    const p = new CloudFormationMediaStackProvisioner({
      cfn,
      renderTemplate: () => '{"Resources":{}}',
      stackName,
      delay: noDelay,
    });
    await p.provision(spec("evt-standard"));
    expect(cfn.createModes).toEqual([undefined]);
  });

  it("破棄は Express にしない (削除完了の先行報告で作り直しが名前衝突するため)", async () => {
    const cfn = new FakeCfn(completed);
    const p = new CloudFormationMediaStackProvisioner({
      cfn,
      renderTemplate: () => '{"Resources":{}}',
      stackName,
      delay: noDelay,
      expressMode: true,
    });
    await p.destroy({
      eventId: "evt-express",
      stackId: stackName("evt-express"),
      status: "destroying",
      sfuUrl: "",
      captionPipelineId: "",
      valkeyNamespace: "evt-express",
    });
    expect(cfn.deleted).toEqual([stackName("evt-express")]);
  });
});
