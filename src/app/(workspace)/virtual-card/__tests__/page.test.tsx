/**
 * @vitest-environment jsdom
 *
 * /virtual-card composition test — renders against the LIVE resolver in
 * dev-seed mode (no mocks). Pins the physical GoldNote structure: the
 * 1.586:1 brushed-gold face (aspect-ratio + BRUSHED_GOLD marker), the EMV
 * chip, the masked pending number, the holder identity, the
 * SOVEREIGN_NETWORK badge as the ONLY network mark, the ENABLED wallet +
 * copy actions with honest behavior (badges open a provisioning-status
 * dialog that explains — never implies a pass; copy reports honestly that
 * no number is issued and never writes the pending placeholder to the
 * clipboard), the real store-read balance in the details panel, pending
 * expiry/CVC/ZIP (never fabricated), the additional-payment disclosure,
 * and the Transactions & History row.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GoldNoteCard, PENDING_PLACEHOLDER } from '@/components/goldnote/GoldNoteCard';
import { bootDevSeedStore } from '@/lib/server/devSeed';

// React 19's act guard — cast because the DOM lib's globalThis has no
// index signature for it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  process.env.DON_DEV_SEED = '1';
  await bootDevSeedStore();
});

async function renderVirtualCardPage(): Promise<string> {
  const VirtualCardPage = (await import('../page')).default;
  return renderToStaticMarkup(await VirtualCardPage());
}

/** The honest not-provisioned note — the page's WALLET_NOTE, verbatim. */
const WALLET_NOTE =
  'Card provisioning arrives with the live card program — wallet passes are not available in this build.';

const NO_NUMBER_MESSAGE = 'No card number issued yet — nothing to copy';

/** A masked NON-pending number row — the honest future state of the card. */
const MASKED_NUMBER = '•••• •••• •••• 4242';

/* ── jsdom interaction harness (no testing-library in this repo) ── */

const mounted: { root: Root; container: HTMLElement }[] = [];

function renderGoldNoteCard(cardNumberMasked: string = PENDING_PLACEHOLDER) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <GoldNoteCard
        holderName="Yeshua Throne"
        cardNumberMasked={cardNumberMasked}
        availableBalanceCents={330_000_000n}
        walletNote={WALLET_NOTE}
      />,
    );
  });
  mounted.push({ root, container });
  return { container };
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

function pressEscape() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

/* ── Clipboard stub — jsdom ships no navigator.clipboard ── */

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

