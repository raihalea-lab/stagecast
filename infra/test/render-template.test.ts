import { describe, expect, it } from 'vitest';
import { renderEventMediaTemplate } from '../lib/render-template';

describe('renderEventMediaTemplate (DESIGN.md 7.1)', () => {
  it('produces a valid CloudFormation template JSON with the expected resources', () => {
    const json = renderEventMediaTemplate({
      eventId: 'evt-a',
      captionEngine: 'transcribe',
      customCaptionApi: false,
    });
    const template = JSON.parse(json) as { Resources: Record<string, { Type: string }> };
    const types = Object.values(template.Resources).map((r) => r.Type);

    // メディアスタックの要となるリソースが含まれること
    expect(types).toContain('AWS::ElastiCache::ServerlessCache');
    expect(types.filter((t) => t === 'AWS::ECS::Service')).toHaveLength(3);
    expect(types).toContain('AWS::ECS::Cluster');
    expect(types).toContain('AWS::EC2::VPC');
  });

  it('is deterministic for the same spec', () => {
    const a = renderEventMediaTemplate({
      eventId: 'evt-x',
      captionEngine: 'llm',
      customCaptionApi: true,
    });
    const b = renderEventMediaTemplate({
      eventId: 'evt-x',
      captionEngine: 'llm',
      customCaptionApi: true,
    });
    expect(a).toBe(b);
  });
});
