import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

/**
 * Generation 9 — the extended T1 pin: the COMPLETE universal_royalty_ledger
 * write inventory, locked per mechanism so a future write path cannot be
 * added silently. Counted by repo search at build time (every count below
 * re-derives from the source on every CI run):
 *
 *   Mechanism 1 · raw SQL INSERT statements ............ 8
 *     - banking route: 6 statements (3 wired money paths ×
 *       primary / 42703-fallback variants) — Gen 8, unchanged.
 *     - increase webhook: 2 statements (1 wired merge point ×
 *       metadata / 42703-fallback variants) — Gen 8, unchanged.
 *
 *   Mechanism 2 · supabase-js .insert()/.upsert() calls .. 4
 *     - payouts/withdraw route: 2 calls (1 wired site × stamped
 *       primary / bare-fallback) — Gen 9.
 *     - lib/ledger/store.ts rememberSettlement: 2 calls (1 wired
 *       site × stamped primary / bare-fallback) — Gen 9. The spec's
 *       inventory lists this helper under the engine-caller mechanism
 *       (it is the repo-side mirror of the engine's upsert); it is
 *       mechanically a supabase-js upsert, so it is pinned here AND
 *       as an engine-result persistence boundary below.
 *
 *   Mechanism 3 · engine (SDK) ledger upsert + repo callers . 1 + 1
 *     - engine/covenant-master-sdk.ts: exactly 1 `.upsert(ledgerEntries…)`
 *       inside processUniversalSocialWebhookAction — the SDK is
 *       hash-locked byte-for-byte (vendored-sdk.test.ts) and can never
 *       stamp itself.
 *     - app/webhooks/claims route: exactly 1 repo-side invocation,
 *       stamped by the bounded post-upsert metadata-only enrichment in
 *       lib/ledger/engine-stamp.ts — Gen 9.
 *
 *   TOTAL: 13 ledger-write call expressions across 7 wired write paths.
 *
 * The file-set pin below is the silent-add guard: ANY new non-test src
 * file that mentions the table (even in a comment) breaks this test and
 * forces the inventory to be updated in the same change.
 */

const SRC_ROOT = path.join(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = path.join(SRC_ROOT, '..', 'supabase', 'migrations');

/** Every non-test src file that references the ledger table, relative to src/. */
function ledgerReferencingFiles(): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__') continue; // tests may reference the table freely
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        if (readFileSync(full, 'utf8').includes('universal_royalty_ledger')) {
          hits.push(path.relative(SRC_ROOT, full).split(path.sep).join('/'));
        }
      }
    }
  };
  walk(SRC_ROOT);
  return hits.sort();
}

const read = (relative: string): string => readFileSync(path.join(SRC_ROOT, relative), 'utf8');

const countMatches = (source: string, pattern: RegExp): number => (source.match(pattern) ?? []).length;

/** The inventoried file set, with each file's role — any change must land here. */
const INVENTORIED_FILES: Record<string, string> = {
  'app/api/artist/dashboard/route.ts': 'READ — escrow dashboard balance source',
  'app/api/banking/denomination.ts': 'DOC — cents/decimal storage note',
  'app/api/banking/route.ts': 'RAW_SQL ×6 — Gen 8 stamped INSERTs (3 wired paths)',
  'app/api/covnant/accounts/provision/route.ts': 'DOC — webhook crediting note',
  'app/api/covnant/auth/signup/route.ts': 'DOC — scope guard (never touches the ledger)',
  'app/api/covnant/webhooks/increase/route.ts': 'RAW_SQL ×2 — Gen 8 stamped INSERTs (1 wired merge)',
  'app/api/health/db/route.ts': 'READ — count probe',
  'app/api/ledger/route.ts': 'READ — store-backed listing',
  'app/api/payouts/withdraw/route.ts': 'SUPABASE_JS ×2 — Gen 9 stamped DISBURSEMENT insert (1 wired site)',
  'engine/covenant-master-sdk.ts': 'ENGINE ×1 — hash-locked internal ledger upsert',
  'lib/contracts/payouts.ts': 'DOC — display layer, type-only ledger reference',
  'lib/escrow/balance.ts': 'READ — disbursements scan',
  'lib/ledger/cbt-settlement.ts': 'HELPER — stamp derivation docs (Gen 8/9)',
  'lib/ledger/engine-stamp.ts': 'ENGINE — Gen 9 bounded metadata-only enrichment executor',
  'lib/ledger/store.ts': 'SUPABASE_JS ×2 — Gen 9 stamped rememberSettlement upsert (1 wired site)',
};

