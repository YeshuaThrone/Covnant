import { AssetRegistrationForm } from '@/components/studio/AssetRegistrationForm';

export const metadata = {
  title: 'Register Asset — Covnant',
  description: 'Open a new Covenant Block asset with a multi-pool split sheet.',
};

export default function NewAssetPage() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-[#00C8FF]">Asset Studio</p>
      <h1 className="mt-2 text-3xl font-semibold text-[#F2F4F8]">Register a Covenant Block</h1>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Master recording, writer/composition, and publisher administration pools are tracked
        independently — each must total exactly 100.0000% before the engine accepts the sheet.
      </p>
      <div className="gold-rule my-8" />
      <AssetRegistrationForm />
    </main>
  );
}
