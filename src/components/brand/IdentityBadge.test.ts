import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IdentityBadge, resolveRenderedState, type IdentityState } from './IdentityBadge';

/**
 * IdentityBadge unit gates — spec V1 (both states render from props, text-
 * labeled, contract-format UCT) and V2 (token purity: no hex literals in the
 * component source). Rendered via react-dom/server in the node environment:
 * the badge is a server component, so its SSR markup is the product.
 */

const ANCHORED = {
  kind: 'anchored',
  uct: 'UCT-JJ-2026-4A1F00C3-9Z',
  status: 'PROVISIONED',
} as const;

function render(props: { state: IdentityState; compact?: boolean }) {
  return renderToStaticMarkup(createElement(IdentityBadge, props));
}

describe('IdentityBadge', () => {
  it('renders anchored state with the eyebrow, visible UCT, and status text', () => {
    const html = render({ state: { ...ANCHORED } });

    expect(html).toContain('data-identity="anchored"');
    expect(html).toContain('data-state="anchored"');
    expect(html).toContain('COVNANT IDENTITY');
    // The UCT itself is visible text — never color-only or elided.
    expect(html).toContain('UCT-JJ-2026-4A1F00C3-9Z');
    expect(html).toContain('PROVISIONED');
    // Gold hairline pill per the VerificationBadge sibling grammar.
    expect(html).toContain('border-gold/40');
    expect(html).toContain('text-gold-champagne');
  });

  it('renders PENDING status with its reason suffix', () => {
    const html = render({
      state: { ...ANCHORED, status: 'PENDING', reason: 'Increase setup' },
    });

    expect(html).toContain('PENDING · Increase setup');
  });

  it('renders unregistered state as a muted, text-labeled pill', () => {
    const html = render({ state: { kind: 'unregistered' } });

    expect(html).toContain('data-identity="unregistered"');
    expect(html).toContain('data-state="unregistered"');
    expect(html).toContain('No identity yet');
    expect(html).toContain('border-white/10');
    expect(html).toContain('text-white/40');
  });

  it('rejects a malformed uct prop — falls back to the unregistered state', () => {
    expect(resolveRenderedState({ kind: 'anchored', uct: 'not-a-uct', status: 'PROVISIONED' })).toEqual({
      kind: 'unregistered',
    });

    const html = render({ state: { kind: 'anchored', uct: 'not-a-uct', status: 'PROVISIONED' } });

    // The malformed value must never render as an identity.
    expect(html).toContain('data-state="unregistered"');
    expect(html).not.toContain('not-a-uct');
    expect(html).toContain('No identity yet');
  });

  it('trims padding in the compact variant', () => {
    expect(render({ state: { kind: 'unregistered' }, compact: true })).toContain('px-2 py-0.5');
    expect(render({ state: { kind: 'unregistered' } })).toContain('px-3 py-1');
  });

  it('source uses no hex literals — token utilities only', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('./IdentityBadge.tsx', import.meta.url)),
      'utf8',
    );

    expect(source.match(/#[0-9a-fA-F]{3,8}/g) ?? []).toHaveLength(0);
  });
});
