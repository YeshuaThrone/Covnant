import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

/**
 * Schema pin — public.creator_profiles, the compliance home table.
 *
 * Pins the table's shape across both of its migrations (the same
 * readFileSync + content-pin convention as the ledger write inventory):
 *
 *   0003_creator_profiles.sql  — base profile, keyed to auth.users(id)
 *   0004_creator_compliance.sql — user compliance schema: kyc_status,
 *     tax_form_type, tax_verified, bank_account_linked
 *
 * The four compliance columns are pinned to the user's exact spec
 * (2026-09-09): name, type, default, and nullability. The requested
 * udr_accepted_at is NOT a new column — it already exists as
 * udr_terms_accepted_at (0003, written by the signup route); 0004's header
 * must keep documenting that mapping. auth.users is Supabase-managed and
 * must never be altered or referenced in DDL beyond 0003's id FK.
 */

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations');

const read = (file: string): string => readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

/** 0003 base columns: [name, exact definition fragment in the create table]. */
const BASE_COLUMNS: Array<[string, string]> = [
  ['id', 'uuid primary key references auth.users (id) on delete cascade'],
  ['stage_name', 'text not null'],
  ['legal_name', 'text not null'],
  ['email', 'text not null'],
  ['phone', 'text'],
  ['phone_verified_at', 'timestamptz'],
  ['core_industry', 'text not null'],
  ['title', 'text'],
  ['udr_terms_accepted_at', 'timestamptz not null default now()'],
  ['created_at', 'timestamptz not null default now()'],
];

/** 0004 compliance columns: the user's exact spec, in the repo's lowercase SQL style. */
const COMPLIANCE_COLUMNS: Array<{ name: string; type: string; def: string }> = [
  { name: 'kyc_status', type: 'varchar(50)', def: "'PENDING_INITIALIZATION'" },
  { name: 'tax_form_type', type: 'varchar(20)', def: "'W9'" },
  { name: 'tax_verified', type: 'boolean', def: 'false' },
  { name: 'bank_account_linked', type: 'boolean', def: 'false' },
];

const alterLine = ({ name, type, def }: { name: string; type: string; def: string }): string =>
  `add column if not exists ${name} ${type} default ${def}`;

describe('creator_profiles schema — 0003 base shape', () => {
  it('keeps every base column exactly as 0003 shipped it', () => {
    const sql = read('0003_creator_profiles.sql');
    for (const [name, fragment] of BASE_COLUMNS) {
      // 0003 aligns column definitions with extra whitespace, so locate the
      // column's line by name-prefix and assert its definition fragment.
      const line = sql
        .split('\n')
        .find((row) => row.trimStart().startsWith(`${name} `));
      expect(line, `0003 lost base column: ${name}`).toBeDefined();
      expect(line, `0003 changed base column: ${name}`).toContain(fragment);
    }
  });

  it('still documents that udr_terms_accepted_at is the UDR acceptance record', () => {
    const sql = read('0003_creator_profiles.sql');
    expect(sql).toContain('udr_terms_accepted_at timestamptz not null default now()');
  });
});

describe('creator_profiles schema — 0004 compliance columns', () => {
  it('adds all four compliance columns with the exact user spec', () => {
    const sql = read('0004_creator_compliance.sql');
    for (const column of COMPLIANCE_COLUMNS) {
      expect(sql, `missing compliance column: ${column.name}`).toContain(alterLine(column));
    }
  });

  it('leaves the compliance columns nullable (no not null on their lines)', () => {
    const sql = read('0004_creator_compliance.sql');
    for (const column of COMPLIANCE_COLUMNS) {
      const line = sql
        .split('\n')
        .find((row) => row.includes(alterLine(column)));
      expect(line, `could not locate the alter for ${column.name}`).toBeDefined();
      expect(line).not.toContain('not null');
    }
  });

  it('is idempotent — every compliance column uses add column if not exists', () => {
    const sql = read('0004_creator_compliance.sql');
    const idempotentAdds = sql.match(/add column if not exists /g) ?? [];
    expect(idempotentAdds.length).toBe(COMPLIANCE_COLUMNS.length);
  });

  it('persists the user value domains as database comments', () => {
    const sql = read('0004_creator_compliance.sql');
    expect(sql).toContain(
      "comment on column public.creator_profiles.kyc_status is\n  'KYC verification status — values PENDING, VERIFIED, REJECTED.",
    );
    expect(sql).toContain(
      "comment on column public.creator_profiles.tax_form_type is\n  'Tax form classification — values W9, W8BEN, EIN.",
    );
  });

  it('documents the home-table rationale, the udr_accepted_at mapping, and the default backfill', () => {
    const sql = read('0004_creator_compliance.sql');
    // auth.users is Supabase-managed; creator_profiles is the profile home.
    expect(sql).toContain('auth.users is Supabase-managed');
    expect(sql).toContain('creator_profiles is the profile home');
    // The requested udr_accepted_at maps onto the existing 0003 column.
    expect(sql).toContain('udr_accepted_at');
    expect(sql).toContain('udr_terms_accepted_at');
    // ADD COLUMN with a constant DEFAULT backfills existing rows.
    expect(sql.toLowerCase()).toContain('backfills all existing rows');
  });

  it('never touches the ledger or auth.users DDL (guardrail: pure compliance schema)', () => {
    const sql = read('0004_creator_compliance.sql');
    expect(sql).not.toContain('universal_royalty_ledger');
    expect(sql).not.toContain('alter table auth.users');
    expect(sql).not.toContain('create table auth.users');
  });
});
