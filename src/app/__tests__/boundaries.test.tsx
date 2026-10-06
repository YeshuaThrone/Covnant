/**
 * Root boundary composition tests — the app's three global statements
 * (error / loading / not-found) render their fail-closed copy and the
 * platform rails (statement voice, link home, digest surfacing, live-region
 * status). Static render via renderToStaticMarkup, the repo's component
 * test pattern (see (workspace)/dashboard/__tests__/page.test.tsx).
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

describe('src/app/loading.tsx — verifying statement', () => {
  it('states the fail-closed loading condition with a live-region status', async () => {
    const RootLoading = (await import('../loading')).default;
    const html = renderToStaticMarkup(<RootLoading />);
    expect(html).toContain('Verifying');
    expect(html).toContain('Rendering in progress.');
    expect(html).toContain('nothing is shown until it clears');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});

describe('src/app/not-found.tsx — unregistered address statement', () => {
  it('states the 404 condition and links back to the front page', async () => {
    const NotFound = (await import('../not-found')).default;
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain('Error 404');
    expect(html).toContain('Nothing is registered at this address.');
    expect(html).toContain('Covnant renders only what exists');
    expect(html).toContain('href="/"');
    expect(html).toContain('Return to the front page');
  });
});

describe('src/app/error.tsx — render failure statement', () => {
  it('states the fail-closed failure condition with a retry control', async () => {
    const RootErrorBoundary = (await import('../error')).default;
    const error = Object.assign(new Error('boom'), { digest: 'DIGEST123' });
    const html = renderToStaticMarkup(
      <RootErrorBoundary error={error} reset={() => undefined} />,
    );
    expect(html).toContain('Render failure');
    expect(html).toContain('Rendering stopped.');
    expect(html).toContain('a partial statement is never issued');
    expect(html).toContain('Digest: DIGEST123');
    expect(html).toContain('Verify and render again');
  });

  it('omits the digest line when the failure carries none', async () => {
    const RootErrorBoundary = (await import('../error')).default;
    const html = renderToStaticMarkup(
      <RootErrorBoundary error={new Error('boom')} reset={() => undefined} />,
    );
    expect(html).not.toContain('Digest:');
  });
});
