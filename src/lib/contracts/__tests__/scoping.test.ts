import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getContract,
  listContracts,
  markContractFinal,
  saveContract,
  type ContractViewer,
  type StoredContract,
} from '../store';
import type { AgreementContext } from '../generator';

/**
 * Contract tenant scoping (audit F6/F7, spec D7) — the store-level
 * ownership engine the pages, the finalize action, and the export route
 * read through.
 *
 * The brief's attack path, replayed: creator A must not read, export, or
 * finalize creator B's contract — every miss identical to unknown-id
 * (undefined / the action's not-found shape, never a 403-style
 * distinction) — while creator A still sees their own, operators see all
 * (NULL-creator rows included), and migration 0062 stays double-apply
 * safe. Runs against the in-memory tier (no Supabase env in vitest) —
 * the same store seam the seeded preview uses.
 */

const AS_A: ContractViewer = { role: 'creator', creatorId: 'rh_A' };
const AS_B: ContractViewer = { role: 'creator', creatorId: 'rh_B' };
const AS_OPERATOR: ContractViewer = { role: 'operator' };

function context(title: string, cbtCode: string): AgreementContext {
  return {
    asset: {
      title,
      mediumLabel: 'Music',
      cbtCode,
      displayCode: cbtCode,
      identifiers: [],
    },
    pools: [],
    parties: [],
    fields: {
      effectiveDate: 'January 1, 2026',
      territory: 'Worldwide',
      term: 'Twelve (12) months from the Effective Date',
      fee: 'As separately agreed in writing',
      governingLaw: 'the State of Delaware, United States',
    },
  };
}

let aContract: StoredContract;
let bContract: StoredContract;
let unattributed: StoredContract;

beforeEach(async () => {
  // Fresh memory tier per test — no cross-test leakage through the
  // globalThis-guarded store.
  globalThis.__covnantContractStore = undefined;
  aContract = await saveContract(
    { cbtCode: 'CBT-A-0001', templateId: 'MUSIC_SPLIT_SHEET', industry: 'MUSIC', context: context('A Asset', 'CBT-A-0001') },
    'rh_A',
  );
  bContract = await saveContract(
    { cbtCode: 'CBT-B-0001', templateId: 'MUSIC_SPLIT_SHEET', industry: 'MUSIC', context: context('B Asset', 'CBT-B-0001') },
    'rh_B',
  );
  // A legacy row: saved without a creator stamp (pre-0062 data, or a pure
  // operator save) — operator-visible only.
  unattributed = await saveContract({
    cbtCode: 'CBT-L-0001',
    templateId: 'MUSIC_SPLIT_SHEET',
    industry: 'MUSIC',
    context: context('Legacy Asset', 'CBT-L-0001'),
  });
});

describe('creator-scoped reads (spec D7)', () => {
  it('creator A reads their own contract', async () => {
    const record = await getContract(aContract.id, AS_A);
    expect(record?.id).toBe(aContract.id);
    expect(record?.creatorId).toBe('rh_A');
  });

  it("creator A cannot read creator B's contract — identical to unknown-id", async () => {
    const foreign = await getContract(bContract.id, AS_A);
    const unknown = await getContract('CTR-DOESNOTEXIST', AS_A);
    // The exact equivalence the cross-tenant rule demands: a foreign id is
    // indistinguishable from a nonexistent one.
    expect(foreign).toBeUndefined();
    expect(foreign).toBe(unknown);
  });

  it('a creator cannot read NULL-creator rows — operator-visible only', async () => {
    expect(await getContract(unattributed.id, AS_A)).toBeUndefined();
  });

  it('the no-principal viewer sees nothing (anonymous, door closed)', async () => {
    expect(await getContract(aContract.id, null)).toBeUndefined();
    expect(await listContracts(null)).toEqual([]);
  });
});