describe('/virtual-card — the GoldNote surface', () => {
  it('exports the browser title — Virtual Card — Covnant', async () => {
    const page = await import('../page');
    expect(page.metadata).toEqual({
      title: 'Virtual Card — Covnant',
      description: expect.stringContaining('GoldNote'),
    });
  });

  it('renders the physical card face — ratio marker, chip, masked number, holder, network badge', async () => {
    const html = await renderVirtualCardPage();
    expect(html).toContain('data-testid="goldnote-card"');
    expect(html).toContain('data-card-style="BRUSHED_GOLD"');
    expect(html).toContain('1.586');
    expect(html).toContain('data-testid="goldnote-chip"');
    expect(html).toContain('data-testid="goldnote-number"');
    expect(html).toContain('•••• •••• •••• ••••');
    expect(html).toContain('data-testid="goldnote-holder"');
    // Source casing — uppercase is applied by CSS, not in the markup.
    expect(html).toContain('Yeshua Throne');
    expect(html).toContain('data-testid="goldnote-badge-network"');
    expect(html).toContain('SOVEREIGN_NETWORK');
    // No third-party network branding ON THE FACE — the About panel may
    // honestly say the card is not a Visa or Mastercard product.
    const face = html.split('data-testid="goldnote-card"')[1]?.split('data-testid="goldnote-wallet-apple"')[0] ?? '';
    expect(face).not.toMatch(/visa|mastercard/i);
  });

  it('renders the real seeded available balance in the details panel', async () => {
    const html = await renderVirtualCardPage();
    expect(html).toContain('data-testid="goldnote-balance"');
    expect(html).toContain('$3,300,000.00');
  });

  it('renders pending financial details and the ENABLED honest actions', async () => {
    const html = await renderVirtualCardPage();
    expect(html).toContain('data-testid="goldnote-details-expiry"');
    expect(html).toContain('Pending');
    expect(html).toContain('data-testid="goldnote-details-cvc"');
    expect(html).toContain('data-testid="goldnote-details-zip"');
    expect(html).toContain('data-testid="goldnote-details-name"');
    // The actions are enabled honest affordances: the badges open the
    // provisioning-status dialog, the copy control reports the pending
    // state — none of them renders a disabled attribute anymore.
    for (const testId of ['goldnote-wallet-apple', 'goldnote-wallet-google', 'goldnote-copy-number']) {
      const slice = html.split(`data-testid="${testId}"`)[1] ?? '';
      expect(slice.slice(0, 500), `${testId} must not render disabled`).not.toContain('disabled');
    }
    // Both badges declare the dialog they open.
    expect((html.match(/aria-haspopup="dialog"/g) ?? []).length).toBe(2);
    // The honest not-provisioned note rides beneath the actions.
    expect(html).toContain('data-testid="goldnote-wallet-note"');
  });

  it('renders the real Apple and Google marks inside the enabled wallet badges', async () => {
    const html = await renderVirtualCardPage();

    // The real Apple logo — canonical simple-icons path data inside the
    // Apple badge, not an invented wallet glyph.
    const appleBadge = html.split('data-testid="goldnote-wallet-apple"')[1] ?? '';
    expect(appleBadge).toContain('data-testid="goldnote-apple-mark"');
    expect(appleBadge).toContain('M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04');

    // The real Google G — official four-color construction inside the
    // Google badge, not a stacked-pass approximation.
    const googleBadge = html.split('data-testid="goldnote-wallet-google"')[1] ?? '';
    expect(googleBadge).toContain('data-testid="goldnote-google-mark"');
    expect(googleBadge).toContain('fill="#4285F4"');
    expect(googleBadge).toContain('fill="#34A853"');
    expect(googleBadge).toContain('fill="#FBBC05"');
    expect(googleBadge).toContain('fill="#EA4335"');

    // Both badges are enabled dialog openers carrying the honest note.
    expect(appleBadge.slice(0, 500)).toContain('aria-haspopup="dialog"');
    expect(googleBadge.slice(0, 500)).toContain('aria-haspopup="dialog"');
    expect(appleBadge.slice(0, 500)).not.toContain('disabled');
    expect(googleBadge.slice(0, 500)).not.toContain('disabled');
  });

  it('renders the additional-payment disclosure and the ledger link — no fake account numbers', async () => {
    const html = await renderVirtualCardPage();
    expect(html).toContain('data-testid="goldnote-additional-payment"');
    expect(html).toContain('data-testid="goldnote-transactions-link"');
    expect(html).toContain('href="/ledger"');
    // No account/routing number shapes anywhere.
    expect(html).not.toMatch(/\b\d{9,12}\b/);
  });

  it('carries the DEMO DATA marker and the seeded persona — no Nova Reign', async () => {
    const html = await renderVirtualCardPage();
    expect(html).toContain('data-testid="demo-data-badge"');
    expect(html).toContain('data-testid="admin-console-link"');
    expect(html).not.toContain('Nova Reign');
  });
});

