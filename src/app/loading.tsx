/**
 * Root loading boundary — the statement shown while a surface is being
 * verified. Matches the app's rhythm (mono gold eyebrow, gold hairline,
 * restrained skeleton) with zero spinner dependencies: the pulse is
 * Tailwind's built-in animate-pulse over existing token colors only.
 * Sits directly inside the root layout, so any suspending navigation below
 * it — including every page under the (workspace) route group — resolves
 * here first; no closer loading boundary exists.
 */
export default function RootLoading() {
  return (
    <main className="flex min-h-[70vh] w-full items-center justify-center px-6 py-12">
      <div className="glass-card w-full max-w-xl p-8 text-center" role="status" aria-live="polite">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Verifying</p>
        <h1 className="mt-3 text-2xl font-semibold text-white">Rendering in progress.</h1>
        <p className="mt-3 text-sm text-white/50">
          This surface is being verified, so nothing is shown until it clears.
        </p>
        <div className="gold-rule mt-6 w-full animate-pulse" />
        <div className="mt-6 space-y-2" aria-hidden="true">
          <div className="h-3 w-3/4 animate-pulse rounded bg-white/5" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-white/5" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-white/5" />
        </div>
      </div>
    </main>
  );
}
