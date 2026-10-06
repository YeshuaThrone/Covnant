import { AgentRegistrationStudio } from '@/components/agent/AgentRegistrationStudio';

export const metadata = {
  title: 'Registration Agent — Covnant',
  description:
    'Describe your work in plain words and the agent drafts the Covenant Block registration for your review.',
};

/**
 * The creator-facing registration copilot. The page is chrome — the write
 * gate lives server-side: the agent route is registered-session-only, and
 * confirming submits through the same guarded `registerAssetAction` as the
 * manual form.
 */
export default function AgentPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">Asset Studio</p>
      <h1 className="mt-2 text-3xl font-semibold text-pearl md:text-4xl">Registration Agent</h1>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Describe your work in plain words. The agent proposes a structured Covenant Block draft —
        title, medium, holders, splits, and a suggested agreement — for you to review and confirm.
        It proposes; only your confirmation writes.
      </p>
      <div className="gold-rule my-8" />
      <AgentRegistrationStudio />
    </main>
  );
}
