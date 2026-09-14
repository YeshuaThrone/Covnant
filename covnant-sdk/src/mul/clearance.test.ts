import { describe, expect, it } from 'vitest';
import { getCollectionNode } from '../nodes/collection-node';
import {
  CLEARANCE_STATES,
  CLEARANCE_TRANSITIONS,
  ClearanceBlockedError,
  ClearanceTransitionError,
  MulClearanceValidationError,
  assertCollectible,
  assertDispatchable,
  clearanceFromRecord,
  clearanceToRecord,
  getClearance,
  transitionClearance,
  transitionFromRecord,
  type ClearanceState,
  type ClearanceStore,
  type MulClearance,
  type MulClearanceRecord,
  type MulClearanceTransitionRecord,
} from './clearance';

/**
 * The clearance machine and the dispatch gate. Every legal edge, every
 * illegal edge, expiry and revoke, the fail-closed gate codes, the
 * 'revoked' widening across the PR 3 store vocabulary, and the
 * uncleared-asset → node-refuses dispatch composition.
 */

const ASSET = 'CBT-TRK-A1B2C3D4E5F6';
const LICENSEE = 'Merlin Events LLC';

/** Minimal in-memory ClearanceStore — the SDK module's own seam, no app graph. */
function stubStore(): ClearanceStore & {
  transitions: MulClearanceTransitionRecord[];
} {
  const clearances = new Map<string, MulClearanceRecord>();
  const transitions: MulClearanceTransitionRecord[] = [];
  return {
    transitions,
    async upsertClearance(row: MulClearanceRecord) {
      clearances.set(row.asset_cbt_code, row);
      return row;
    },
    async getClearanceForAsset(assetCbtCode: string) {
      return clearances.get(assetCbtCode);
    },
    async insertClearanceTransition(row: Omit<MulClearanceTransitionRecord, 'id'>) {
      const record: MulClearanceTransitionRecord = {
        ...row,
        id: `txn-${transitions.length + 1}`,
      };
      transitions.push(record);
      return record;
    },
    async listClearanceTransitions(assetCbtCode: string) {
      return transitions.filter((row) => row.asset_cbt_code === assetCbtCode);
    },
  };
}

/**
 * Drives the machine to a given state the legal way. BFS over the module's
 * own transition table finds the shortest legal path from whatever state the
 * asset is actually in — the helper never re-walks satisfied steps and never
 * invents an edge the machine does not name.
 */
async function machineTo(
  store: ReturnType<typeof stubStore>,
  state: ClearanceState,
): Promise<MulClearance> {
  const startRow = await store.getClearanceForAsset(ASSET);
  const start: ClearanceState | null = startRow?.state ?? null;
  if (start === state && startRow !== undefined) {
    return clearanceFromRecord(startRow);
  }
  const queue: Array<{ from: ClearanceState | null; path: ClearanceState[] }> = [
    { from: start, path: [] },
  ];
  while (queue.length > 0) {
    const head = queue.shift() as { from: ClearanceState | null; path: ClearanceState[] };
    const exits: ClearanceState[] =
      head.from === null ? ['draft'] : [...CLEARANCE_TRANSITIONS[head.from]];
    for (const to of exits) {
      const nextPath: ClearanceState[] = [...head.path, to];
      if (nextPath.length > 6) continue; // cycle guard — the machine is 5 states
      if (to === state) {
        let clearance: MulClearance | null = null;
        for (const step of nextPath) {
          clearance = await transitionClearance(store, {
            assetCbtCode: ASSET,
            to: step,
            licensee: step === 'requested' ? LICENSEE : undefined,
            territory: step === 'requested' ? 'US' : undefined,
            note: `machineTo:${step}`,
          });
        }
        return clearance as MulClearance;
      }
      queue.push({ from: to, path: nextPath });
    }
  }
  throw new Error(`machineTo: the machine names no legal path to ${state}`);
}

async function refusedTransition(
  fn: () => Promise<unknown>,
): Promise<ClearanceTransitionError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ClearanceTransitionError) return error;
    throw error;
  }
  throw new Error('expected the transition to be refused');
}

function blocked(fn: () => unknown): ClearanceBlockedError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ClearanceBlockedError) return error;
    throw error;
  }
  throw new Error('expected the gate to block');
}

