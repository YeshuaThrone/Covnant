/**
 * HomePanels — the dashboard's two lower panels (bank reference: the
 * transaction list and the side panel):
 *
 *  - TransactionsPanel: the creator's recent royalty settlements, READ-ONLY.
 *    Date, counterparty/platform, per-currency net amount, CBT settlement
 *    code. No actions, no links, no mutation surface. The honest empty
 *    state: "No settlements on the ledger yet." — never fabricated rows.
 *  - ReadinessChecklist: the side panel's financial-readiness rows — KYC,
 *    tax form, bank account, provisioning — text-labeled token states only.
 *    There is no messaging feature; nothing is invented to fill the slot.
 */

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

export function TransactionsPanel({ me }: { me: CovnantMeResponse }): React.JSX.Element {
  const rows = me.recentSettlements;
  return (
    <section data-testid="transactions-panel" className="glass-card p-5 md:p-6" aria-label="Recent royalty settlements">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-sm font-semibold text-slate-300">Recent royalty settlements</h3>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
          Read-only ledger view
        </span>
      </div>

      {rows.length === 0 ? (
        <p data-testid="transactions-empty" className="mt-5 text-sm leading-relaxed text-slate-400">
          No settlements on the ledger yet.
        </p>
      ) : (
        <ul data-testid="transactions-rows" className="mt-4 divide-y divide-gold/10">
          {rows.map((row) => (
            <li
              key={`${row.transactionId}-${row.currency}`}
              data-testid="transactions-row"
              data-currency={row.currency}
              className="flex items-center justify-between gap-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-200">{row.platform}</p>
                <p className="truncate font-mono text-[11px] uppercase tracking-[0.15em] text-slate-500">
                  {settledOn(row.settledAt)} · {row.cbtCode}
                </p>
              </div>
              <p className="shrink-0 font-mono text-sm text-emerald-300">
                {formatUnitsMinor(row.amountUnits, row.currency)}
              </p>
            </li>
          ))}
        </ul>
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
    <li data-testid={testId} data-state={done ? 'complete' : 'incomplete'} className="flex items-start gap-3 py-2.5">
      <span
        aria-hidden="true"
        className={
          done
            ? 'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-emerald-400/40 bg-emerald-500/15 text-[10px] text-emerald-300'
            : 'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-gold/40 bg-gold/10 text-[10px] text-gold-champagne'
        }
      >
        {done ? '✓' : '•'}
      </span>
      <div className="min-w-0">
        <p className="text-sm text-slate-200">
          {label}{' '}
          <span
            className={
              done
                ? 'font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-300'
                : 'font-mono text-[10px] uppercase tracking-[0.2em] text-gold-champagne'
            }
          >
            {done ? 'COMPLETE' : 'TODO'}
          </span>
        </p>
        <p className="text-xs leading-relaxed text-slate-500">{detail}</p>
      </div>
    </li>
  );
}

export function ReadinessChecklist({ me }: { me: CovnantMeResponse }): React.JSX.Element {
  const profile = me.profile;
  return (
    <aside data-testid="readiness-checklist" className="glass-card p-5 md:p-6" aria-label="Financial readiness">
      <h3 className="text-sm font-semibold text-slate-300">Financial readiness</h3>
      <ul className="mt-3 divide-y divide-gold/10">
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
