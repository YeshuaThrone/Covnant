// Ported from EmeraldVal PR #41 src/modules/ledger/audit.test.ts (D2, async
// adaptation): InMemoryStore injection per repo test patterns, store reads
// and creditVault awaited. Chain verification now recomputes through the
// canonical hashJournal — the reconcile test proves the audit agrees with
// what postJournal actually posted.
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { calculateUdrSplits } from "@/lib/server/udrSplits";
import { auditLedger, glVaultLiabilityCents, immutableLedgerLog } from "../audit";
import { fboDebit, vaultCredit } from "../journal";
import { creditVault } from "@/modules/vaults/engine";

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
