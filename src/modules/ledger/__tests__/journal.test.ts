import { describe, expect, it } from "vitest";
import {
  fboCredit,
  fboDebit,
  invertLegs,
  vaultCredit,
  vaultDebit,
  validateJournal,
  type GlLegInput,
} from "../journal";

describe("validateJournal", () => {
  it("accepts a balanced journal", () => {
    expect(validateJournal([fboDebit(2500), vaultCredit("c1", "available", 2500)])).toEqual({
      ok: true,
      debits: 2500,
      credits: 2500,
    });
  });

  it("refuses an empty journal — a posted journal must move money", () => {
    expect(validateJournal([])).toEqual({ ok: false, debits: 0, credits: 0 });
  });

  it("refuses an unbalanced journal", () => {
    expect(validateJournal([fboDebit(2500), vaultCredit("c1", "available", 2400)])).toEqual({
      ok: false,
      debits: 2500,
      credits: 2400,
    });
  });

  it("refuses multi-leg journals where debits and credits drift apart", () => {
    const legs: GlLegInput[] = [
      fboDebit(300),
      fboDebit(200),
      vaultCredit("c1", "available", 499),
    ];
    expect(validateJournal(legs)).toEqual({ ok: false, debits: 500, credits: 499 });
  });

  it("refuses a single-sided journal even when a lone leg exists", () => {
    expect(validateJournal([fboDebit(100)])).toEqual({ ok: false, debits: 100, credits: 0 });
  });
});

describe("invertLegs", () => {
  it("produces the exact debit/credit inversion of every leg", () => {
    const original: GlLegInput[] = [
      fboDebit(2500),
      vaultCredit("c1", "available", 1000),
      vaultCredit("c1", "pending", 1500),
    ];
    expect(invertLegs(original)).toEqual([
      fboCredit(2500),
      vaultDebit("c1", "available", 1000),
      vaultDebit("c1", "pending", 1500),
    ]);
  });

  it("double inversion is the identity", () => {
    const original: GlLegInput[] = [fboDebit(777), vaultCredit("c1", "reserve", 777)];
    expect(invertLegs(invertLegs(original))).toEqual(original);
  });

  it("the inversion of a balanced journal is itself balanced", () => {
    const original: GlLegInput[] = [
      fboDebit(500),
      vaultCredit("c1", "available", 300),
      vaultCredit("c1", "pending", 200),
    ];
    const inverted = invertLegs(original);
    expect(validateJournal(inverted)).toEqual({ ok: true, debits: 500, credits: 500 });
  });
});

describe("vault leg builders", () => {
  it("debit/credit the exact GL account for each bucket", () => {
    expect(vaultDebit("c1", "available", 100)).toEqual({
      account: "vault:c1:available",
      debit_cents: 100,
      credit_cents: 0,
    });
    expect(vaultCredit("c1", "pending", 100)).toEqual({
      account: "vault:c1:pending",
      debit_cents: 0,
      credit_cents: 100,
    });
    expect(vaultDebit("c1", "reserve", 100)).toEqual({
      account: "vault:c1:reserve",
      debit_cents: 100,
      credit_cents: 0,
    });
    expect(vaultCredit("c1", "available", 100)).toEqual({
      account: "vault:c1:available",
      debit_cents: 0,
      credit_cents: 100,
    });
  });
});

describe("FBO leg builders", () => {
  it("build the bank's clearing account legs", () => {
    expect(fboDebit(900)).toEqual({
      account: "fbo_cash",
      debit_cents: 900,
      credit_cents: 0,
    });
    expect(fboCredit(900)).toEqual({
      account: "fbo_cash",
      debit_cents: 0,
      credit_cents: 900,
    });
  });
});
