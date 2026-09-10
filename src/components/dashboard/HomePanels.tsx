/**
 * HomePanels — the dashboard's lower regions (bank reference: the dense
 * transaction list and the quiet side panel):
 *
 *  - TransactionsPanel: the creator's recent royalty settlements, READ-ONLY
 *    and DENSE — counterparty + small date on the left, per-currency amount
 *    right-aligned, CBT settlement code kept tiny. The bounded me-route
 *    slice shows at most ten rows; the panel surfaces six and offers the
 *    wired "See more" path to the full ledger when it truncates.
 *  - ReadinessChecklist: the side panel's financial-readiness rows — KYC,
 *    tax form, bank account, provisioning — small, quiet, text-labeled
 *    token states. There is no messaging feature; nothing is invented.
 */

import Link from 'next/link';

import { PROVISIONING_LABELS } from '@/components/brand/provisioningLabels';
import { formatUnitsMinor } from '@/lib/money/format';
import type { CovnantMeResponse } from '@/lib/covnant/types';

/** Deterministic date render — hydration-safe (UTC, fixed locale). */
function settledOn(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  return new Date(parsed).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Rows shown before the list truncates behind the "See more" link. */
const VISIBLE_ROWS = 6;

export function TransactionsPanel({ me }: { me: CovnantMeResponse }): React.JSX.Element {
  const rows = me.recentSettlements;
  const visible = rows.slice(0, VISIBLE_ROWS);
  const truncated = rows.length > visible.length;

  return (
    <section
      data-testid="transactions-panel"
      className="rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] shadow-[0_12px_40px_-16px_rgba(0,0,0,0.55)] p-5 md:p-6"
      aria-label="Recent royalty settlements"
    >
      {rows.length === 0 ? (
        <p data-testid="transactions-empty" className="text-sm leading-relaxed text-slate-400">
          No settlements on the ledger yet.
        </p>
      ) : (
        <>
          <ul data-testid="transactions-rows" className="divide-y divide-slate-700/40">
            {visible.map((row) => (
              <li
                key={`${row.transactionId}-${row.currency}`}
                data-testid="transactions-row"
                data-currency={row.currency}
                className="flex items-center justify-between gap-4 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-200">{row.platform}</p>
                  <p className="truncate text-[11px] text-slate-500">
                    {settledOn(row.settledAt)} · <span className="font-mono">{row.cbtCode}</span>
                  </p>
                </div>
                <p className="shrink-0 font-mono text-sm text-slate-100">
                  {formatUnitsMinor(row.amountUnits, row.currency)}
                </p>
              </li>
            ))}
          </ul>
          {truncated ? (
            <Link
              href="/ledger"
              data-testid="transactions-see-more"
              className="mt-4 inline-flex items-center rounded-full border border-gold/40 bg-gold/10 px-3.5 py-1.5 text-[11px] font-semibold text-gold-champagne transition-colors hover:bg-gold/20"
            >
              See more
            </Link>
          ) : null}
        </>
      )}
    </section>
  );
}

/** One readiness row — text-labeled so state is never color-only. */
function ReadinessRow({
  label,
  done,
  detail,
  testId,
}: {
  label: string;
  done: boolean;
  detail: string;
  testId: string;
}) {
  return (
    <li data-testid={testId} data-state={done ? 'complete' : 'incomplete'} className="flex items-start gap-2.5 py-2">
      <span
        aria-hidden="true"
        className={
          done
            ? 'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-emerald-400/40 bg-emerald-500/15 text-[9px] text-emerald-300'
            : 'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-gold/40 bg-gold/10 text-[9px] text-gold-champagne'
        }
      >
        {done ? '✓' : '•'}
      </span>
      <div className="min-w-0">
        <p className="text-xs text-slate-300">
          {label}{' '}
          <span
            className={
              done
                ? 'font-mono text-[9px] uppercase tracking-[0.2em] text-emerald-300'
                : 'font-mono text-[9px] uppercase tracking-[0.2em] text-gold-champagne'
            }
          >
            {done ? 'COMPLETE' : 'TODO'}
          </span>
        </p>
        <p className="text-[11px] leading-relaxed text-slate-500">{detail}</p>
      </div>
    </li>
  );
}

export function ReadinessChecklist({ me }: { me: CovnantMeResponse }): React.JSX.Element {
  const profile = me.profile;
  return (
    <aside
      data-testid="readiness-checklist"
      className="h-fit rounded-2xl border border-slate-600/50 bg-gradient-to-b from-white/[0.06] to-white/[0.02] shadow-[0_12px_40px_-16px_rgba(0,0,0,0.55)] p-5"
      aria-label="Financial readiness"
    >
      <h3 className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
        Financial readiness
      </h3>
      <ul className="mt-2 divide-y divide-slate-700/40">
        <ReadinessRow
          testId="readiness-kyc"
          label="Identity verification"
          done={profile.kyc_status === 'APPROVED'}
          detail={profile.kyc_status === 'APPROVED' ? 'KYC approved' : `KYC status: ${profile.kyc_status}`}
        />
        <ReadinessRow
          testId="readiness-tax"
          label="Tax form on file"
          done={profile.tax_verified === true} // nullable column — null is not verified
          detail={
            profile.tax_form_type && profile.tax_verified
              ? `${profile.tax_form_type} — verified`
              : profile.tax_form_type
                ? `${profile.tax_form_type} — awaiting verification`
                : 'No tax form on file'
          }
        />
        <ReadinessRow
          testId="readiness-bank"
          label="Bank account linked"
          done={profile.bank_account_linked === true} // nullable column — null is not linked
          detail={profile.bank_account_linked ? 'Payout destination connected' : 'Link an account to receive payouts'}
        />
        <ReadinessRow
          testId="readiness-provisioning"
          label="Virtual account"
          done={me.provisioning.status === 'PROVISIONED'}
          detail={PROVISIONING_LABELS[me.provisioning.status].label}
        />
      </ul>
    </aside>
  );
}
