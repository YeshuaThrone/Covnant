/**
 * @vitest-environment jsdom
 *
 * AgentRegistrationStudio — the describe → review → confirmed state machine
 * (spec criterion 6, end to end at the component level):
 *   - describe: the prose textarea submits to /api/covnant/agent/register;
 *   - a draft response renders the review state with the assumptions flag;
 *   - the {error, code} envelope renders the honest error strip;
 *   - confirm flows through the REAL registerAssetAction seam (mocked here —
 *     it is a server action) and the returned cbtCode renders the confirmed
 *     state.
 *
 * jsdom + createRoot/act — Testing Library is NOT used in this repo.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRegistrationDraft } from '@/lib/agent/registrationDraft';

vi.mock('@/lib/assets/actions', () => ({ registerAssetAction: vi.fn() }));

import { AgentRegistrationStudio } from '@/components/agent/AgentRegistrationStudio';
import { AGENT_ROUTING_PLACEHOLDER } from '@/lib/agent/registrationDraft';
import { registerAssetAction } from '@/lib/assets/actions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DRAFT: AgentRegistrationDraft = {
  title: 'Midnight Clear',
  medium: 'MUSIC_TRACK',
  identifiers: {},
  pools: [
    {
      pool: 'MASTER_RECORDING',
      holders: [
        { id: 'draft-holder-1', name: 'Aurora Sky', role: 'COMPOSER', splitPercentage: 100, taxFormType: 'EXEMPT', usTaxResident: false, isVerified: false, routing: { ...AGENT_ROUTING_PLACEHOLDER } },
      ],
    },
  ],
  confidence: 0.9,
  assumptions: ['Tax form defaulted to EXEMPT — confirm before registering.'],
};

function draftResponse(draft: AgentRegistrationDraft): Response {
  return new Response(JSON.stringify({ draft, warnings: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function envelopeError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: `Envelope: ${code}`, code }), { status });
}

const mounted: { root: Root; container: HTMLElement }[] = [];

function mountStudio() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<AgentRegistrationStudio />);
  });
  mounted.push({ root, container });
  return container;
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

function setInput(element: Element, value: string) {
  const proto =
    element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('value setter unavailable');
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  });
}

function testId(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`[data-testid="${id}"] not rendered`);
  return element;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('AgentRegistrationStudio', () => {
  it('walks describe → review → confirmed through the real action seam (criterion 6)', async () => {
    fetchMock.mockResolvedValue(draftResponse(DRAFT));
    vi.mocked(registerAssetAction).mockResolvedValue({ ok: true, cbtCode: 'CBT-STUDIO-1' });

    const container = mountStudio();

    // Describe state: type the prose and submit.
    setInput(testId(container, 'agent-description'), 'A track called Midnight Clear');
    click(testId(container, 'agent-draft-submit'));
    await flush();

    // The route received the description.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/covnant/agent/register');
    expect(JSON.parse(String(init.body))).toEqual({ description: 'A track called Midnight Clear' });

    // Review state: the draft + the flagged assumption are on screen.
    expect(testId(container, 'agent-draft-review')).toBeTruthy();
    expect(container.textContent).toContain('Tax form defaulted to EXEMPT');

    // Confirm → the EXISTING action gets the payload; the cbtCode renders.
    click(testId(container, 'agent-confirm'));
    await flush();

    expect(registerAssetAction).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(registerAssetAction).mock.calls[0]?.[0];
    expect(payload?.title).toBe('Midnight Clear');
    expect(payload?.pools[0]?.holders[0]?.name).toBe('Aurora Sky');
    expect(testId(container, 'agent-confirmed')).toBeTruthy();
    expect(container.textContent).toContain('CBT-STUDIO-1');
  });

  it('renders the honest error strip when the route returns the error envelope', async () => {
    fetchMock.mockResolvedValue(envelopeError(401, 'no_session'));

    const container = mountStudio();
    setInput(testId(container, 'agent-description'), 'A track');
    click(testId(container, 'agent-draft-submit'));
    await flush();

    expect(container.textContent).toContain('Envelope: no_session');
    // Back on describe — the creator can retry or take the manual form.
    expect(testId(container, 'agent-description')).toBeTruthy();
  });

  it('blocks the submit button while the description is empty', () => {
    const container = mountStudio();
    const submit = testId(container, 'agent-draft-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});
