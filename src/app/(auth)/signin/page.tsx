'use client';

/**
 * /signin — the returning creator's way back in (Gen 12: brand-exact glass
 * card, chromeless inputs). The zone grammar mirrors the landing's entry
 * zones exactly — champagne mono statements, chromeless h-10 w-64 inputs
 * with jade typed text and the gold caret, zero-gap gold rules, borderless
 * pressable submit — but the composition lives inside ONE glass card (the
 * bank reference's centered sign-in moment) and the submit is WIRED:
 * Supabase password sign-in, then the workspace.
 *
 * Honest failure states, stated in the response-line voice: wrong
 * credentials, unconfirmed email, unconfigured identity service, transport
 * failure. Nothing is invented; each line says what happened.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { CvRibbonMonogram } from '@/components/brand/CvRibbonMonogram';
import { validateCovnantSigninPayload } from '@/lib/covnant/signinValidation';
import { createBrowserSupabaseClient } from '@/lib/auth/browserClient';

/* The landing's exact zone grammar, mirrored as constants of the same text. */
const STATEMENT_CLASS = 'font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne';
const INPUT_CLASS =
  'h-10 w-64 cursor-text bg-transparent text-center text-lg text-emerald-300 caret-amber-400/70 outline-none';
const BUTTON_CLASS =
  'h-10 w-64 cursor-pointer bg-transparent font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne/90 transition-colors duration-200 hover:text-gold-champagne focus-visible:outline focus-visible:outline-1 focus-visible:outline-gold-champagne';
const RESPONSE_LINE_CLASS =
  'mt-2 font-mono text-xs uppercase tracking-[0.3em] text-gold-champagne';

type SigninPhase =
  | { phase: 'idle' }
  | { phase: 'submitting' }
  | { phase: 'invalid'; message: string }
  | { phase: 'wrong_credentials' }
  | { phase: 'email_unconfirmed' }
  | { phase: 'unconfigured' }
  | { phase: 'failed'; message: string };

/** Map a Supabase sign-in error to the honest renderable branch. */
function mapSigninError(code: string | undefined): SigninPhase {
  if (code === 'invalid_credentials') return { phase: 'wrong_credentials' };
  if (code === 'email_not_confirmed') return { phase: 'email_unconfirmed' };
  return { phase: 'failed', message: 'Sign-in could not complete — try again' };
}

const RESPONSE_COPY: Record<string, string> = {
  submitting: 'Opening your world',
  invalid: 'Enter a valid email and password',
  wrong_credentials: 'Email or password is incorrect',
  email_unconfirmed: 'Confirm your email to sign in — check your inbox',
  unconfigured: 'Sign-in is unavailable — the identity service is not configured',
};

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState<SigninPhase>({ phase: 'idle' });

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const validation = validateCovnantSigninPayload({ email, password });
    if (!validation.ok) {
      setState({ phase: 'invalid', message: validation.message });
      return;
    }

    const client = createBrowserSupabaseClient();
    if (!client) {
      setState({ phase: 'unconfigured' });
      return;
    }

    setState({ phase: 'submitting' });
    const { error } = await client.auth.signInWithPassword({
      email: validation.value.email,
      password: validation.value.password,
    });
    if (error) {
      setState(mapSigninError(error.code));
      return;
    }
    // Signed in — the middleware refreshes the session cookies on the next
    // navigation; a refresh guarantees the (workspace) layout sees it.
    router.push('/dashboard');
    router.refresh();
  };

  const responseLine = (() => {
    switch (state.phase) {
      case 'idle':
        return null;
      case 'submitting':
        return <p className={RESPONSE_LINE_CLASS}>{RESPONSE_COPY.submitting}</p>;
      case 'invalid':
        return <p className={RESPONSE_LINE_CLASS}>{state.message}</p>;
      case 'unconfigured':
        return <p className={RESPONSE_LINE_CLASS}>{RESPONSE_COPY.unconfigured}</p>;
      case 'wrong_credentials':
        return <p className={RESPONSE_LINE_CLASS}>{RESPONSE_COPY.wrong_credentials}</p>;
      case 'email_unconfirmed':
        return <p className={RESPONSE_LINE_CLASS}>{RESPONSE_COPY.email_unconfirmed}</p>;
      case 'failed':
        return <p className={RESPONSE_LINE_CLASS}>{state.message}</p>;
    }
  })();

  return (
    <main className="flex min-h-screen flex-col items-center px-6 py-6">
      <Link
        href="/"
        aria-label="Covnant home"
        className="flex items-center gap-3"
        data-testid="signin-home-link"
      >
        <CvRibbonMonogram size={32} />
        <span className="font-mono text-sm tracking-[0.3em] text-gold-champagne">COVNANT</span>
      </Link>

      <section className="mt-16 w-full max-w-md">
        <div className="glass-card flex flex-col items-center px-6 py-10" data-testid="signin-card">
          <h1 className={STATEMENT_CLASS}>Welcome back</h1>
          <div className="gold-rule mt-6 w-64" />
          {/* noValidate — the brand's honest response line speaks, not the
              browser's native email tooltip (which would swallow submit). */}
          <form onSubmit={submit} noValidate className="flex flex-col items-center" data-testid="signin-form">
            <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Email</p>
            <input
              type="email"
              aria-label="Email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={INPUT_CLASS}
              data-testid="signin-email"
            />
            <div className="gold-rule w-64" />

            <p className="mt-8 font-mono text-sm uppercase tracking-[0.3em] text-gold-champagne">Password</p>
            <input
              type="password"
              aria-label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={INPUT_CLASS}
              data-testid="signin-password"
            />
            <div className="gold-rule w-64" />

            <button type="submit" disabled={state.phase === 'submitting'} className={`mt-8 ${BUTTON_CLASS}`} data-testid="signin-submit">
              {state.phase === 'submitting' ? 'SIGNING IN' : 'Sign in'}
            </button>
            {responseLine}
          </form>

          <div className="gold-rule mt-8 w-64" />
          <p className="mt-6 text-center text-xs text-slate-400">
            First time here?{' '}
            <Link href="/" className="text-gold-champagne underline-offset-4 hover:underline">
              Seal your entry on the landing page
            </Link>
          </p>
        </div>
      </section>

      <footer className="mt-10 text-center text-xs text-white/30">
        © {new Date().getFullYear()} Covnant. Own Your Creation.
      </footer>
    </main>
  );
}
