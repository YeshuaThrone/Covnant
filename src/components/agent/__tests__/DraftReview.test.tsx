/**
 * @vitest-environment jsdom
 *
 * DraftReview — the agent's review state (spec criteria 6 and 7):
 *   - every assumptions[] entry renders as a visible flag;
 *   - edits flow through: confirm submits the EDITED payload;
 *   - a draft the write path would reject (pool sums ≠ exactly 100.0000%)
 *     blocks the confirm button client-side;
 *   - the duplicate ActionResult renders the existing gold duplicate banner;
 *   - a clean registration hands the cbtCode up.
 *
 * jsdom + createRoot/act — Testing Library is NOT used in this repo.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DraftReview } from '@/components/agent/DraftReview';
import { AGENT_ROUTING_PLACEHOLDER } from '@/lib/agent/registrationDraft';
import type { AgentRegistrationDraft } from '@/lib/agent/registrationDraft';
import type { ActionResult, RegisterAssetPayload } from '@/lib/assets/actions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VALID_DRAFT: AgentRegistrationDraft = {
  title: 'Midnight Clear',
  medium: 'MUSIC_TRACK',
  identifiers: { isrc: 'US-S1Z-26-00001' },
  pools: [
    {
      pool: 'MASTER_RECORDING',
      holders: [
        { id: 'draft-holder-1', name: 'Aurora Sky', role: 'COMPOSER', splitPercentage: 60, taxFormType: 'EXEMPT', usTaxResident: false, isVerified: false, routing: { ...AGENT_ROUTING_PLACEHOLDER } },
        { id: 'draft-holder-2', name: 'Second Writer', role: 'LYRICIST', splitPercentage: 40, taxFormType: 'EXEMPT', usTaxResident: false, isVerified: false, routing: { ...AGENT_ROUTING_PLACEHOLDER } },
      ],
    },
  ],
  templateSuggestion: { templateId: 'MUSIC_SPLIT_SHEET', rationale: 'Ownership split sheet.' },
  confidence: 0.9,
  assumptions: ['Tax form defaulted to EXEMPT — confirm before registering.'],
};

/** jsdom interaction harness (no testing-library in this repo). */
const mounted: { root: Root; container: HTMLElement }[] = [];

function mountReview(draft: AgentRegistrationDraft, onConfirm: (payload: RegisterAssetPayload) => Promise<ActionResult>) {
  const onRegistered = vi.fn();
  const onStartOver = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <DraftReview draft={draft} warnings={[]} onConfirm={onConfirm} onRegistered={onRegistered} onStartOver={onStartOver} />,
    );
  });
  mounted.push({ root, container });
  return { container, onRegistered, onStartOver };
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

function setInput(element: Element, value: string) {
  const isTextarea = element.tagName === 'TEXTAREA';
  const proto = isTextarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('value setter unavailable');
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  });
}

function confirmButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[data-testid="agent-confirm"]');
  if (!button) throw new Error('confirm button not rendered');
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('DraftReview', () => {
  it('renders every assumptions[] entry as a visible flag (criterion 6)', () => {
    const { container } = mountReview(VALID_DRAFT, vi.fn());
    const panel = container.querySelector('[data-testid="agent-assumptions"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Tax form defaulted to EXEMPT');
    expect(container.textContent).toContain('Model confidence: 90%');
    // The suggestion renders the template's CATALOG name (TEMPLATES lookup).
    expect(container.textContent).toContain('Songwriter Split Sheet');
  });

  it('submits the EDITED payload to onConfirm (criterion 6)', async () => {
    const onConfirm = vi.fn<(payload: RegisterAssetPayload) => Promise<ActionResult>>(async () => ({
      ok: true,
      cbtCode: 'CBT-EDIT-1',
    }));
    const { container, onRegistered } = mountReview(VALID_DRAFT, onConfirm);

    const titleInput = container.querySelector<HTMLInputElement>('input[placeholder^="Song"]');
    expect(titleInput).not.toBeNull();
    setInput(titleInput as HTMLInputElement, 'Midnight Clear (Remaster)');

    const button = confirmButton(container);
    expect(button.disabled).toBe(false);
    click(button);
    await flush();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const payload = onConfirm.mock.calls[0]?.[0];
    expect(payload.title).toBe('Midnight Clear (Remaster)');
    expect(payload.medium).toBe('MUSIC_TRACK');
    expect(payload.pools[0]?.pool).toBe('MASTER_RECORDING');
    expect(payload.pools[0]?.holders.map((holder) => holder.splitPercentage).sort((a, b) => b - a)).toEqual([60, 40]);
    expect(payload.pools[0]?.holders.map((holder) => holder.name)).toEqual(['Aurora Sky', 'Second Writer']);
    expect(onRegistered).toHaveBeenCalledWith('CBT-EDIT-1');
  });

  it('blocks confirm when a pool does not sum to exactly 100.0000% (criterion 6)', async () => {
    const lopsided: AgentRegistrationDraft = {
      ...VALID_DRAFT,
      pools: [
        {
          pool: 'MASTER_RECORDING',
          holders: VALID_DRAFT.pools[0]?.holders[0]
            ? [{ ...VALID_DRAFT.pools[0].holders[0], splitPercentage: 402.5 }]
            : [],
        },
      ],
    };
    const onConfirm = vi.fn(async (): Promise<ActionResult> => ({ ok: true, cbtCode: 'CBT-X' }));
    const { container } = mountReview(lopsided, onConfirm);

    const button = confirmButton(container);
    expect(button.disabled).toBe(true);
    click(button); // disabled buttons no-op
    await flush();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders the existing duplicate banner on a duplicate ActionResult (criterion 7)', async () => {
    const onConfirm = vi.fn(async (): Promise<ActionResult> => ({ ok: false, error: 'duplicate', duplicate: true }));
    const { container, onRegistered } = mountReview(VALID_DRAFT, onConfirm);

    click(confirmButton(container));
    await flush();

    expect(container.textContent).toContain('Asset already registered in CBT catalog');
    expect(onRegistered).not.toHaveBeenCalled();
    // The review stays up so the creator can adjust the title or medium.
    expect(container.querySelector('[data-testid="agent-draft-review"]')).not.toBeNull();
  });

  it('renders the action error strip on a failed registration', async () => {
    const onConfirm = vi.fn(async (): Promise<ActionResult> => ({ ok: false, error: 'Registry write failed.' }));
    const { container } = mountReview(VALID_DRAFT, onConfirm);

    click(confirmButton(container));
    await flush();

    expect(container.textContent).toContain('Registry write failed.');
  });
});
