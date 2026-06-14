import { describe, expect, it, vi } from 'vitest';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import {
  AwsCloudFormationClient,
  createAwsMediaStackProvisioner,
  eventMediaStackName,
} from './aws-cfn.js';
import type { EventMediaSpec } from './provisioner.js';

const spec: EventMediaSpec = {
  eventId: 'evt-a',
  captionEngine: 'transcribe',
  customCaptionApi: false,
};

describe('AwsCloudFormationClient', () => {
  it('maps create/delete/describe to SDK commands', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ StackId: 'arn:stack/evt-a' }) // create
      .mockResolvedValueOnce({}) // delete
      .mockResolvedValueOnce({
        Stacks: [
          { StackStatus: 'CREATE_COMPLETE', Outputs: [{ OutputKey: 'K', OutputValue: 'V' }] },
        ],
      }); // describe
    const cfn = new AwsCloudFormationClient({ send } as unknown as CloudFormationClient);

    const created = await cfn.createStack({
      StackName: 's',
      TemplateBody: '{}',
      Capabilities: ['CAPABILITY_IAM'],
    });
    expect(created.StackId).toBe('arn:stack/evt-a');
    expect(send.mock.calls[0][0].input).toMatchObject({ StackName: 's', TemplateBody: '{}' });

    await cfn.deleteStack({ StackName: 's' });
    expect(send.mock.calls[1][0].input).toMatchObject({ StackName: 's' });

    const described = await cfn.describeStacks({ StackName: 's' });
    expect(described.Stacks?.[0]).toEqual({
      StackStatus: 'CREATE_COMPLETE',
      Outputs: [{ OutputKey: 'K', OutputValue: 'V' }],
    });
  });
});

describe('createAwsMediaStackProvisioner (配線の合流点)', () => {
  it('wires renderTemplate + cfn into a working provisioner using the stack-name convention', async () => {
    const renderTemplate = vi.fn(
      (s: EventMediaSpec) => `{"Resources":{"x":{"eventId":"${s.eventId}"}}}`,
    );
    const send = vi
      .fn()
      .mockResolvedValueOnce({ StackId: 'arn:StagecastEventMedia-evt-a' }) // create
      .mockResolvedValueOnce({ Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] }); // describe
    const provisioner = createAwsMediaStackProvisioner({
      renderTemplate,
      cfn: new AwsCloudFormationClient({ send } as unknown as CloudFormationClient),
      pollIntervalMs: 0,
      maxPolls: 1,
    });

    const handle = await provisioner.provision(spec);
    expect(renderTemplate).toHaveBeenCalledWith(spec);
    // create に渡る StackName は規約どおり
    expect(send.mock.calls[0][0].input.StackName).toBe('StagecastEventMedia-evt-a');
    expect(handle.eventId).toBe('evt-a');
  });

  it('stack-name convention matches the documented format', () => {
    expect(eventMediaStackName('evt-1')).toBe('StagecastEventMedia-evt-1');
  });
});
