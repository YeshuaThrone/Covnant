'use client';

/**
 * The admin gate's login surface — the ONLY thing an unauthenticated
 * visitor can see at /admin. Brand-exact obsidian/deep-gold; deliberately
 * silent about what lies behind: no section names, no feature hints, no
 * data — just the sign-in exchange against POST /api/admin/login.
 *
 * Honest fail states, keyed by the API's machine code (loginFailureMessage):
 * wrong password, not-configured, rate-limited — each stated plainly. On
 * success the signed httpOnly cookie is set by the route and the server
 * component re-renders into the console.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { loginFailureMessage } from '@/lib/admin/console';

export function AdminGate({ notice }: { notice?: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
        cache: 'no-store',
      });
      if (response.ok) {
        // The signed session cookie is set by the login route; the server
        // component re-renders into the console on refresh.
        router.refresh();
        return;
      }
      const body = (await response.json().catch(() => null)) as { reason?: string } | null;
      setFailure(loginFailureMessage(body?.reason));
      setPassword('');
    } catch {
      // Network-level failure — the request never reached the gate.
      setFailure(loginFailureMessage(null));
    } finally {
      setPending(false);
    }
  };

  return (
    <div data-admin="gate" className="mx-auto max-w-md px-6 py-20">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold-champagne">
        Operator Access
      </p>
      <h1 className="mt-3 text-3xl font-semibold text-white">Admin Console</h1>
      <div className="gold-rule mt-6 w-64" />

      {notice ? (
        // Not-configured state: the secret is unset server-side, so no
        // password can succeed — showing a form would be a lie.
        <div role="status" className="glass-card mt-8 p-6">
          <p className="text-sm text-white/70">{notice}</p>
        </div>
      ) : (
        <form onSubmit={submit} className="glass-card mt-8 p-6" aria-label="Admin sign-in">
        <label htmlFor="admin-password" className="font-mono text-xs uppercase tracking-[0.25em] text-white/50">
          Admin password
        </label>
        <input
          id="admin-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-2 w-full rounded-lg border border-gold/25 bg-obsidian-950/60 px-4 py-2.5 text-sm text-white outline-none transition focus:border-gold/60 focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne"
        />

        <button
          type="submit"
          disabled={pending}
          className="mt-5 w-full rounded-lg border border-gold/40 px-4 py-2.5 font-mono text-sm uppercase tracking-[0.25em] text-gold transition-colors hover:bg-gold/10 disabled:cursor-wait disabled:opacity-50"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>

        {failure && (
          <p role="alert" className="mt-4 rounded-lg border border-red-400/40 bg-red-400/10 p-3 text-sm text-red-300">
            {failure}
          </p>
        )}
        </form>
      )}
    </div>
  );
}
