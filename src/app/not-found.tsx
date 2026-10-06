import Link from 'next/link';

/**
 * Root not-found boundary — the statement for an unregistered address.
 * Same fail-closed voice as the reconciliation lock on /contracts/[id]:
 * nothing exists here, so nothing is shown. Renders for unmatched URLs
 * (all real routes live under the (workspace) route group, which does not
 * change URL structure) and for notFound() calls that bubble past their
 * segment. The link returns to the front page.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-[70vh] w-full items-center justify-center px-6 py-12">
      <div className="glass-card w-full max-w-xl p-8 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Error 404</p>
        <h1 className="mt-3 text-2xl font-semibold text-white">
          Nothing is registered at this address.
        </h1>
        <p className="mt-3 text-sm text-white/50">
          No record matches this route, so nothing is shown — Covnant renders only what exists.
        </p>
        <div className="gold-rule mx-auto mt-6 w-2/3" />
        <Link
          href="/"
          className="mt-6 inline-block rounded-lg border border-gold/40 bg-gold/10 px-4 py-2 text-sm text-gold transition hover:bg-gold/20"
        >
          Return to the front page
        </Link>
      </div>
    </main>
  );
}
