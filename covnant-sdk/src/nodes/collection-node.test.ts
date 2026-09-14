import { beforeEach, describe, expect, it } from 'vitest';
import { RIGHTS_PIPELINES } from '../contracts/royalty-event';
import {
  NODE_REGISTRY,
  SdkNotConfiguredError,
  buildNodeRegistry,
  getCollectionNode,
  registerCollectionNode,
  resetCollectionNodes,
} from './collection-node';
import type { CollectionNode } from './collection-node';

/** A registry stub — fails the configuration gate by default. */
function stubNode(overrides: Partial<CollectionNode> = {}): CollectionNode {
  return {
    platform: 'locked_dsp',
    pipelines: ['master_digital_performance'],
    isConfigured: () => false,
    ingestWebhook: async () => [],
    parseStatement: async () => [],
    ...overrides,
  };
}

function thrownNotConfigured(fn: () => unknown): SdkNotConfiguredError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SdkNotConfiguredError) return error;
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('NODE_REGISTRY — the v1 sandbox roster', () => {
  it('registers exactly the four roster platforms', () => {
    expect(Object.keys(NODE_REGISTRY).sort()).toEqual(
      ['ascap', 'spotify', 'the_mlc', 'youtube_content_id'].sort(),
    );
  });

  it('carries all four pipelines across the roster — none missing, none foreign', () => {
    const covered = new Set(
      Object.values(NODE_REGISTRY).flatMap((node) => node.pipelines),
    );
    expect([...covered].sort()).toEqual([...RIGHTS_PIPELINES].sort());
    expect(covered.size).toBe(RIGHTS_PIPELINES.length);
  });

  it('every registered node passes the configuration gate today (sandbox)', () => {
    for (const node of Object.values(NODE_REGISTRY)) {
      expect(node.isConfigured()).toBe(true);
    }
  });

  it('each node collects for at least one valid pipeline, no duplicates', () => {
    for (const node of Object.values(NODE_REGISTRY)) {
      expect(node.pipelines.length).toBeGreaterThan(0);
      expect(new Set(node.pipelines).size).toBe(node.pipelines.length);
    }
  });
});

describe('getCollectionNode — the fail-closed gate', () => {
  beforeEach(() => {
    resetCollectionNodes();
  });

  it('hands back the registered node for each roster platform', () => {
    const platforms: string[] = [];
    for (const [platform, node] of Object.entries(NODE_REGISTRY)) {
      expect(getCollectionNode(platform)).toBe(node);
      platforms.push(platform);
    }
    expect(platforms).toHaveLength(4);
  });

  it('throws <platform>_not_configured for an unknown platform', () => {
    const error = thrownNotConfigured(() => getCollectionNode('no_such_dsp'));
    expect(error.code).toBe('no_such_dsp_not_configured');
    expect(error).toBeInstanceOf(Error);
  });

  it('throws <platform>_not_configured for a registered node that is not configured', () => {
    registerCollectionNode(stubNode({ platform: 'locked_dsp' }));
    const error = thrownNotConfigured(() => getCollectionNode('locked_dsp'));
    expect(error.code).toBe('locked_dsp_not_configured');
  });

  it('the registration seam never mutates NODE_REGISTRY, and reset restores it', () => {
    registerCollectionNode(stubNode({ platform: 'locked_dsp' }));
    expect('locked_dsp' in NODE_REGISTRY).toBe(false);
    resetCollectionNodes();
    expect(thrownNotConfigured(() => getCollectionNode('locked_dsp')).code).toBe(
      'locked_dsp_not_configured',
    );
  });

  it('there is no silent no-op path: the gate never returns an unconfigured node', () => {
    // Every way in either works or throws — probe a wide key space.
    for (const platform of ['', 'SPOTIFY', 'spotify ', 'nonexistent', '__proto__']) {
      expect(() => getCollectionNode(platform)).toThrow(SdkNotConfiguredError);
    }
  });
});

describe('buildNodeRegistry — construction-time discipline', () => {
  it('rejects a duplicate platform inside the node list', () => {
    const first = stubNode({ platform: 'locked_dsp', isConfigured: () => true });
    const second = stubNode({ platform: 'locked_dsp', isConfigured: () => true });
    expect(() => buildNodeRegistry([first, second])).toThrow(
      /duplicate_node_platform:locked_dsp/,
    );
  });
});
