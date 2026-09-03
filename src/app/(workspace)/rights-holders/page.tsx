/**
 * /rights-holders — Compliance & payout overview — PR 4.
 *
 * Aggregates every rights holder across all registered assets with their tax
 * compliance status (W-9 / W-8BEN / W-8BEN-E), payout routing, year-to-date
 * earnings from the royalty ledger, and the engine's form requirement.
 *
 * The engine evaluates 1099 thresholds per settlement (its settlement call passes
 * the per-event share, not a YTD accumulator), so the form column shows the
 * engine's own determination from the most recent settlement plus the profile's
 * standing compliance status.
 */

import { CovenantTaxEngine } from '@/engine/covenant-master-sdk';
import type { SelfServeRightsHolder, TaxProfile } from '@/engine/covenant-master-sdk';
import { listAssets } from '@/lib/sdk';
import { holderStatsFrom, listLedger } from '@/lib/ledger/store';

export const dynamic = 'force-dynamic';

interface HolderRow {
  id: string;
  name: string;
  role: string;
  assets: { cbtCode: string; splitPercentage: number }[];
  taxProfile: TaxProfile;
  routing: SelfServeRightsHolder['payoutRouting'];
}

function formLabel(profile: TaxProfile): string {
  switch (profile.taxFormType) {
    case 'W9_US_PERSON':
      return 'W-9';
    case 'W8BEN_FOREIGN_INDIVIDUAL':
      return 'W-8BEN';
    case 'W8BEN_E_FOREIGN_ENTITY':
      return 'W-8BEN-E';
    case 'EXEMPT':
      return 'Exempt';
    default:
      return profile.taxFormType;
  }
}

function fmtMoney(amount: number, currency: string): string {
  const decimals = currency === 'SAT' || currency === 'ETH' || currency === 'SOL' ? 8 : 2;
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: decimals })} ${currency}`;
}

export default async function RightsHoldersPage() {
  const [assets, ledger] = await Promise.all([listAssets(), listLedger()]);
  const stats = holderStatsFrom(ledger);

  const rows = new Map<string, HolderRow>();
  for (const asset of assets) {
    for (const holder of asset.rightsHolders) {
      const existing = rows.get(holder.id);
      if (existing) {
        existing.assets.push({ cbtCode: asset.cbtCode, splitPercentage: holder.splitPercentage });
      } else {
        rows.set(holder.id, {
          id: holder.id,
          name: holder.name,
          role: holder.role,
          assets: [{ cbtCode: asset.cbtCode, splitPercentage: holder.splitPercentage }],
          taxProfile: holder.taxProfile,
          routing: holder.payoutRouting,
        });
      }
    }
  }

  const unverified = [...rows.values()].filter((r) => !r.taxProfile.isVerified).length;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold">
        Rights Holder Registry
      </p>
      <h1 className="mt-2 text-3xl font-semibold text-white">Rights Holders</h1>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Tax standing, payout routing, and year-to-date earnings for every rights holder across
        registered assets. {rows.size} holder{rows.size === 1 ? '' : 's'} on the books
        {unverified > 0 ? ` — ${unverified} with unverified tax profiles (backup withholding applies)` : ', all tax profiles verified'}.
      </p>

      {rows.size === 0 ? (
        <div className="glass-card mt-8 p-10 text-center text-white/50">
          No rights holders yet. Register an asset in the Asset Studio first.
        </div>
      ) : (
        <div className="mt-8 space-y-4">
          {[...rows.values()].map((holder) => {
            const ytd = stats.get(holder.id);
            const currencies = ytd ? Object.keys(ytd.grossYtd) : [];
            const treatyRate = holder.taxProfile.treatyWithholdingRate;
            const effectiveRate = CovenantTaxEngine.calculateEffectiveTaxRate(holder.taxProfile, 'US');
            return (
              <article key={holder.id} className="glass-card p-6">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-medium text-white">{holder.name}</h2>
                    <p className="font-mono text-xs text-white/50">
                      {holder.role} · {holder.id}
                    </p>
                  </div>
                  <span
                    className={
                      holder.taxProfile.isVerified
                        ? 'rounded-full border border-emerald-400/40 px-3 py-1 font-mono text-[10px] uppercase text-emerald-300'
                        : 'rounded-full border border-amber-400/40 px-3 py-1 font-mono text-[10px] uppercase text-amber-300'
                    }
                  >
                    {holder.taxProfile.isVerified ? 'Tax verified' : 'Unverified — backup withholding'}
                  </span>
                </div>

                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">Form on file</dt>
                    <dd className="mt-1 text-white/80">
                      {formLabel(holder.taxProfile)}
                      {holder.taxProfile.isBackupWithholdingRequired && ' · backup flag'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">
                      Effective withholding
                    </dt>
                    <dd className="mt-1 font-mono text-white/80">
                      {(effectiveRate * 100).toFixed(2)}%
                      {treatyRate !== undefined && ` · treaty ${(treatyRate * 100).toFixed(2)}%`}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">Payout rail</dt>
                    <dd className="mt-1 text-white/80">
                      {holder.routing?.railType ?? '—'} · {holder.routing?.countryCode ?? '—'} ·{' '}
                      {holder.routing?.currency ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">
                      Latest form determination
                    </dt>
                    <dd className="mt-1 font-mono text-white/80">{ytd?.latestTaxForm ?? 'NONE'}</dd>
                  </div>
                </dl>

                <div className="mt-4 flex flex-wrap gap-2">
                  {holder.assets.map((a) => (
                    <span
                      key={a.cbtCode}
                      className="rounded-full border border-white/15 px-3 py-1 font-mono text-[10px] text-white/60"
                    >
                      {a.cbtCode} · {a.splitPercentage.toFixed(4)}%
                    </span>
                  ))}
                </div>

                <div className="mt-4 border-t border-white/10 pt-3">
                  <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">
                    YTD earnings · {ytd?.settlementCount ?? 0} settlement
                    {(ytd?.settlementCount ?? 0) === 1 ? '' : 's'}
                  </p>
                  {currencies.length === 0 ? (
                    <p className="mt-1 text-sm text-white/50">No settlements recorded yet.</p>
                  ) : (
                    <p className="mt-1 font-mono text-xs text-white/80">
                      {currencies.map((cur) => (
                        <span key={cur} className="mr-4">
                          gross {fmtMoney(ytd!.grossYtd[cur], cur)} · withheld{' '}
                          {fmtMoney(ytd!.withheldYtd[cur], cur)} · net {fmtMoney(ytd!.netYtd[cur], cur)}
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-white/40">
        The engine applies the $600 IRS reporting threshold per settlement event; year-to-date
        figures above are informational, shown in settlement currency.
      </p>
    </main>
  );
}