describe('the machine — legal edges', () => {
  it('initializes an absent clearance as draft, with a null from_state', async () => {
    const store = stubStore();
    const clearance = await transitionClearance(store, { assetCbtCode: ASSET, to: 'draft' });
    expect(clearance).toEqual({
      assetCbtCode: ASSET,
      state: 'draft',
      licensee: null,
      territory: null,
      termStart: null,
      termEnd: null,
    });
    const history = await store.listClearanceTransitions(ASSET);
    expect(history).toHaveLength(1);
    expect(history[0]?.from_state).toBeNull();
    expect(history[0]?.to_state).toBe('draft');
  });

  it('walks draft → requested → cleared and keeps the history oldest-first', async () => {
    const store = stubStore();
    await transitionClearance(store, { assetCbtCode: ASSET, to: 'draft' });
    await transitionClearance(store, {
      assetCbtCode: ASSET,
      to: 'requested',
      licensee: LICENSEE,
      territory: 'US',
      note: 'license request sent',
    });
    const cleared = await transitionClearance(store, { assetCbtCode: ASSET, to: 'cleared' });
    expect(cleared.state).toBe('cleared');
    expect(cleared.licensee).toBe(LICENSEE);
    expect(cleared.territory).toBe('US');

    const history = (await store.listClearanceTransitions(ASSET)).map((row) =>
      transitionFromRecord(row),
    );
    expect(history.map((row) => `${row.fromState ?? 'none'}->${row.toState}`)).toEqual([
      'none->draft',
      'draft->requested',
      'requested->cleared',
    ]);
    expect(history[1]?.note).toBe('license request sent');
  });

  it('disputes and revokes from cleared, and recovers each back to cleared', async () => {
    for (const terminal of ['disputed', 'revoked'] as const) {
      const store = stubStore();
      await machineTo(store, terminal);
      const recovered = await transitionClearance(store, {
        assetCbtCode: ASSET,
        to: 'cleared',
        note: `${terminal} resolved`,
      });
      expect(recovered.state).toBe('cleared');
      const history = (await store.listClearanceTransitions(ASSET)).map((row) =>
        transitionFromRecord(row),
      );
      expect(history.map((row) => row.toState)).toEqual([
        'draft',
        'requested',
        'cleared',
        terminal,
        'cleared',
      ]);
    }
  });

  it('preserves licensee, territory, and terms on transitions that omit them', async () => {
    const store = stubStore();
    await machineTo(store, 'cleared');
    const disputed = await transitionClearance(store, {
      assetCbtCode: ASSET,
      to: 'disputed',
      note: 'ownership contested',
    });
    expect(disputed.licensee).toBe(LICENSEE);
    expect(disputed.territory).toBe('US');
  });

  it('canonically persists term boundaries as ISO strings', async () => {
    const store = stubStore();
    await machineTo(store, 'requested');
    const cleared = await transitionClearance(store, {
      assetCbtCode: ASSET,
      to: 'cleared',
      termStart: '2026-09-01T00:00:00Z',
      termEnd: '2027-08-31T23:59:59.999Z',
    });
    expect(cleared.termStart).toBe('2026-09-01T00:00:00.000Z');
    expect(cleared.termEnd).toBe('2027-08-31T23:59:59.999Z');
  });
});

describe('the machine — every illegal edge is a typed refusal', () => {
  it('refuses edges the transition table does not name', async () => {
    const cases: Array<{ from: ClearanceState | null; to: ClearanceState }> = [
      // Skipping the draft — a license nobody requested cannot be granted.
      { from: null, to: 'requested' },
      { from: null, to: 'cleared' },
      { from: null, to: 'disputed' },
      { from: null, to: 'revoked' },
      // Forward jumps and same-state no-ops.
      { from: 'draft', to: 'cleared' },
      { from: 'draft', to: 'disputed' },
      { from: 'draft', to: 'revoked' },
      { from: 'draft', to: 'draft' },
      { from: 'requested', to: 'disputed' },
      { from: 'requested', to: 'revoked' },
      { from: 'requested', to: 'requested' },
      // Cleared only exits into its terminal states — never backwards.
      { from: 'cleared', to: 'draft' },
      { from: 'cleared', to: 'requested' },
      { from: 'cleared', to: 'cleared' },
      // Terminal-with-recovery means exactly one exit — cleared. Nothing else.
      { from: 'disputed', to: 'draft' },
      { from: 'disputed', to: 'requested' },
      { from: 'disputed', to: 'disputed' },
      { from: 'disputed', to: 'revoked' },
      { from: 'revoked', to: 'draft' },
      { from: 'revoked', to: 'requested' },
      { from: 'revoked', to: 'revoked' },
      { from: 'revoked', to: 'disputed' },
    ];
    for (const { from, to } of cases) {
      const store = stubStore();
      if (from !== null) await machineTo(store, from);
      const transitionsBefore = store.transitions.length;
      const error = await refusedTransition(() =>
        transitionClearance(store, { assetCbtCode: ASSET, to }),
      );
      const fromLabel = from ?? 'none';
      expect(error.code).toBe(`invalid_transition:${fromLabel}->${to}`);
      // A refused edge writes nothing: no new row (from none) and no change
      // to the existing one, and no history entry either way.
      const row = await store.getClearanceForAsset(ASSET);
      if (from === null) {
        expect(row).toBeUndefined();
      } else {
        expect(row?.state).toBe(from);
      }
      expect(store.transitions).toHaveLength(transitionsBefore);
    }
  });

  it('carries the transition table in sync with the state roster', () => {
    expect(Object.keys(CLEARANCE_TRANSITIONS).sort()).toEqual([...CLEARANCE_STATES].sort());
  });
});

