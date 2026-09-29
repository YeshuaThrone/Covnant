/**
 * @vitest-environment jsdom
 *
 * EntryZones composition tests — the standard single-click submit flow that
 * replaced the double-click seal ritual. Pins: one signup fetch per submit,
 * the button's isSubmitting state (disabled + loading label while in
 * flight), the 201-with-phone response landing on the verification step
 * (the account exists first; the step can only enrich it), immediate
 * navigation to /agent on a 200 repeat or a blank-phone 201, NO rendered
 * E.164 block for real-world captures (the founder's two formats ride the
 * wire as canonical E.164), the human invalid-phone message for genuinely
 * impossible input, retryability after a failure, and the retirement of
 * every local-storage seal record.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryZones } from '@/components/landing/EntryZones';

// The API's human invalid-phone copy (signupValidation's invalid_phone
// message — the module keeps its error table private).
const INVALID_PHONE_COPY =
  "That phone number doesn't look right — enter a real number, any format works.";

// React 19's act guard — cast because the DOM lib's globalThis has no
// index signature for it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

const CREATED_201 = {
  ok: true,
  created: true,
  uct: 'UCT-US-2026-9A3F02B7-K4',
  uctCreatedAt: '2026-09-09T20:31:04.000Z',
  jurisdiction: 'US',
  status: 'PENDING',
  reason: 'INCREASE_NOT_CONFIGURED',
  alreadyRegistered: false,
  rightsHolderId: 'b2f1c3a9-1111-4222-8333-444455556666',
  assetId: '7e6d5c4b-9999-4888-a777-666555544444',
  session: null,
  user: { id: 'auth_user_1', email: 'artist@example.com', email_confirmed_at: null },
  profile: { id: 'auth_user_1', stage_name: 'Nova Reign' },
};

function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body };
}

/** A fetch mock routed by URL fragment — the signup call and the mounted
 * OTP step's auto-request each get their scripted response. */
function routedFetch(handlers: Record<string, { status: number; body: unknown }>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    for (const [path, response] of Object.entries(handlers)) {
      if (url.includes(path)) {
        return Promise.resolve(jsonResponse(response.status, response.body));
      }
    }
    return Promise.resolve(jsonResponse(500, { ok: false, error: 'unrouted' }));
  });
}

const OTP_OK = { status: 200, body: { ok: true, delivered: true, deliveredVia: 'none' } };

function mountEntryZones(): {
  container: HTMLElement;
  form: HTMLFormElement;
  button: HTMLButtonElement;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<EntryZones />);
  });
  const form = container.querySelector('form') as HTMLFormElement;
  const button = container.querySelector('button[type="submit"]') as HTMLButtonElement;
  return { container, form, button };
}

function fillEntry(container: HTMLElement, label: string, value: string): void {
  // Match on getAttribute — the `&` in 'Core Industry & Title' breaks
  // jsdom's attribute-selector parsing.
  const input = [...container.querySelectorAll('input')].find(
    (el) => el.getAttribute('aria-label') === label,
  ) as HTMLInputElement | undefined;
  if (!input) throw new Error(`input not found: ${label}`);
  input.value = value;
}

function fillComposition(container: HTMLElement, phone: string): void {
  fillEntry(container, 'Stage Name', 'Nova Reign');
  fillEntry(container, 'Legal Name', 'Jordan A. Reyes');
  fillEntry(container, 'Email', 'artist@example.com');
  fillEntry(container, 'Phone Number', phone);
  fillEntry(container, 'Core Industry & Title', 'Music — Recording');
  fillEntry(container, 'Password', 'correct-horse-battery');
}