describe('GoldNote actions — honest interactivity', () => {
  it('renders the wallet badges and copy control enabled — badges declare aria-haspopup=dialog', () => {
    const { container } = renderGoldNoteCard();
    for (const testId of ['goldnote-wallet-apple', 'goldnote-wallet-google']) {
      const badge = container.querySelector(`[data-testid="${testId}"]`);
      expect(badge, testId).not.toBeNull();
      expect(badge?.hasAttribute('disabled')).toBe(false);
      expect(badge?.getAttribute('aria-haspopup')).toBe('dialog');
      expect(badge?.getAttribute('title')).toBe(WALLET_NOTE);
    }
    const copy = container.querySelector('[data-testid="goldnote-copy-number"]');
    expect(copy).not.toBeNull();
    expect(copy?.hasAttribute('disabled')).toBe(false);
  });

  it('opens the provisioning dialog on badge click — wallet name, verbatim note, focus on close', () => {
    const { container } = renderGoldNoteCard();
    click(container.querySelector('[data-testid="goldnote-wallet-apple"]')!);

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('goldnote-wallet-dialog-title');
    // The accessible name comes from the wallet name; the body is the note VERBATIM.
    expect(container.querySelector('#goldnote-wallet-dialog-title')?.textContent).toBe('Apple Wallet');
    expect(dialog?.textContent).toContain(WALLET_NOTE);
    // Minimal focus management — the close button takes focus on open.
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="goldnote-wallet-dialog-close"]'),
    );
  });

  it('names the Google dialog from the Google wallet', () => {
    const { container } = renderGoldNoteCard();
    click(container.querySelector('[data-testid="goldnote-wallet-google"]')!);
    expect(container.querySelector('#goldnote-wallet-dialog-title')?.textContent).toBe('Google Wallet');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(WALLET_NOTE);
  });

  it('closes the dialog via the close button and returns focus to the badge', () => {
    const { container } = renderGoldNoteCard();
    const appleBadge = container.querySelector('[data-testid="goldnote-wallet-apple"]')!;
    click(appleBadge);
    click(container.querySelector('[data-testid="goldnote-wallet-dialog-close"]')!);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(appleBadge);
  });

  it('closes the dialog via Escape', () => {
    const { container } = renderGoldNoteCard();
    click(container.querySelector('[data-testid="goldnote-wallet-google"]')!);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    pressEscape();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('closes the dialog via backdrop click — a click inside the panel does not', () => {
    const { container } = renderGoldNoteCard();
    click(container.querySelector('[data-testid="goldnote-wallet-apple"]')!);
    click(container.querySelector('[data-testid="goldnote-wallet-dialog-backdrop"]')!);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    // Re-open: a click on the panel itself must stay open.
    click(container.querySelector('[data-testid="goldnote-wallet-apple"]')!);
    click(container.querySelector('[data-testid="goldnote-wallet-dialog"]')!);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('pending state: copy click shows the honest no-number feedback and never touches the clipboard', () => {
    const { container } = renderGoldNoteCard(PENDING_PLACEHOLDER);
    click(container.querySelector('[data-testid="goldnote-copy-number"]')!);
    const feedback = container.querySelector('[data-testid="goldnote-copy-feedback"]');
    expect(feedback?.textContent).toBe(NO_NUMBER_MESSAGE);
    // The honesty law: no placeholder digits are ever copied as a number.
    expect(writeText).not.toHaveBeenCalled();
  });

  it('auto-dismisses the copy feedback after ~2.5s', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderGoldNoteCard(PENDING_PLACEHOLDER);
      click(container.querySelector('[data-testid="goldnote-copy-number"]')!);
      expect(container.querySelector('[data-testid="goldnote-copy-feedback"]')?.textContent).toBe(
        NO_NUMBER_MESSAGE,
      );
      act(() => {
        vi.advanceTimersByTime(2600);
      });
      expect(container.querySelector('[data-testid="goldnote-copy-feedback"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('non-pending state: copies the masked number to the clipboard and shows Copied', async () => {
    const { container } = renderGoldNoteCard(MASKED_NUMBER);
    click(container.querySelector('[data-testid="goldnote-copy-number"]')!);
    // Flush the clipboard promise chain, then assert the honest success.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(MASKED_NUMBER);
    expect(container.querySelector('[data-testid="goldnote-copy-feedback"]')?.textContent).toBe('Copied');
  });
});
