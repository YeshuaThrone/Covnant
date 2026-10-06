// UDR splits orchestrator — Cursor's Batch 1 drop (calculateUdrSplits).
//
// MECHANICAL ASYNC ADAPTATION ONLY (Store PR contract, 2026-09-10 ruling):
// every store call is awaited and store-calling engine functions are awaited;
// allocation math, control flow, GL wiring, and the returned shapes are
// untouched. Two canonical-name alignments to merged main: the GL leg type is
// GlLegInput (ledger/journal.ts) and the recoupment apply result is
// RecoupmentSweepOutcome (recoupment/engine.ts). Stripping await/async/Promise
// tokens yields Cursor's drop byte-for-byte on all non-signature lines.

import { allocateLineItems } from "@/lib/don/splitEngine";
import type {
  AllocatedLineItem,
  LedgerTransactionRecord,
  SplitCalculateInput,
  SplitRunRecord,
} from "@/lib/don/types";
import type { Store } from "@/lib/server/store";
import {
  getBaasAdapter,
  settleLedgerThroughBaas,
  type BaasTransferResult,
} from "@/services/baas";
import {
  COMPANY_VARIANCE_PAYEE_ID,
  COMPANY_VARIANCE_PAYEE_NAME,
} from "@/modules/don/constants";
import { zeroBalanceHolds } from "@/modules/don/dust";
import { applyWithholding } from "@/modules/compliance/engine";
import { postJournal, type PostJournalResult } from "@/modules/ledger/engine";
import {
  fboCredit,
  fboDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import {
  applyRecoupmentSweep,
  type RecoupmentSweepOutcome,
} from "@/modules/recoupment/engine";
import { creditVault } from "@/modules/vaults/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import type { CompanyDustRecord, TaxEscrowRecord } from "@/modules/don/records";
import type { VaultCreditTarget } from "@/modules/vaults/balances";
import { unwindEscrowRow, vaultBucketDelta } from "@/lib/server/taxUnwind";

// One vault credit the saga executed — the postJournal-failure compensation
// (audit #6) debits each back so the vaults and the GL (which never got the
// journal) agree again.
type SagaVaultCredit = {
  payeeId: string;
  payeeName: string;
  bucket: VaultCreditTarget;
  amountCents: number;
};

// One recoupment sweep the saga executed — the engine credited the platform
// vault and the payee's excess bucket internally (recoupment/engine.ts) and
// advanced the recoupment balance; compensation reverses all three from the
// outcome, so the sweep's internals stay encapsulated.
type SagaSweep = RecoupmentSweepOutcome & {
  payee_id: string;
  payee_name: string;
  excess_target: VaultCreditTarget;
};

/**
 * Whether the saga issued writes of substance — a non-zero vault credit,
 * recoupment sweep, or escrow amount. A zero-gross run tracks only
 * zero-value rows: nothing of substance moved, so a journal refusal must
 * propagate the engine's message verbatim (the SDK wire contract pins that
 * verbatim propagation, and a compensation report would be noise).
 */
function sagaHadSubstantiveWrites(
  credits: SagaVaultCredit[],
  sweeps: SagaSweep[],
  escrow: TaxEscrowRecord[],
): boolean {
  return (
    credits.some((credit) => credit.amountCents !== 0) ||
    sweeps.some((s) => s.recouped_cents !== 0 || s.excess_cents !== 0) ||
    escrow.some((row) => row.gross_cents !== 0 || row.withheld_cents !== 0)
  );
}

/**
 * Failure message for a compensated saga: the underlying reason first, and
 * the compensation outcome only when the saga had moved something of
 * substance. Compensation problems are surfaced, never swallowed.
 */
function sagaFailureMessage(
  reason: string,
  problems: string[],
  hadSubstantiveWrites: boolean,
): string {
  if (!hadSubstantiveWrites) return reason;
  return (
    reason +
    (problems.length > 0
      ? ` Compensation incomplete: ${problems.join("; ")}.`
      : " Saga writes fully compensated.")
  );
}

// Debits back everything the saga moved. Returns per-item problems instead
// of throwing — a compensation failure is surfaced in the failure envelope,
// never swallowed.
async function compensateFailedSaga(
  store: Store,
  credits: SagaVaultCredit[],
  sweeps: SagaSweep[],
  escrowRows: TaxEscrowRecord[],
  now: Date,
): Promise<string[]> {
  const problems: string[] = [];
  for (const credit of credits) {
    const applied = await store.applyVaultDelta({
      payee_id: credit.payeeId,
      payee_name: credit.payeeName,
      delta: vaultBucketDelta(credit.bucket, -credit.amountCents),
      min_balances: vaultBucketDelta(credit.bucket, 0),
      create_if_missing: false,
      updated_at: now.toISOString(),
    });
    if (applied.outcome !== "applied") {
      problems.push(
        `vault debit-back failed for ${credit.payeeId}/${credit.bucket} (${applied.outcome})`,
      );
    }
  }
  for (const sweep of sweeps) {
    if (sweep.recouped_cents > 0) {
      const platform = await store.applyVaultDelta({
        payee_id: COMPANY_VARIANCE_PAYEE_ID,
        payee_name: COMPANY_VARIANCE_PAYEE_NAME,
        delta: vaultBucketDelta("available", -sweep.recouped_cents),
        min_balances: vaultBucketDelta("available", 0),
        create_if_missing: false,
        updated_at: now.toISOString(),
      });
      if (platform.outcome !== "applied") {
        problems.push(
          `recoupment platform debit-back failed (${platform.outcome})`,
        );
      }
      const advance = await store.getRecoupmentAdvance(sweep.payee_id);
      if (advance) {
        await store.upsertRecoupmentAdvance({
          ...advance,
          recoupment_current_cents: Math.max(
            0,
            advance.recoupment_current_cents - sweep.recouped_cents,
          ),
          updated_at: now.toISOString(),
        });
      }
    }
    if (sweep.excess_cents > 0) {
      const excess = await store.applyVaultDelta({
        payee_id: sweep.payee_id,
        payee_name: sweep.payee_name,
        delta: vaultBucketDelta(sweep.excess_target, -sweep.excess_cents),
        min_balances: vaultBucketDelta(sweep.excess_target, 0),
        create_if_missing: false,
        updated_at: now.toISOString(),
      });
      if (excess.outcome !== "applied") {
        problems.push(
          `recoupment excess debit-back failed for ${sweep.payee_id}/${sweep.excess_target} (${excess.outcome})`,
        );
      }
    }
  }
  for (const row of escrowRows) {
    await unwindEscrowRow(store, row, now);
  }
  return problems;
}

export type SplitCalculateSuccess = {
  ok: true;
  value: {
    split_run: SplitRunRecord;
    line_items: Array<AllocatedLineItem & { id: string }>;
    ledger: LedgerTransactionRecord[];
    company_dust_ledger: CompanyDustRecord[];
    variance_account_cents: number;
    zero_balance: true;
    withholding: TaxEscrowRecord[];
    recoupment: Array<RecoupmentSweepOutcome & { payee_id: string }>;
    settlement: {
      rail: SplitCalculateInput["rail"];
      transfers: Array<Extract<BaasTransferResult, { ok: true }>["transfer"]>;
    } | null;
  };
};

export type SplitCalculateFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export async function calculateUdrSplits(
  store: Store,
  input: SplitCalculateInput,
  now: Date = new Date(),
): Promise<SplitCalculateSuccess | SplitCalculateFailure> {
  const allocated = allocateLineItems(input.line_items);
  if (!allocated.ok) {
    return {
      ok: false,
      status: 422,
      code: allocated.code,
      message: allocated.message,
    };
  }

  const createdAt = now.toISOString();
  // Saga idempotency (migration 0009, H3): with a key supplied, a retried
  // calculate must not re-run the multi-write saga. Posted runs cannot be
  // faithfully reconstructed as an original response (withholding and
  // recoupment are computed from live tables, not stored per run), so a
  // replay is refused with the existing run id instead of a fabricated
  // success shape. UNIQUE(split_runs.idempotency_key) arbitrates the race.
  const idempotencyKey = input.idempotency_key || null;
  if (idempotencyKey !== null) {
    const existing = await store.getSplitRunByIdempotencyKey(idempotencyKey);
    if (existing !== undefined) {
      return {
        ok: false,
        status: 409,
        code: "split_run_already_exists",
        message: `A split run for idempotency key "${idempotencyKey}" already exists (${existing.id}).`,
      };
    }
  }
  let splitRun: SplitRunRecord;
  try {
    splitRun = await store.insertSplitRun({
      source: input.source,
      period: input.period,
      currency: input.currency,
      gross_cents: allocated.grossCents,
      line_item_count: allocated.items.length,
      variance_account_cents: allocated.varianceAccountCents,
      idempotency_key: idempotencyKey,
      created_at: createdAt,
    });
  } catch (insertError) {
    // Two concurrent calculates with the same key: the unique index picks a
    // winner and the loser reports it rather than double-running the saga.
    if (idempotencyKey !== null) {
      const winner = await store.getSplitRunByIdempotencyKey(idempotencyKey);
      if (winner !== undefined) {
        return {
          ok: false,
          status: 409,
          code: "split_run_already_exists",
          message: `A split run for idempotency key "${idempotencyKey}" already exists (${winner.id}).`,
        };
      }
    }
    throw insertError;
  }

  const lineItems: Array<AllocatedLineItem & { id: string }> = [];
  const ledger: LedgerTransactionRecord[] = [];
  const dustLedger: CompanyDustRecord[] = [];
  const withholding: TaxEscrowRecord[] = [];
  const recoupment: Array<RecoupmentSweepOutcome & { payee_id: string }> = [];
  // Compensation tracking (audit #6): everything the saga moved in the
  // external world, so a postJournal failure can be walked back exactly —
  // the vault credits this file made, and the sweeps' outcomes (whose
  // internal vault credits and advance movement live in the engine).
  const vaultCredits: SagaVaultCredit[] = [];
  const sweeps: SagaSweep[] = [];
  const glLegs: GlLegInput[] = [fboDebit(allocated.grossCents)];
  const skipBaas = new Set<string>();
  let baasDirectCents = 0;

  for (const item of allocated.items) {
    if (
      !zeroBalanceHolds(
        item.amount_cents,
        item.splits,
        item.company_dust_cents,
      )
    ) {
      // Defensive branch (allocateLineItems already enforces zero balance)
      // — but if it ever fires mid-saga, everything earlier items wrote is
      // compensated first so no partial state survives (audit #6).
      const problems = await compensateFailedSaga(
        store,
        vaultCredits,
        sweeps,
        withholding,
        now,
      );
      return {
        ok: false,
        status: 500,
        code: "zero_balance_violation",
        message: sagaFailureMessage(
          "sum(creator_allocations) + company_dust !== gross_line_item.",
          problems,
          sagaHadSubstantiveWrites(vaultCredits, sweeps, withholding),
        ),
      };
    }
    const storedItem = await store.insertRoyaltyLineItem({
      split_run_id: splitRun.id,
      work_id: item.work_id,
      work_title: item.work_title,
      amount_cents: item.amount_cents,
      splits_json: JSON.stringify(item.splits),
      created_at: createdAt,
    });
    lineItems.push({ ...item, id: storedItem.id });
    for (const party of item.splits) {
      ledger.push(
        await store.insertLedgerTransaction({
          split_run_id: splitRun.id,
          line_item_id: storedItem.id,
          payee_id: party.payee_id,
          payee_name: party.payee_name,
          role: party.role,
          share_bps: party.share_bps,
          amount_cents: party.amount_cents,
          currency: input.currency,
          status: "pending_settlement",
          rail: null,
          baas_provider: null,
          baas_transfer_id: null,
          created_at: createdAt,
          settled_at: null,
        }),
      );

      let creditAmount = party.amount_cents;
      if (party.role === "creator" && party.amount_cents > 0) {
        const taxed = await applyWithholding(store, {
          creator_id: party.payee_id,
          gross_cents: party.amount_cents,
          tax_year: now.getUTCFullYear(),
          // The unwind key (migration 0059 / audit #7): stamps the escrow
          // row with this run so the reversal (and this saga's own failure
          // compensation) can attribute and negate exactly these rows.
          split_run_id: splitRun.id,
        });
        withholding.push(taxed.value.escrow);
        creditAmount = taxed.value.net_cents;
        if (taxed.value.withheld_cents > 0) {
          await creditVault(
            store,
            party.payee_id,
            party.payee_name,
            taxed.value.withheld_cents,
            "reserve",
            now,
          );
          vaultCredits.push({
            payeeId: party.payee_id,
            payeeName: party.payee_name,
            bucket: "reserve",
            amountCents: taxed.value.withheld_cents,
          });
          glLegs.push(
            vaultCredit(party.payee_id, "reserve", taxed.value.withheld_cents),
          );
        }
      }
      const incomingFrozen = await isIncomingFrozen(
        store,
        party.payee_id,
        item.work_id,
      );
      const excessBucket: VaultCreditTarget = incomingFrozen
        ? "reserve"
        : "available";
      const recouped = await applyRecoupmentSweep(
        store,
        party.payee_id,
        party.payee_name,
        creditAmount,
        now,
        {
          split_run_id: splitRun.id,
          excess_target: excessBucket,
        },
      );
      if (recouped.applied) {
        recoupment.push({ ...recouped, payee_id: party.payee_id });
        sweeps.push({
          ...recouped,
          payee_id: party.payee_id,
          payee_name: party.payee_name,
          excess_target: excessBucket,
        });
        skipBaas.add(ledger[ledger.length - 1]!.id);
        if (recouped.recouped_cents > 0) {
          glLegs.push(
            vaultCredit(
              COMPANY_VARIANCE_PAYEE_ID,
              "available",
              recouped.recouped_cents,
            ),
          );
        }
        if (recouped.excess_cents > 0) {
          glLegs.push(
            vaultCredit(party.payee_id, excessBucket, recouped.excess_cents),
          );
        }
      } else if (incomingFrozen && creditAmount > 0) {
        skipBaas.add(ledger[ledger.length - 1]!.id);
        await creditVault(
          store,
          party.payee_id,
          party.payee_name,
          creditAmount,
          "reserve",
          now,
        );
        vaultCredits.push({
          payeeId: party.payee_id,
          payeeName: party.payee_name,
          bucket: "reserve",
          amountCents: creditAmount,
        });
        glLegs.push(vaultCredit(party.payee_id, "reserve", creditAmount));
      } else if (!input.settle && creditAmount > 0) {
        await creditVault(
          store,
          party.payee_id,
          party.payee_name,
          creditAmount,
          "pending",
          now,
        );
        vaultCredits.push({
          payeeId: party.payee_id,
          payeeName: party.payee_name,
          bucket: "pending",
          amountCents: creditAmount,
        });
        glLegs.push(vaultCredit(party.payee_id, "pending", creditAmount));
      } else if (input.settle && creditAmount > 0) {
        baasDirectCents += creditAmount;
      }
    }
    if (item.company_dust_cents > 0) {
      dustLedger.push(
        await store.insertCompanyDust({
          split_run_id: splitRun.id,
          line_item_id: storedItem.id,
          amount_cents: item.company_dust_cents,
          variance_account_id: COMPANY_VARIANCE_PAYEE_ID,
          created_at: createdAt,
        }),
      );
      await creditVault(
        store,
        COMPANY_VARIANCE_PAYEE_ID,
        COMPANY_VARIANCE_PAYEE_NAME,
        item.company_dust_cents,
        "pending",
        now,
      );
      vaultCredits.push({
        payeeId: COMPANY_VARIANCE_PAYEE_ID,
        payeeName: COMPANY_VARIANCE_PAYEE_NAME,
        bucket: "pending",
        amountCents: item.company_dust_cents,
      });
      glLegs.push(
        vaultCredit(
          COMPANY_VARIANCE_PAYEE_ID,
          "pending",
          item.company_dust_cents,
        ),
      );
    }
  }

  if (baasDirectCents > 0) {
    glLegs.push(fboCredit(baasDirectCents));
  }
  let journal: PostJournalResult;
  try {
    journal = await postJournal(
      store,
      {
        kind: "royalty_ingest",
        ref_type: "split_run",
        ref_id: splitRun.id,
        legs: glLegs,
      },
      now,
    );
  } catch (error) {
    // The engine throws on store-level failures (bounded sequence retry
    // exhausted, journal insert rejected) — the same vault-vs-GL divergence
    // as an !ok result, so the same compensation applies (audit #6).
    const problems = await compensateFailedSaga(
      store,
      vaultCredits,
      sweeps,
      withholding,
      now,
    );
    return {
      ok: false,
      status: 500,
      code: "journal_write_failed",
      message: sagaFailureMessage(
        error instanceof Error ? error.message : "Journal write failed.",
        problems,
        sagaHadSubstantiveWrites(vaultCredits, sweeps, withholding),
      ),
    };
  }
  if (!journal.ok) {
    // Audit #6: this return used to leave every saga write live — line
    // items, ledger rows, vault credits, escrow, YTD — with NO GL journal,
    // so the vaults and the GL disagreed. Compensate the external world
    // (vaults, recoupment, tax trail) before reporting; the journalless
    // run/ledger/line-item rows remain as inert records of a failed
    // attempt (they move no money and cannot be reversed — no journal).
    const problems = await compensateFailedSaga(
      store,
      vaultCredits,
      sweeps,
      withholding,
      now,
    );
    return {
      ok: false,
      status: 500,
      code: journal.code,
      message: sagaFailureMessage(
        journal.message,
        problems,
        sagaHadSubstantiveWrites(vaultCredits, sweeps, withholding),
      ),
    };
  }

  if (!input.settle) {
    return {
      ok: true,
      value: {
        split_run: splitRun,
        line_items: lineItems,
        ledger,
        company_dust_ledger: dustLedger,
        variance_account_cents: allocated.varianceAccountCents,
        zero_balance: true,
        withholding,
        recoupment,
        settlement: null,
      },
    };
  }

  const adapter = getBaasAdapter(store);
  const transfers: Array<Extract<BaasTransferResult, { ok: true }>["transfer"]> =
    [];
  const settledLedger: LedgerTransactionRecord[] = [];
  for (const row of ledger) {
    if (skipBaas.has(row.id)) {
      settledLedger.push(row);
      continue;
    }
    const result = await settleLedgerThroughBaas(
      store,
      adapter,
      row.id,
      input.rail,
    );
    if (!result.ok) {
      return result;
    }
    transfers.push(result.transfer);
    const updated = await store.getLedgerTransaction(row.id);
    if (updated) {
      settledLedger.push(updated);
    }
  }

  return {
    ok: true,
    value: {
      split_run: splitRun,
      line_items: lineItems,
      ledger: settledLedger,
      company_dust_ledger: dustLedger,
      variance_account_cents: allocated.varianceAccountCents,
      zero_balance: true,
      withholding,
      recoupment,
      settlement: { rail: input.rail, transfers },
    },
  };
}
