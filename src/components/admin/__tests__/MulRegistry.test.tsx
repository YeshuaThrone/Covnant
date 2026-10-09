/**
 * @vitest-environment jsdom
 *
 * MulRegistry — the MUL Registry's operator surface:
 *   - the summary band counts by state from real rows;
 *   - the table renders every clearance (asset link, badge, licensee,
 *     territory, term, last transition) and the expired indicator applies
 *     the machine's own rule;
 *   - the state filter and pagination narrow the table;
 *   - empty states are honest (registry empty vs filter empty);
 *   - the history drawer reads the existing single-asset GET and replays
 *     the audit trail oldest-first;
 *   - the actions offer ONLY legal edges (CLEARANCE_TRANSITIONS-derived);
 *   - a successful action POSTs { assetCbtCode, to, note } and refreshes;
 *   - a refusal (409) SURFACES the machine's error — never a silent no-op.
 *
 * jsdom + createRoot/act — Testing Library is NOT used in this repo.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MulRegistry, clearanceTermExpired, type MulRegistryData } from '@/components/admin/MulRegistry';
import type { MulClearanceRecord } from '@/modules/sdk/records';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  mounted.length = 0;
});

function mount(ui: React.ReactElement): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  mounted.push({ root, container });
  return container;
}

function record(overrides: Partial<MulClearanceRecord> = {}): MulClearanceRecord {
  return {
    asset_cbt_code: 'CBT-TEST-0001',
    state: 'draft',
    licensee: null,
    territory: null,
    term_start: null,
    term_end: null,
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function readyData(clearances: MulClearanceRecord[]): MulRegistryData {
  return { kind: 'ready', clearances };
}

const NOW = '2026-10-09T00:00:00.000Z';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// The single-asset GET contract replays oldest-first (tested at the route
// layer); the drawer preserves the API's order exactly.
const singleAssetRead = {
  ok: true,
  found: true,
  clearance: {
    assetCbtCode: 'CBT-TEST-0001',
    state: 'cleared',
    licensee: 'Northwind Films',
    territory: 'US',
    termStart: '2026-01-01T00:00:00.000Z',
    termEnd: '2027-01-01T00:00:00.000Z',
  },
  transitions: [
    {
      id: 't1',
      assetCbtCode: 'CBT-TEST-0001',
      fromState: null,
      toState: 'draft',
      note: null,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    {
      id: 't2',
      assetCbtCode: 'CBT-TEST-0001',
      fromState: 'requested',
      toState: 'cleared',
      note: null,
      createdAt: '2026-10-02T00:00:00.000Z',
    },
  ],
};

/** What the route answers after the machine moved to disputed: the fresh
 * clearance plus the appended transition, in the oldest-first replay. */
const disputedAssetRead = {
  ...singleAssetRead,
  clearance: { ...singleAssetRead.clearance, state: 'disputed' },
  transitions: [
    ...singleAssetRead.transitions,
    {
      id: 't3',
      assetCbtCode: 'CBT-TEST-0001',
      fromState: 'cleared',
      toState: 'disputed',
      note: 'Verified against the signed license.',
      createdAt: '2026-10-03T00:00:00.000Z',
    },
  ],
};

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('clearanceTermExpired', () => {
  it('treats an expired term as expired (the machine: expired is NOT cleared)', () => {
    expect(clearanceTermExpired('2026-10-08T00:00:00.000Z', NOW)).toBe(true);
  });

  it('treats a live term as not expired, through its end instant', () => {
    expect(clearanceTermExpired('2026-10-09T00:00:00.000Z', NOW)).toBe(false);
    expect(clearanceTermExpired('2027-01-01T00:00:00.000Z', NOW)).toBe(false);
  });

  it('treats an open term and an unparseable term as not expired', () => {
    expect(clearanceTermExpired(null, NOW)).toBe(false);
    expect(clearanceTermExpired('not-a-date', NOW)).toBe(false);
  });
});

