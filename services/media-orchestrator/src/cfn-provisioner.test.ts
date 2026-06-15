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
  constructor(private readonly describe: () => DescribeResult) {}
  async createStack(input: { StackName: string }): Promise<{ StackId?: string }> {
    this.created.push(input.StackName);
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
});