describe('field validation — fail-closed on write', () => {
  it('rejects a malformed asset CBT code', async () => {
    const store = stubStore();
    await expect(
      transitionClearance(store, { assetCbtCode: 'not-a-cbt-code', to: 'draft' }),
    ).rejects.toMatchObject({
      name: 'MulClearanceValidationError',
      code: 'invalid_asset_cbt_code',
    });
  });

  it('rejects territories that are not ISO 3166-1 alpha-2', async () => {
    const store = stubStore();
    await machineTo(store, 'draft'); // the walk must be legal — field validation is under test
    for (const territory of ['usa', 'us', 'U', 'US1', 42]) {
      await expect(
        transitionClearance(store, {
          assetCbtCode: ASSET,
          to: 'requested',
          territory: territory as string,
        }),
      ).rejects.toMatchObject({ name: 'MulClearanceValidationError', code: 'invalid_territory' });
    }
  });

  it('rejects unparseable terms and an inverted range', async () => {
    const store = stubStore();
    await machineTo(store, 'requested');
    await expect(
      transitionClearance(store, {
        assetCbtCode: ASSET,
        to: 'cleared',
        termEnd: 'not-a-date',
      }),
    ).rejects.toMatchObject({ name: 'MulClearanceValidationError', code: 'invalid_term' });
    await expect(
      transitionClearance(store, {
        assetCbtCode: ASSET,
        to: 'cleared',
        termStart: '2027-01-01T00:00:00Z',
        termEnd: '2026-01-01T00:00:00Z',
      }),
    ).rejects.toMatchObject({
      name: 'MulClearanceValidationError',
      code: 'invalid_term_range',
    });
  });

  it('refuses an unknown requested state before reading the row', async () => {
    const store = stubStore();
    await expect(
      transitionClearance(store, {
        assetCbtCode: ASSET,
        to: 'granted' as unknown as ClearanceState,
      }),
    ).rejects.toMatchObject({
      name: 'MulClearanceValidationError',
      code: 'invalid_clearance_state',
    });
  });
});

describe('assertCollectible — the dispatch gate', () => {
  const NOW = new Date('2026-09-14T12:00:00Z');

  function clearedWithin(overrides: Partial<MulClearance> = {}): MulClearance {
    return {
      assetCbtCode: ASSET,
      state: 'cleared',
      licensee: LICENSEE,
      territory: 'US',
      termStart: null,
      termEnd: null,
      ...overrides,
    };
  }

  it('passes a cleared asset with no term bounds', () => {
    expect(() => assertCollectible(clearedWithin(), NOW)).not.toThrow();
  });

  it('blocks absent clearances — null and undefined alike', () => {
    expect(blocked(() => assertCollectible(null, NOW)).code).toBe('clearance_missing');
    expect(blocked(() => assertCollectible(undefined, NOW)).code).toBe('clearance_missing');
  });

  it('blocks every non-cleared state with its own stable code', async () => {
    const store = stubStore();
    for (const state of ['draft', 'requested', 'disputed', 'revoked'] as const) {
      const clearance = await machineTo(store, state);
      const error = blocked(() => assertCollectible(clearance, NOW));
      expect(error.code).toBe(`clearance_${state}`);
      expect(error.assetCbtCode).toBe(ASSET);
    }
  });

  it('treats an expired term as NOT cleared — and the boundary is inclusive', () => {
    const termEnd = '2027-08-31T23:59:59.999Z';
    expect(() => assertCollectible(clearedWithin({ termEnd }), NOW)).not.toThrow();
    expect(() =>
      assertCollectible(clearedWithin({ termEnd }), new Date(termEnd)),
    ).not.toThrow();
    expect(
      blocked(() =>
        assertCollectible(clearedWithin({ termEnd }), new Date('2027-09-01T00:00:00Z')),
      ).code,
    ).toBe('clearance_term_expired');
  });

  it('blocks dispatch before the term starts', () => {
    const termStart = '2026-10-01T00:00:00Z';
    expect(() =>
      assertCollectible(clearedWithin({ termStart }), new Date(termStart)),
    ).not.toThrow();
    expect(
      blocked(() =>
        assertCollectible(clearedWithin({ termStart }), new Date('2026-09-30T23:59:59Z')),
      ).code,
    ).toBe('clearance_term_not_started');
  });

  it('blocks a term window that closed — start before now, end before now', () => {
    const clearance = clearedWithin({
      termStart: '2026-01-01T00:00:00Z',
      termEnd: '2026-06-30T23:59:59.999Z',
    });
    expect(blocked(() => assertCollectible(clearance, NOW)).code).toBe('clearance_term_expired');
  });

  it('blocks a corrupt stored term instead of guessing', () => {
    const clearance = clearedWithin({ termEnd: 'corrupt' });
    expect(blocked(() => assertCollectible(clearance, NOW)).code).toBe('clearance_term_invalid');
  });
});

