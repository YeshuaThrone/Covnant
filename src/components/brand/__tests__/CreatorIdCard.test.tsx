/**
 * CreatorIdCard render tests — the props-first contract. Both states render
 * for real (renderToStaticMarkup), the degradation rule is exercised
 * through the component itself, and the account-number ban is asserted on
 * the rendered output: provisioning is status text only, never digits.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CreatorIdCard, resolveRenderedCardState } from '@/components/brand/CreatorIdCard';
import { buildUct } from '@/lib/covnant/uct';

const VALID_UCT = buildUct('US', 2026, '9F3A7C21');
// Shape-valid but checksum-broken — the degradation rule must reject it.
const TAMPERED_UCT = `${VALID_UCT.slice(0, -2)}FF`;

const ANCHORED = {
  kind: 'anchored' as const,
  stageName: 'Novah Saine',
  uct: VALID_UCT,
  status: 'PROVISIONED' as const,
  uctCreatedAt: '2026-09-09T00:00:00.000Z',
  jurisdiction: 'US',
  role: 'creator',
};

describe('CreatorIdCard — anchored state (props-first)', () => {
  it('renders the stage name, UCT, and provisioning chip from props', () => {
    const html = renderToStaticMarkup(<CreatorIdCard state={ANCHORED} />);
    expect(html).toContain('data-testid="creator-id-card"');
    expect(html).toContain('Novah Saine');
    expect(html).toContain(VALID_UCT);
    expect(html).toContain('data-provisioning="PROVISIONED"');
    expect(html).toContain('Virtual account ready');
  });

  it('renders issuance facts when present', () => {
    const html = renderToStaticMarkup(<CreatorIdCard state={ANCHORED} />);
    expect(html).toContain('data-testid="card-facts"');
    expect(html).toContain('Sep 9, 2026');
  });

  it('never renders account or routing numbers — status text only', () => {
    const html = renderToStaticMarkup(<CreatorIdCard state={ANCHORED} />);
    expect(html).not.toContain('accountNumber');
    expect(html).not.toContain('routingNumber');
    expect(html).not.toContain('accountNumberId');
    expect(html).not.toContain('x1019');
    expect(html).not.toContain('••');
  });
});

describe('CreatorIdCard — pending provisioning', () => {
  it('renders the pending chip and the honest pending note', () => {
    const html = renderToStaticMarkup(
      <CreatorIdCard state={{ ...ANCHORED, status: 'PENDING', reason: 'Increase setup' }} />,
    );
    expect(html).toContain('data-provisioning="PENDING"');
    expect(html).toContain('Virtual account provisioning');
    expect(html).toContain('data-testid="provisioning-pending-note"');
  });
});

describe('CreatorIdCard — unregistered state', () => {
  it('renders the honest unregistered card with a registration path', () => {
    const html = renderToStaticMarkup(<CreatorIdCard state={{ kind: 'unregistered' }} />);
    expect(html).toContain('data-testid="creator-id-card-unregistered"');
    expect(html).toContain('No identity card yet');
    expect(html).toContain('href="/"');
    expect(html).not.toContain('data-testid="card-uct"');
  });
});

describe('resolveRenderedCardState — display-side degradation', () => {
  it('keeps a valid anchored state as received', () => {
    expect(resolveRenderedCardState(ANCHORED)).toEqual(ANCHORED);
  });

  it('degrades a malformed UCT to the unregistered state', () => {
    expect(resolveRenderedCardState({ ...ANCHORED, uct: TAMPERED_UCT })).toEqual({
      kind: 'unregistered',
    });
  });

  it('degrades a shape-broken UCT to the unregistered state', () => {
    expect(resolveRenderedCardState({ ...ANCHORED, uct: 'not-a-uct' })).toEqual({
      kind: 'unregistered',
    });
  });

  it('leaves the unregistered state untouched', () => {
    expect(resolveRenderedCardState({ kind: 'unregistered' })).toEqual({ kind: 'unregistered' });
  });
});
