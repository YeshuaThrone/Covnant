'use client';

import { useEffect } from 'react';

/**
 * Root error boundary — the last statement the app issues when a render
 * fails. Speaks the same fail-closed voice as the reconciliation lock on
 * /contracts/[id]: state the condition plainly and never display a partial
 * or unverified surface. Sits directly inside the root layout, so it
 * catches render failures from every nested segment, including everything
 * under the (workspace) route group — only the root layout itself sits
 * above it.
 */
export default function RootErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('root error boundary — render failure:', error);
  }, [error]);

  return (
    <main className="flex min-h-[70vh] w-full items-center justify-center px-6 py-12">
      <div className="glass-card w-full max-w-xl p-8 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Render failure</p>
        <h1 className="mt-3 text-2xl font-semibold text-white">Rendering stopped.</h1>
        <p className="mt-3 text-sm text-white/50">
          This surface could not be verified, so nothing was shown — a partial statement is never
          issued.
        </p>
        {error.digest ? (
          <p className="mt-4 font-mono text-xs text-white/40">Digest: {error.digest}</p>
        ) : null}
        <div className="gold-rule mx-auto mt-6 w-2/3" />
        <button
          type="button"
          onClick={reset}
          className="mt-6 rounded-lg border border-gold/40 bg-gold/10 px-4 py-2 text-sm text-gold transition hover:bg-gold/20"
        >
          Verify and render again
        </button>
      </div>
    </main>
  );
}