describe('T1 extended — the universal_royalty_ledger write inventory is pinned', () => {
  it('pins mechanism 1 at exactly 8 raw-SQL INSERT statements (banking 6 + webhook 2)', () => {
    const banking = read('app/api/banking/route.ts');
    const webhook = read('app/api/covnant/webhooks/increase/route.ts');
    expect(countMatches(banking, /INSERT INTO universal_royalty_ledger/g)).toBe(6);
    expect(countMatches(webhook, /INSERT INTO universal_royalty_ledger/g)).toBe(2);
    // Gen 8 stamps stay wired exactly as shipped.
    expect(countMatches(banking, /cbtSettlementMetadataSql\(/g)).toBe(3);
    expect(countMatches(webhook, /withCbtSettlementCode\(/g)).toBe(1);
  });

  it('pins mechanism 2 at exactly 4 supabase-js ledger writes (withdraw 2 + store 2, one wired site each)', () => {
    const withdraw = read('app/api/payouts/withdraw/route.ts');
    const store = read('lib/ledger/store.ts');
    // Stamped primary + bare 42703/PGRST204 fallback per wired site.
    expect(countMatches(withdraw, /from\('universal_royalty_ledger'\)\s*\.insert\(/g)).toBe(2);
    expect(countMatches(store, /from\('universal_royalty_ledger'\)\s*\.upsert\(/g)).toBe(2);
    // Both sites stamp the primary attempt with the frozen derivation.
    expect(countMatches(withdraw, /stampSupabaseLedgerRow\(/g)).toBe(1);
    expect(countMatches(store, /stampSupabaseLedgerRow\(/g)).toBe(1);
  });

  it('pins mechanism 3 at exactly 1 hash-locked engine upsert with exactly 1 repo-side caller', () => {
    const sdk = read('engine/covenant-master-sdk.ts');
    const claims = read('app/api/webhooks/claims/route.ts');
    expect(countMatches(sdk, /\.upsert\(ledgerEntries/g)).toBe(1);
    expect(countMatches(claims, /await processUniversalSocialWebhookAction\(/g)).toBe(1);
    // The repo-side boundary performs the bounded metadata-only enrichment.
    expect(countMatches(claims, /stampEngineLedgerRowsCbt\(/g)).toBe(1);
    expect(read('lib/ledger/engine-stamp.ts')).toContain('universal_royalty_ledger');
  });

  it('pins the full inventory at 13 ledger-write call expressions across 7 wired paths', () => {
    const raw =
      countMatches(read('app/api/banking/route.ts'), /INSERT INTO universal_royalty_ledger/g) +
      countMatches(read('app/api/covnant/webhooks/increase/route.ts'), /INSERT INTO universal_royalty_ledger/g);
    const supabaseJs =
      countMatches(read('app/api/payouts/withdraw/route.ts'), /from\('universal_royalty_ledger'\)\s*\.insert\(/g) +
      countMatches(read('lib/ledger/store.ts'), /from\('universal_royalty_ledger'\)\s*\.upsert\(/g);
    const engine =
      countMatches(read('engine/covenant-master-sdk.ts'), /\.upsert\(ledgerEntries/g);
    expect(raw + supabaseJs + engine).toBe(13);
  });

  it('inventories every file that references the table — a new write path cannot be added silently', () => {
    const actual = ledgerReferencingFiles();
    const expected = Object.keys(INVENTORIED_FILES).sort();
    const unexpected = actual.filter((file) => !(file in INVENTORIED_FILES));
    const stale = expected.filter((file) => !actual.includes(file));
    expect(
      { unexpectedFiles: unexpected, staleInventoryEntries: stale },
      'universal_royalty_ledger is referenced outside the pinned inventory — extend T1 and stamp the new write path (see spec art_XmJ9WEX8).',
    ).toEqual({ unexpectedFiles: [], staleInventoryEntries: [] });
    expect(actual).toEqual(expected);
  });

  it('pins the no-DDL guard: no migration beyond the 0001 creation touches the table', () => {
    const migrations = readdirSync(MIGRATIONS_DIR).sort();
    expect(migrations).toEqual(['0001_covenant_init.sql', '0002_contracts.sql']);
    const referencing = migrations.filter((file) =>
      readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').includes('universal_royalty_ledger'),
    );
    expect(referencing).toEqual(['0001_covenant_init.sql']);
  });
});
