import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

/**
 * Schema pin — public.cbt_assets' dual-code columns (0056).
 *
 * The same readFileSync + content-pin convention as the creator profiles
 * schema test. Pins the PR #22 dual-code surface the migrations shipped
 * late (the 2026-10-05 production PGRST204 outage): every demo-door boot
 * failed because registerCBTAsset inserted a cvt_code column that no
 * migration had ever created. This pin guards the drift from both sides —
 *
 *   • 0001 must still NOT define cvt_code/holder_uct inline (0056 owns them);
 *   • 0056 must add both columns NULLABLE (existing rows survive), through
 *     idempotent `add column if not exists` alters only;
 *   • the cvt_code uniqueness must be the partial unique index (NULLs never
 *     conflict), never a table constraint.
 *
 * Consumers of record: src/engine/covenant-master-sdk.ts (registerCBTAsset's
 * insert) and src/lib/covnant/vault.ts (the CVT-addressed raw SQL).
 */

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations');

const read = (file: string): string => readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

describe('cbt_assets schema — 0056 dual-code columns', () => {
  it('adds both dual-code columns as nullable text', () => {
    const sql = read('0056_cbt_assets_dual_code_columns.sql');
    expect(sql).toContain('alter table public.cbt_assets add column if not exists cvt_code text;');
    expect(sql).toContain('alter table public.cbt_assets add column if not exists holder_uct text;');
  });

  it('keeps the columns nullable — no not null on their alter lines', () => {
    const sql = read('0056_cbt_assets_dual_code_columns.sql');
    for (const column of ['cvt_code', 'holder_uct']) {
      const line = sql
        .split('\n')
        .find((row) => row.includes(`add column if not exists ${column} `));
      expect(line, `could not locate the alter for ${column}`).toBeDefined();
      expect(line).not.toContain('not null');
    }
  });

  it('uniqueness is the partial unique index — pre-dual-code NULL rows never conflict', () => {
    const sql = read('0056_cbt_assets_dual_code_columns.sql');
    expect(sql).toContain(
      'create unique index if not exists uq_cbt_assets_cvt_code',
    );
    expect(sql).toContain('where cvt_code is not null');
    // The unique handle lives in the partial index, never a table constraint
    // that existing NULL-less-yet rows or future multi-NULL inserts would trip.
    expect(sql).not.toContain('unique (cvt_code)');
    expect(sql).not.toContain('unique(cvt_code)');
  });

  it('indexes the holder UCT lookup path', () => {
    const sql = read('0056_cbt_assets_dual_code_columns.sql');
    expect(sql).toContain(
      'create index if not exists idx_cbt_assets_holder_uct',
    );
  });

  it('is idempotent — two add column if not exists alters, two create if not exists indexes', () => {
    const sql = read('0056_cbt_assets_dual_code_columns.sql');
    expect(sql.match(/add column if not exists /g) ?? []).toHaveLength(2);
    expect(sql.match(/create (?:unique )?index if not exists /g) ?? []).toHaveLength(2);
  });

  it('owns the columns outright — 0001 still defines neither (the drift guard)', () => {
    const sql = read('0001_covenant_init.sql');
    expect(sql).not.toContain('cvt_code');
    expect(sql).not.toContain('holder_uct');
  });

  it('touches no other table and no RLS policy (guardrail: pure column additions)', () => {
    const sql = read('0056_cbt_assets_dual_code_columns.sql');
    expect(sql).not.toContain('enable row level security');
    expect(sql).not.toContain('create policy');
    expect(sql).not.toContain('add constraint');
    expect(sql).not.toContain(' references ');
  });
});
