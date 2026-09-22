/**
 * CovnantCreatorsView — render test for the founder's UCT placement
 * directive (2026-09-22: "place the UCT Number where it says provisioned").
 *
 * The UCT is the card's top-right identity chip with its issuance date; the
 * status pill lives in the footer; a pending creator shows the honest "UCT
 * pending" ghost in the issuance slot. The old bottom UCT box is gone.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CovnantCreatorsView, type CreatorCardData } from '../CovnantCreatorsView';

function card(overrides: Partial<CreatorCardData> = {}): CreatorCardData {
  return {
    legal_name: 'Alicia Fontaine',
    stage_name: 'FONTAINE MUSIC',
    email: 'alicia.fontaine@example.com',
    phone: '+1 (312) 555-0148',
    core_industry: 'Music — Recording Artist',
    title: 'Independent Artist',
    jurisdiction: 'US',
    engine: 'music_recording',
    status: 'PROVISIONED',
    uct: 'UCT-US-2026-9A3F02B7-XX',
    uctCreatedAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('CovnantCreatorsView UCT placement (founder directive 2026-09-22)', () => {
  it('renders the UCT as the top-right identity chip with its issuance date', () => {
    const markup = renderToStaticMarkup(<CovnantCreatorsView cards={[card()]} />);
    expect(markup).toContain('UCT-US-2026-9A3F02B7-XX');
    expect(markup).toContain('issued 2026-09-08');
  });

  it('shows the honest UCT-pending ghost in the issuance slot for pending creators', () => {
    const markup = renderToStaticMarkup(
      <CovnantCreatorsView
        cards={[card({ status: 'PENDING', uct: null, uctCreatedAt: null, stage_name: 'VALE SOUNDS', legal_name: 'Marcus Vale' })]}
      />,
    );
    expect(markup).toContain('UCT pending');
  });

  it('keeps the status pill explicit on the card footer', () => {
    const markup = renderToStaticMarkup(<CovnantCreatorsView cards={[card()]} />);
    expect(markup).toContain('PROVISIONED');
  });

  it('removes the old bottom UCT box — no duplicate tag rendering', () => {
    const markup = renderToStaticMarkup(<CovnantCreatorsView cards={[card()]} />);
    expect(markup).not.toContain('Universal Covnant Tag');
    expect(markup.match(/UCT-US-2026-9A3F02B7-XX/g)).toHaveLength(1);
  });
});
