// Ported from EmeraldVal PR #41 src/modules/ledger/audit.test.ts (D2, async
// adaptation): InMemoryStore injection per repo test patterns, store reads
// and creditVault awaited. Chain verification now recomputes through the
// canonical hashJournal — the reconcile test proves the audit agrees with
// what postJournal actually posted.
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { calculateUdrSplits } from "@/lib/server/udrSplits";
import { auditLedger, glVaultLiabilityCents, immutableLedgerLog, ledgerAuditHealthy } from "../audit";
import { fboDebit, journalIsBalanced, netDebit, vaultCredit, type GlLegInput } from "../journal";
import { vaultGlAccount } from "@/modules/don/constants";
import { creditVault } from "@/modules/vaults/engine";
import { applyDisputeLock } from "@/modules/vaults/dispute";
import type { DisputeLockPayload } from "@/lib/don/validation";

describe("auditLedger", () => {
  it("reports empty books as balanced and reconciled", async () => {
    const store = new InMemoryStore();
    const report = await auditLedger(store);
    expect(report.double_entry.balanced).toBe(true);
    expect(report.books_reconcile).toBe(true);
    expect(report.fbo_cash_cents).toBe(0);
    expect(report.immutable.valid).toBe(true);
    expect(report.immutable.journal_count).toBe(0);
    expect((await immutableLedgerLog(store)).journals).toEqual([]);
  });

  it("reconciles FBO cash to creator vaults plus company dust after a split", async () => {
    const store = new InMemoryStore();
    const result = await calculateUdrSplits(store, {
      source: "spotify",
      period: "2026-08",
      currency: "USD",
      settle: false,
      rail: "rtp",
      line_items: [
        {
          work_id: "trk_01",
          work_title: "Midnight On 6th",
          amount_cents: 10_000,
          splits: [
            {
              payee_id: "c1",
              payee_name: "Yeshua Throne",
              role: "creator",
              share_bps: 7000,
            },
            {
              payee_id: "l1",
              payee_name: "Throne Records",
              role: "label",
              share_bps: 3000,
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    const report = await auditLedger(store);
    expect(report.double_entry.balanced).toBe(true);
    expect(report.books_reconcile).toBe(true);
    expect(report.fbo_cash_cents).toBe(10_000);
    expect(report.vault_liability_cents).toBe(10_000);
    expect(report.immutable.valid).toBe(true);
    expect(report.double_entry.pair_count).toBeGreaterThan(0);
    const log = await immutableLedgerLog(store);
    expect(log.journals).toHaveLength(1);
    expect(log.journals[0]?.debit_account_pairs[0]?.debit_account).toBe("fbo_cash");
    expect(log.immutable.valid).toBe(true);
  });

  it("flags a vault/FBO mismatch and splits company dust", async () => {
    const store = new InMemoryStore();
    await creditVault(store, "c1", "Yeshua Throne", 50, "available");
    await creditVault(store, "platform", "Don Engine Variance", 7, "pending");
    const report = await auditLedger(store);
    expect(report.books_reconcile).toBe(false);
    expect(report.creator_vault_cents).toBe(50);
    expect(report.company_dust_cents).toBe(7);
    expect(report.variance_cents).toBe(-57);
  });

  it("flags an unbalanced GL even when vaults are empty", async () => {
    const store = new InMemoryStore();
    const journal = await store.insertGlJournal({
      kind: "royalty_ingest",
      ref_type: "x",
      ref_id: "1",
      created_at: new Date().toISOString(),
    });
    await store.insertGlEntry({
      journal_id: journal.id,
      account: "fbo_cash",
      debit_cents: 9,
      credit_cents: 0,
      created_at: new Date().toISOString(),
    });
    const report = await auditLedger(store);
    expect(report.double_entry.balanced).toBe(false);
    expect(report.fbo_cash_cents).toBe(9);
    expect(report.immutable.valid).toBe(false);
  });

  it("nets vault liability from GL legs", () => {
    const legs = [fboDebit(25), vaultCredit("c1", "pending", 25)];
    expect(glVaultLiabilityCents(legs)).toBe(25);
    expect(glVaultLiabilityCents([fboDebit(1)])).toBe(0);
  });
});

/**
 * ledgerAuditHealthy is the verdict the scheduled tamper-evidence check
 * (GET /api/admin/ledger/audit, F7) keys its 200/503 on. These tests pin
 * both conjuncts independently: books that reconcile through a broken
 * chain are NOT healthy, and neither is a valid chain over diverged
 * books.
 */
describe("ledgerAuditHealthy", () => {
  it("is true when the chain is valid and books reconcile", async () => {
    const store = new InMemoryStore();
    expect(await ledgerAuditHealthy(await auditLedger(store))).toBe(true);
  });

  it("is false when books diverge even with a valid chain", async () => {
    const store = new InMemoryStore();
    await creditVault(store, "c1", "Yeshua Throne", 50, "available");
    const report = await auditLedger(store);
    expect(report.books_reconcile).toBe(false);
    expect(report.immutable.valid).toBe(true);
    expect(ledgerAuditHealthy(report)).toBe(false);
  });

  it("is false when the hash chain is broken even though books reconcile", async () => {
    const base = new InMemoryStore();
    const split = await calculateUdrSplits(base, {
      source: "spotify",
      period: "2026-08",
      currency: "USD",
      settle: false,
      rail: "rtp",
      line_items: [
        {
          work_id: "trk_01",
          work_title: "Midnight On 6th",
          amount_cents: 10_000,
          splits: [
            {
              payee_id: "c1",
              payee_name: "Yeshua Throne",
              role: "creator",
              share_bps: 7000,
            },
            {
              payee_id: "l1",
              payee_name: "Throne Records",
              role: "label",
              share_bps: 3000,
            },
          ],
        },
      ],
    });
    if (!split.ok) throw new Error("fixture split run must settle");

    // Tamper: recompute-verification must fail on a clobbered entry_hash
    // while every balance still reconciles.
    const tamperedJournals = (await base.listGlJournals()).map((journal) => ({
      ...journal,
      entry_hash: `0x${"0".repeat(64)}`,
    }));
    class TamperedChainStore extends InMemoryStore {
      override async listGlJournals() {
        return tamperedJournals;
      }
    }

    const report = await auditLedger(new TamperedChainStore());
    expect(report.immutable.valid).toBe(false);
    expect(report.books_reconcile).toBe(true);
    expect(ledgerAuditHealthy(report)).toBe(false);
  });
});

// Dispute freeze/thaw (F5): the bucket sweeps between available/pending and
// reserve are real money moves — the GL must post the dispute_lock /
// dispute_unlock journals sovereign_vaults implies, or the books stop
// describing the vaults. These cases reconcile each dispute journal's
// per-bucket legs against the vault's actual bucket deltas.
describe("dispute bucket-move GL journals", () => {
  const NOW = new Date("2026-10-09T00:00:00.000Z");
  const PAYEE_ID = "c1";
  const PAYEE_NAME = "Yeshua Throne";

  function disputePayload(
    overrides: Partial<DisputeLockPayload> = {},
  ): DisputeLockPayload {
    return {
      payee_id: PAYEE_ID,
      work_id: undefined,
      locked: true,
      line_item_id: undefined,
      amount_cents: undefined,
      ...overrides,
    };
  }

  async function legsOfKind(store: InMemoryStore, kind: string): Promise<GlLegInput[]> {
    const legs: GlLegInput[] = [];
    for (const journal of await store.listGlJournals()) {
      if (journal.kind !== kind) {
        continue;
      }
      for (const entry of await store.listGlEntriesByJournal(journal.id)) {
        legs.push({
          account: entry.account,
          debit_cents: entry.debit_cents,
          credit_cents: entry.credit_cents,
        });
      }
    }
    return legs;
  }

  it("posts balanced dispute_lock/dispute_unlock journals that track the bucket moves", async () => {
    const store = new InMemoryStore();
    await creditVault(store, PAYEE_ID, PAYEE_NAME, 800, "available", NOW);
    await creditVault(store, PAYEE_ID, PAYEE_NAME, 200, "pending", NOW);
    const before = (await store.getVault(PAYEE_ID))!;

    const locked = await applyDisputeLock(store, disputePayload(), NOW);
    expect(locked.ok).toBe(true);
    if (!locked.ok) throw new Error("freeze failed");
    expect(locked.frozen_cents).toBe(1000);

    const frozen = (await store.getVault(PAYEE_ID))!;
    expect(frozen.available_balance).toBe(0);
    expect(frozen.pending_balance).toBe(0);
    expect(frozen.reserve_balance).toBe(1000);

    // The freeze sweep (available/pending debits -> reserve credit) is in
    // the GL, per bucket, to the cent. Vault accounts are liability
    // accounts — a credit raises the bucket — so each bucket account's net
    // debit must equal that bucket's balance decrease.
    const lockLegs = await legsOfKind(store, "dispute_lock");
    expect(lockLegs.length).toBeGreaterThan(0);
    expect(journalIsBalanced(lockLegs)).toBe(true);
    expect(netDebit(lockLegs, vaultGlAccount(PAYEE_ID, "available"))).toBe(
      before.available_balance - frozen.available_balance,
    );
    expect(netDebit(lockLegs, vaultGlAccount(PAYEE_ID, "pending"))).toBe(
      before.pending_balance - frozen.pending_balance,
    );
    expect(netDebit(lockLegs, vaultGlAccount(PAYEE_ID, "reserve"))).toBe(
      before.reserve_balance - frozen.reserve_balance,
    );

    const unlocked = await applyDisputeLock(
      store,
      disputePayload({ locked: false }),
      NOW,
    );
    expect(unlocked.ok).toBe(true);

    const restored = (await store.getVault(PAYEE_ID))!;
    expect(restored.available_balance).toBe(before.available_balance);
    expect(restored.pending_balance).toBe(before.pending_balance);
    expect(restored.reserve_balance).toBe(before.reserve_balance);

    // The thaw posts the exact inverse sweep as a balanced journal.
    const unlockLegs = await legsOfKind(store, "dispute_unlock");
    expect(unlockLegs.length).toBeGreaterThan(0);
    expect(journalIsBalanced(unlockLegs)).toBe(true);
    expect(netDebit(unlockLegs, vaultGlAccount(PAYEE_ID, "reserve"))).toBe(
      frozen.reserve_balance - restored.reserve_balance,
    );
    expect(netDebit(unlockLegs, vaultGlAccount(PAYEE_ID, "available"))).toBe(
      frozen.available_balance - restored.available_balance,
    );
    expect(netDebit(unlockLegs, vaultGlAccount(PAYEE_ID, "pending"))).toBe(
      frozen.pending_balance - restored.pending_balance,
    );

    const report = await auditLedger(store);
    expect(report.double_entry.balanced).toBe(true);
    expect(report.immutable.valid).toBe(true);
    expect(report.immutable.journal_count).toBe(2);
  });

  it("tracks a partial freeze that spans both buckets in the GL", async () => {
    const store = new InMemoryStore();
    await creditVault(store, PAYEE_ID, PAYEE_NAME, 800, "available", NOW);
    await creditVault(store, PAYEE_ID, PAYEE_NAME, 200, "pending", NOW);

    const locked = await applyDisputeLock(
      store,
      disputePayload({ amount_cents: 900 }),
      NOW,
    );
    expect(locked.ok).toBe(true);
    if (!locked.ok) throw new Error("freeze failed");

    const frozen = (await store.getVault(PAYEE_ID))!;
    expect(frozen.available_balance).toBe(0);
    expect(frozen.pending_balance).toBe(100);
    expect(frozen.reserve_balance).toBe(900);

    const lockLegs = await legsOfKind(store, "dispute_lock");
    expect(journalIsBalanced(lockLegs)).toBe(true);
    expect(netDebit(lockLegs, vaultGlAccount(PAYEE_ID, "available"))).toBe(800);
    expect(netDebit(lockLegs, vaultGlAccount(PAYEE_ID, "pending"))).toBe(100);
    expect(netDebit(lockLegs, vaultGlAccount(PAYEE_ID, "reserve"))).toBe(-900);
  });

  it("posts no dispute journal for a freeze that moves nothing", async () => {
    const store = new InMemoryStore();
    await creditVault(store, PAYEE_ID, PAYEE_NAME, 0, "available", NOW);

    const locked = await applyDisputeLock(store, disputePayload(), NOW);
    expect(locked.ok).toBe(true);

    const report = await auditLedger(store);
    expect(report.immutable.journal_count).toBe(0);
  });
});