function submitForm(form: HTMLFormElement): void {
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

async function flushSubmit(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  routerPush.mockClear();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('EntryZones single-click submit', () => {
  it('is a standard type=submit button labeled Continue — no sealed state, no double-click hint', () => {
    const { button, container } = mountEntryZones();
    expect(button.getAttribute('type')).toBe('submit');
    expect(button.textContent).toBe('Continue');
    expect(button.disabled).toBe(false);
    expect(container.textContent).not.toContain('Double-click to unseal');
    expect(container.textContent).not.toContain('SEALED');
  });

  it('submits exactly once per click and lands on the verification step on the 201', async () => {
    const fetchMock = routedFetch({
      'auth/signup': { status: 201, body: CREATED_201 },
      'auth/phone/otp': OTP_OK,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container, form } = mountEntryZones();
    fillComposition(container, '830-358-2306');
    submitForm(form);
    await flushSubmit();

    const signupCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('auth/signup'),
    );
    expect(signupCalls).toHaveLength(1);
    // The step mounts — the account exists, the funnel pauses on purpose.
    expect(container.textContent).toContain('Verify your phone');
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('a 201 with a blank phone navigates straight to /agent — nothing to verify', async () => {
    const fetchMock = routedFetch({
      'auth/signup': { status: 201, body: CREATED_201 },
      'auth/phone/otp': OTP_OK,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container, form } = mountEntryZones();
    fillComposition(container, '');
    submitForm(form);
    await flushSubmit();

    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/agent');
    expect(container.textContent).not.toContain('Verify your phone');
  });

  it('navigates to /agent on the status-only 200 claim/repeat response too', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        created: false,
        status: 'PENDING',
        reason: 'INCREASE_NOT_CONFIGURED',
        alreadyRegistered: true,
        rightsHolderId: 'rh',
        assetId: 'asset',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { container, form } = mountEntryZones();
    fillComposition(container, '830-358-2306');
    submitForm(form);
    await flushSubmit();

    expect(routerPush).toHaveBeenCalledWith('/agent');
  });

  it('shows the isSubmitting state and makes duplicate submits impossible while in flight', async () => {
    let resolveFetch!: (value: unknown) => void;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { container, form, button } = mountEntryZones();
    fillComposition(container, '830-358-2306');
    submitForm(form);

    // In flight: the visible loading state, disabled, and no second POST —
    // neither a stray click nor a second submit event can re-fire it.
    expect(button.textContent).toBe('Submitting…');
    expect(button.disabled).toBe(true);
    submitForm(form);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFetch(jsonResponse(201, CREATED_201));
      await Promise.resolve();
      await Promise.resolve();
    });
    // The 201-with-phone swaps to the verification step instead of pushing —
    // the duplicate-submit guard stays latched through the swap.
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('renders no E.164 block for the founder real-world formats — the wire carries canonical E.164', async () => {
    for (const captured of ['830-358-2306', '(830) 358-2306']) {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, CREATED_201));
      vi.stubGlobal('fetch', fetchMock);
      const { container, form } = mountEntryZones();
      fillComposition(container, captured);
      submitForm(form);
      await flushSubmit();

      // The step mounts for a phone on file; the wire still carries E.164.
      expect(container.textContent).toContain('Verify your phone');
      expect(container.textContent).not.toContain('E.164');
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(String(init.body)).phone).toBe('+18303582306');
      container.remove();
    }
  });

  it('renders the human invalid-phone message for genuinely impossible input — never E.164 jargon', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(422, {
        ok: false,
        error: INVALID_PHONE_COPY,
        reason: 'invalid_phone',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { container, form, button } = mountEntryZones();
    fillComposition(container, '830-358-2306 ext 5');
    submitForm(form);
    await flushSubmit();

    expect(container.textContent).toContain("That phone number doesn't look right");
    expect(container.textContent).not.toContain('E.164');
    // A failure the visitor can retry: the guard resets, the button returns.
    expect(button.textContent).toBe('Continue');
    expect(button.disabled).toBe(false);
  });

  it('renders the transport recovery line and stays retryable when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    const { container, form, button } = mountEntryZones();
    fillComposition(container, '830-358-2306');
    submitForm(form);
    await flushSubmit();

    expect(container.textContent).toContain(
      'Your entry could not reach the registry — submit again',
    );
    expect(button.textContent).toBe('Continue');

    // The second attempt fires a fresh request — the failure is clean-retryable.
    submitForm(form);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('writes no localStorage seal record — the offline receipt ritual is gone', async () => {
    const fetchMock = routedFetch({
      'auth/signup': { status: 201, body: CREATED_201 },
      'auth/phone/otp': OTP_OK,
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container, form } = mountEntryZones();
    fillComposition(container, '');
    submitForm(form);
    await flushSubmit();

    expect(window.localStorage.getItem('covnant.sealedEntry')).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(routerPush).toHaveBeenCalledWith('/agent');
  });
});