describe('MulRegistry', () => {
  it('renders the summary band and one row per clearance from real store data', () => {
    const container = mount(
      <MulRegistry
        data={readyData([
          record(),
          record({ asset_cbt_code: 'CBT-TEST-0002', state: 'cleared' }),
          record({ asset_cbt_code: 'CBT-TEST-0003', state: 'disputed' }),
        ])}
        nowIso={NOW}
      />,
    );

    expect(container.querySelector('[data-testid="mul-count-draft"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="mul-count-cleared"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="mul-count-disputed"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="mul-count-requested"]')?.textContent).toBe('0');
    expect(container.querySelectorAll('[data-mul="row"]').length).toBe(3);

    const link = container.querySelector<HTMLAnchorElement>('[data-testid="mul-table"] a');
    expect(link?.getAttribute('href')).toBe('/assets/CBT-TEST-0001');

    const clearedBadge = container.querySelector('[data-mul-state="cleared"][data-mul="state-badge"]');
    expect(clearedBadge?.textContent).toBe('cleared');
  });

  it('flags an expired term explicitly — the machine says expired is NOT cleared', () => {
    const container = mount(
      <MulRegistry
        data={readyData([
          record({
            state: 'cleared',
            term_start: '2025-01-01T00:00:00.000Z',
            term_end: '2026-01-01T00:00:00.000Z',
          }),
        ])}
        nowIso={NOW}
      />,
    );

    expect(container.querySelector('[data-mul="expired"]')).not.toBeNull();
  });

  it('filters by state from the summary chips', () => {
    const container = mount(
      <MulRegistry
        data={readyData([
          record(),
          record({ asset_cbt_code: 'CBT-TEST-0002', state: 'cleared' }),
        ])}
        nowIso={NOW}
      />,
    );

    const chip = container.querySelector<HTMLButtonElement>('[data-mul="filter-cleared"]');
    act(() => {
      chip?.click();
    });

    const rows = container.querySelectorAll('[data-mul="row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].getAttribute('data-mul-state')).toBe('cleared');
  });

  it('says honestly when the registry is empty vs when a filter has no matches', () => {
    const empty = mount(<MulRegistry data={readyData([])} nowIso={NOW} />);
    expect(empty.querySelector('[data-testid="mul-table-empty"]')?.textContent).toContain(
      'registry is empty',
    );

    const noneInFilter = mount(
      <MulRegistry data={readyData([record({ state: 'cleared' })])} nowIso={NOW} />,
    );
    act(() => {
      noneInFilter.querySelector<HTMLButtonElement>('[data-mul="filter-disputed"]')?.click();
    });
    expect(noneInFilter.querySelector('[data-testid="mul-table-empty"]')?.textContent).toContain(
      'No clearances in state disputed',
    );
  });

  it('renders the honest notice when the read is unavailable', () => {
    const container = mount(
      <MulRegistry
        data={{ kind: 'unavailable', message: 'The registry read failed.' }}
        nowIso={NOW}
      />,
    );
    expect(container.querySelector('[data-testid="mul-unavailable"]')?.textContent).toContain(
      'The registry read failed.',
    );
  });

  it('paginates beyond one page of rows', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      record({ asset_cbt_code: `CBT-TEST-${String(index + 1).padStart(4, '0')}` }),
    );
    const container = mount(<MulRegistry data={readyData(many)} nowIso={NOW} />);

    expect(container.querySelectorAll('[data-mul="row"]').length).toBe(25);
    expect(container.querySelector('[data-testid="mul-pagination"]')?.textContent).toContain(
      'Page 1 of 2',
    );

    const next = container.querySelector<HTMLButtonElement>(
      '[data-testid="mul-pagination"] button:last-child',
    );
    act(() => {
      next?.click();
    });
    expect(container.querySelectorAll('[data-mul="row"]').length).toBe(5);
  });

  it('opens the history drawer, reads the single-asset GET, and replays oldest-first', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(singleAssetRead));
    vi.stubGlobal('fetch', fetchMock);

    const container = mount(<MulRegistry data={readyData([record()])} nowIso={NOW} />);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-mul="history-button"]')?.click();
    });
    // Second flush: the drawer's fetch chain resolves in later microtasks.
    await act(async () => {});

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/mul/clearances?asset_cbt_code=CBT-TEST-0001',
      expect.objectContaining({ cache: 'no-store' }),
    );
    const entries = container.querySelectorAll('[data-mul="history-entry"]');
    expect(entries.length).toBe(2);
    // The drawer preserves the API's oldest-first replay: t1 (null → draft)
    // before t2 (requested → cleared).
    expect((entries[0] as HTMLElement).getAttribute('data-mul-index')).toBe('0');
    expect(entries[0].textContent).toContain('draft');
    expect(entries[1].textContent).toContain('cleared');

    vi.unstubAllGlobals();
  });

  it('offers ONLY legal edges for the current state and POSTs the audited transition', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(singleAssetRead)) // drawer GET
      .mockResolvedValueOnce(jsonResponse({ ok: true })) // POST
      .mockResolvedValue(jsonResponse(disputedAssetRead)); // refetch — the machine's fresh answer
    vi.stubGlobal('fetch', fetchMock);

    const container = mount(
      <MulRegistry data={readyData([record({ state: 'cleared' })])} nowIso={NOW} />,
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-mul="history-button"]')?.click();
    });

    // cleared → disputed | revoked. Nothing else. No draft, no requested.
    expect(container.querySelector('[data-mul="action-draft"]')).toBeNull();
    expect(container.querySelector('[data-mul="action-requested"]')).toBeNull();
    const disputed = container.querySelector<HTMLButtonElement>('[data-mul="action-disputed"]');
    const revoked = container.querySelector<HTMLButtonElement>('[data-mul="action-revoked"]');
    expect(disputed).not.toBeNull();
    expect(revoked).not.toBeNull();

    const note = container.querySelector<HTMLInputElement>('[data-mul="action-note"]');
    act(() => {
      setInputValue(note as HTMLInputElement, 'Verified against the signed license.');
    });

    await act(async () => {
      disputed?.click();
    });

    const postCall = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    expect(postCall).toBeDefined();
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      assetCbtCode: 'CBT-TEST-0001',
      to: 'disputed',
      note: 'Verified against the signed license.',
    });
    // The table updated from the machine's own answers: the row now renders
    // the disputed state and the summary counts follow it.
    expect(container.querySelector('[data-mul="row"][data-mul-state="disputed"]')).not.toBeNull();
    expect(container.querySelector('[data-mul="row"][data-mul-state="cleared"]')).toBeNull();
    expect(container.querySelector('[data-testid="mul-count-cleared"]')?.textContent).toBe('0');
    expect(container.querySelector('[data-testid="mul-count-disputed"]')?.textContent).toBe('1');
    // The visible history was refetched after the machine moved.
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method !== 'POST').length).toBe(2);

    vi.unstubAllGlobals();
  });

  it('surfaces the machine refusal (409) as an error instead of hiding it', async () => {
    // A draft-state read: the machine offers draft → requested, and this test
    // simulates the machine refusing that edge anyway (a concurrent move
    // claimed it first).
    const draftAssetRead = {
      ...singleAssetRead,
      clearance: { ...singleAssetRead.clearance, state: 'draft' },
      transitions: [singleAssetRead.transitions[0]],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(draftAssetRead))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            error:
              "Illegal clearance transition: 'draft' → 'requested' is not a legal edge.",
            reason: 'invalid_state',
          },
          409,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const container = mount(<MulRegistry data={readyData([record()])} nowIso={NOW} />);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-mul="history-button"]')?.click();
    });
    await act(async () => {});

    // draft → requested is legal and offered; simulate the machine refusing
    // it anyway (a concurrent move already claimed the edge).
    const requested = container.querySelector<HTMLButtonElement>('[data-mul="action-requested"]');
    expect(requested).not.toBeNull();
    await act(async () => {
      requested?.click();
    });

    const error = container.querySelector('[data-mul="action-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain('is not a legal edge');
    // The refusal changes nothing: the row keeps its draft state.
    expect(container.querySelector('[data-mul="row"][data-mul-state="draft"]')).not.toBeNull();
    expect(container.querySelector('[data-mul="row"][data-mul-state="requested"]')).toBeNull();

    vi.unstubAllGlobals();
  });
});
