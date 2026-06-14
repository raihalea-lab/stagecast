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
});