describe('the store-row boundary', () => {
  it('round-trips every state — including revoked — through the row shape', () => {
    for (const state of CLEARANCE_STATES) {
      const row = clearanceToRecord({
        assetCbtCode: ASSET,
        state,
        licensee: LICENSEE,
        territory: 'US',
        termStart: null,
        termEnd: null,
      });
      // The PR 3 vocabulary's TS union is narrower than the machine; the
      // row carries the runtime value either way (unconstrained TEXT column).
      expect(row.state).toBe(state);
      expect(clearanceFromRecord(row).state).toBe(state);
    }
  });

  it('parses a corrupted row as a typed failure, never a silent passthrough', () => {
    expect(() =>
      clearanceFromRecord({
        asset_cbt_code: ASSET,
        state: 'granted' as unknown as MulClearanceRecord['state'],
        licensee: null,
        territory: null,
        term_start: null,
        term_end: null,
        updated_at: '2026-09-14T00:00:00.000Z',
      }),
    ).toThrow(MulClearanceValidationError);
    expect(() =>
      clearanceFromRecord({
        asset_cbt_code: ASSET,
        state: 'cleared',
        licensee: null,
        territory: 'usa',
        term_start: null,
        term_end: null,
        updated_at: '2026-09-14T00:00:00.000Z',
      }),
    ).toThrow(MulClearanceValidationError);
  });
});

describe('dispatch composition — an uncleared asset makes the node refuse', () => {
  /** The canonical wire shape the sandbox nodes ingest (nodes/sandbox-nodes.test.ts). */
  function wireEvent(eventId: string): Record<string, unknown> {
    return {
      eventId,
      rightsPipeline: 'master_digital_performance',
      source: 'webhook',
      period: '2026-08',
      currency: 'USD',
      grossMicros: 1234567890n,
      identifiers: { ISRC: 'USS1M2677777' },
      platform: 'SPOTIFY',
      territory: 'US',
      raw: { provider: 'test-suite', reference_id: eventId },
    };
  }

  it("gates a sandbox node's material on the asset's clearance, fail-closed", async () => {
    const store = stubStore();
    const node = getCollectionNode('spotify'); // fail-closed registry (PR 5)
    const [event] = await node.ingestWebhook(wireEvent('evt_gate_0001'));
    expect(event).toBeDefined();

    const assetCbtCode = ASSET;

    // No clearance row — the Blocked row's "No clearance": the node refuses.
    await expect(assertDispatchable(store, assetCbtCode)).rejects.toMatchObject({
      name: 'ClearanceBlockedError',
      code: 'clearance_missing',
    });

    // The machine walks to cleared; the gate opens.
    await machineTo(store, 'cleared');
    const proof = await assertDispatchable(store, assetCbtCode);
    expect(proof.state).toBe('cleared');
    expect(proof.assetCbtCode).toBe(assetCbtCode);

    // Revoked — the license ended: the node refuses again, same gate.
    await transitionClearance(store, { assetCbtCode: assetCbtCode, to: 'revoked' });
    await expect(assertDispatchable(store, assetCbtCode)).rejects.toMatchObject({
      name: 'ClearanceBlockedError',
      code: 'clearance_revoked',
    });
  });

  it('keeps read-only reads distinct from the gate — absence is null, not draft', async () => {
    const store = stubStore();
    expect(await getClearance(store, ASSET)).toBeNull();
  });
});