describe('creator-scoped listing (spec D7)', () => {
  it("creator A lists only their own — never B's, never NULL-creator rows", async () => {
    const list = await listContracts(AS_A);
    expect(list.map((record) => record.id)).toEqual([aContract.id]);
  });

  it('creator B lists only their own', async () => {
    const list = await listContracts(AS_B);
    expect(list.map((record) => record.id)).toEqual([bContract.id]);
  });

  it("the operator lists every row — the other creator's and NULL-creator rows included", async () => {
    const list = await listContracts(AS_OPERATOR);
    expect(list.map((record) => record.id).sort()).toEqual(
      [aContract.id, bContract.id, unattributed.id].sort(),
    );
  });

  it('the unscoped read keeps the internal-caller behavior (demo seeds, operator-gated admin surfaces)', async () => {
    const list = await listContracts();
    expect(list.map((record) => record.id).sort()).toEqual(
      [aContract.id, bContract.id, unattributed.id].sort(),
    );
  });
});

describe('creator-scoped finalize (spec D7)', () => {
  it("creator A cannot finalize creator B's contract — identical to unknown-id", async () => {
    const foreign = await markContractFinal(bContract.id, AS_A);
    const unknown = await markContractFinal('CTR-DOESNOTEXIST', AS_A);
    expect(foreign).toBeUndefined();
    expect(foreign).toBe(unknown);
    // Nothing was written: B's contract is still a DRAFT.
    expect((await getContract(bContract.id, AS_OPERATOR))?.status).toBe('DRAFT');
  });

  it('creator A finalizes their own contract', async () => {
    const updated = await markContractFinal(aContract.id, AS_A);
    expect(updated?.status).toBe('FINAL');
  });

  it('the operator finalizes any row, NULL-creator rows included', async () => {
    const updated = await markContractFinal(unattributed.id, AS_OPERATOR);
    expect(updated?.status).toBe('FINAL');
  });
});

describe('the ownership stamp (spec D7)', () => {
  it("a new save stamps the creating session's creator id", async () => {
    const saved = await saveContract(
      { cbtCode: 'CBT-A-0002', templateId: 'MUSIC_SPLIT_SHEET', industry: 'MUSIC', context: context('A Asset 2', 'CBT-A-0002') },
      'rh_A',
    );
    expect(saved.creatorId).toBe('rh_A');
  });

  it('an unattributed save stamps NULL — operator-visible only, like legacy rows', async () => {
    const saved = await saveContract({
      cbtCode: 'CBT-L-0002',
      templateId: 'MUSIC_SPLIT_SHEET',
      industry: 'MUSIC',
      context: context('Legacy Asset 2', 'CBT-L-0002'),
    });
    expect(saved.creatorId).toBeNull();
  });

  it('a re-save never re-stamps — the original owner keeps the row even if another id reaches the update', async () => {
    await saveContract(
      {
        cbtCode: bContract.cbtCode,
        templateId: bContract.templateId,
        industry: bContract.industry,
        context: context('B Asset (edited)', bContract.cbtCode),
        id: bContract.id,
      },
      'rh_A',
    );
    const record = await getContract(bContract.id, AS_OPERATOR);
    expect(record?.creatorId).toBe('rh_B');
  });
});

describe("migration 0062 — double-apply safe (the repo's CI migration contract)", () => {
  const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations');
  const FILE = '0062_contract_creator_id.sql';

  it("exists and sorts after 0061 (the migrations' lexical-order contract)", () => {
    const migrations = readdirSync(MIGRATIONS_DIR).sort();
    expect(migrations).toContain(FILE);
    expect(migrations.indexOf(FILE)).toBe(migrations.length - 1);
  });

  it('runs only idempotent DDL — every statement re-applies as a no-op', () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, FILE), 'utf8');
    // Strip comments, then take the statements.
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements.length).toBe(2);
    for (const statement of statements) {
      expect(statement, 'every DDL statement must be IF NOT EXISTS (CI applies each migration twice)').toMatch(
        /alter table\s+\S+\s+add column if not exists|create index if not exists/,
      );
    }
    expect(sql).toContain('creator_id text');
    expect(sql).toContain('idx_contracts_creator_id');
  });
});
