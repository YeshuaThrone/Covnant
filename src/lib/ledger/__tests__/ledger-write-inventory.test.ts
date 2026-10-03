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
 *   Mechanism 4 · the SDK engine wire (covnant-sdk) ....... 2
 *     - covnant-sdk/src/engine/wire.ts: exactly 2 raw-SQL INSERT
 *       statements (1 wired site × metadata / 42703-fallback
 *       variants) — Gen 16: the settlement credit is CBT-stamped
 *       at INSERT and replay-guarded by the UNIQUE reference_id.
 *
 *   TOTAL: 15 ledger-write call expressions across 8 wired write paths.
 *
 *   READ SEAM (spec art_qNu4T32F — Creator Analytics Top Markets) ..... 0 writes
 *     - lib/server/{store,territorySettlement,supabaseStore,
 *       inMemoryStore,sqliteStore}.ts: the territory-settlement read
 *       seam (listTerritorySettlements) — select-only projections over
 *       the wire's metadata.sdk territory stamps, plus local-dev
 *       fixture affordances. Production writes remain the wire's; the
 *       15-expression write total above is unchanged.
 *
 * The file-set pin below is the silent-add guard: ANY new non-test src
 * file that mentions the table (even in a comment) breaks this test and
 * forces the inventory to be updated in the same change.
 */

const SRC_ROOT = path.join(__dirname, '..', '..', '..');
const SDK_SRC_ROOT = path.join(SRC_ROOT, '..', 'covnant-sdk', 'src');
const MIGRATIONS_DIR = path.join(SRC_ROOT, '..', 'supabase', 'migrations');

/**
 * Every non-test source file that references the ledger table — keyed
 * relative to src/ for the app tree and to the repo root (covnant-sdk/src
 * prefix) for the SDK package, whose wire is a wired write path too.
 */
function ledgerReferencingFiles(): string[] {
  const hits: string[] = [];
  const walk = (root: string, base: string): void => {
    for (const entry of readdirSync(root)) {
      const full = path.join(root, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__') continue; // tests may reference the table freely
        walk(full, base);
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        if (readFileSync(full, 'utf8').includes('universal_royalty_ledger')) {
          hits.push(path.relative(base, full).split(path.sep).join('/'));
        }
      }
    }
  };
  walk(SRC_ROOT, SRC_ROOT);
  walk(SDK_SRC_ROOT, path.join(SRC_ROOT, '..'));
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
  'covnant-sdk/src/engine/wire.ts': 'SDK WIRE ×2 — Gen 16 stamped settlement credit (1 wired site)',
  'covnant-sdk/src/recovery/recovery.ts': 'DOC — read-port docs mention the table; caller-supplied reader, zero writes (PR #64)',
  'engine/covenant-master-sdk.ts': 'ENGINE ×1 — hash-locked internal ledger upsert',
  'lib/contracts/payouts.ts': 'DOC — display layer, type-only ledger reference',
  'lib/escrow/balance.ts': 'READ — disbursements scan',
  'lib/ledger/cbt-settlement.ts': 'HELPER — stamp derivation docs (Gen 8/9)',
  'lib/ledger/engine-stamp.ts': 'ENGINE — Gen 9 bounded metadata-only enrichment executor',
  'lib/ledger/store.ts': 'SUPABASE_JS ×2 — Gen 9 stamped rememberSettlement upsert (1 wired site)',
  'lib/server/inMemoryStore.ts':
    'READ + FIXTURE — territory-settlement read seam (spec art_qNu4T32F); in-memory tier rows for tests, no SQL, no production writes',
  'lib/server/sqliteStore.ts':
    'READ + LOCAL FIXTURE — territory-settlement read seam (spec art_qNu4T32F); local-dev mirror table with a fixture INSERT — SqliteStore is not shipped, the wire remains the production writer',
  'lib/server/store.ts':
    'READ — territory-settlement seam signature on the Store contract (spec art_qNu4T32F), zero writes',
  'lib/server/supabaseStore.ts':
    'READ — SDK-settled territory projection (select-only, PGRST204 → honest empty), zero writes',
  'lib/server/territorySettlement.ts':
    'READ — pure metadata.sdk territory projection core (spec art_qNu4T32F), zero writes',
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

  it('pins mechanism 4 at exactly 2 raw-SQL INSERT statements (the SDK wire\'s settlement credit)', () => {
    const wire = read('../covnant-sdk/src/engine/wire.ts');
    // One wired site — stamped primary + 42703 no-metadata-column fallback,
    // the increase webhook's exact discipline (Gen 8), one package over.
    expect(countMatches(wire, /INSERT INTO universal_royalty_ledger/g)).toBe(2);
    expect(countMatches(wire, /withCbtSettlementCode\(/g)).toBe(1);
    expect(countMatches(wire, /isMissingMetadataColumnError\(/g)).toBeGreaterThanOrEqual(1);
    // Replay idempotency: the credit keys off the canonical event id, and
    // the UNIQUE-race guard returns the existing credit, never a second one.
    expect(wire).toContain('sdk_settlement:');
    expect(wire).toContain("'23505'");
  });

  it('pins the full inventory at 15 ledger-write call expressions across 8 wired paths', () => {
    const raw =
      countMatches(read('app/api/banking/route.ts'), /INSERT INTO universal_royalty_ledger/g) +
      countMatches(read('app/api/covnant/webhooks/increase/route.ts'), /INSERT INTO universal_royalty_ledger/g) +
      countMatches(read('../covnant-sdk/src/engine/wire.ts'), /INSERT INTO universal_royalty_ledger/g);
    const supabaseJs =
      countMatches(read('app/api/payouts/withdraw/route.ts'), /from\('universal_royalty_ledger'\)\s*\.insert\(/g) +
      countMatches(read('lib/ledger/store.ts'), /from\('universal_royalty_ledger'\)\s*\.upsert\(/g);
    const engine =
      countMatches(read('engine/covenant-master-sdk.ts'), /\.upsert\(ledgerEntries/g);
    expect(raw + supabaseJs + engine).toBe(15);
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
    expect(migrations).toEqual([
      '0001_covenant_init.sql',
      '0002_contracts.sql',
      '0003_creator_profiles.sql',
      '0004_creator_compliance.sql',
      '0005_admin_action_log.sql',
      // Don Engine persistence (spec art_zxsnGP3A): creates the Don tables;
      // still no DDL on universal_royalty_ledger — the referencing pin below holds.
      '0006_don_engine.sql',
      // SDK collection surfaces (spec art_MzwqTXym): SDK tables + creator
      // identifier columns; still no DDL on universal_royalty_ledger.
      '0007_sdk_collection.sql',
      // Sync Library catalog + licensing settlement (spec art_ZIdWlYUX,
      // SyncMarketplaceRegistry amendment): additive catalog columns on
      // cbt_assets + sync_license_purchases; still no DDL on
      // universal_royalty_ledger — the referencing pin below holds.
      '0008_sync_library.sql',
      // DB concurrency guards (audit art_GG1emERn, hardening gen 12): unique
      // ledger sequence + reversal transfer_id, split-run idempotency key,
      // and the apply_vault_delta RPC; still no DDL on
      // universal_royalty_ledger — the referencing pin below holds.
      '0009_concurrency_guards.sql',
      // In-house phone verification (spec art_pd8VlEMI): the
      // phone_verifications table for the signup OTP step; still no DDL on
      // universal_royalty_ledger — the referencing pin below holds.
      '0010_phone_verifications.sql',
      // Deep Royalties recon queue (spec art_7M0snhxc): the
      // royalty_recon_jobs orchestration table + claim RPC + pg_net
      // completion trigger; still no DDL on universal_royalty_ledger —
      // the referencing pin below holds.
      '0011_royalty_recon_jobs.sql',
      // Universal identity registry (canon v10, addendum 29, founder DDL):
      // universal_identity_map + global_identifier_cross_ref — entity-level
      // identifier tables; still no DDL on universal_royalty_ledger —
      // the referencing pin below holds.
      '0012_universal_identity.sql',
      // UCT credential vault (spec PR 5): the distributor_connections table
      // (AES-256-GCM ciphertexts, RLS deny-all, one-active-connection index);
      // still no DDL on universal_royalty_ledger — the referencing pin
      // below holds.
      '0013_distributor_credentials.sql',
      // CVT Astra extraction agent (spec PR 6): broadens the
      // distributor_connections source CHECK to the full 71-source adapter
      // vocabulary; still no DDL on universal_royalty_ledger — the
      // referencing pin below holds.
      '0014_astra_traversal_vocabulary.sql',
      // Spatial & Web3 identifier trigger branches (canon v25): the additive
      // CREATE OR REPLACE on validate_global_identifier — a function-only
      // change; still no DDL on universal_royalty_ledger — the referencing
      // pin below holds.
      '0015_spatial_web3_identifiers.sql',
      // Film waterfall engine (Deep Royalties PR 8): the
      // film_waterfall_definitions registry + film_waterfall_distributions
      // per-receipt records; still no DDL on universal_royalty_ledger —
      // the referencing pin below holds.
      '0016_film_waterfall_engine.sql',
      // Podcast episode splits + guest milestone bonuses (Deep Royalties
      // PR 11): the per-episode split schedule/accrual ledger + the guest
      // bonus definition/accrual ledger; still no DDL on
      // universal_royalty_ledger — the referencing pin below holds.
      '0017_podcast_episode_splits.sql',
      // Gaming engine-royalty accumulator + item splits (Deep Royalties
      // PR 12): the append-only engine-royalty contribution log, the
      // per-item split schedules, and the per-funding-event payout
      // routings; still no DDL on universal_royalty_ledger — the
      // referencing pin below holds.
      '0018_gaming_fee_parser_devex.sql',
      '0019_gaming_cashout_states.sql',
      // VTuber agency holdbacks + tax withholding verification (Deep
      // Royalties PR 15): the tax-withholding verification state and the
      // tech setup amortization schedule/consumption lines; still no DDL
      // on universal_royalty_ledger — the referencing pin below holds.
      '0020_vtuber_agency_holdback_states.sql',
      // Derivative asset royalty cascade (Deep Royalties PR 16): the
      // per-edge royalty contract table (parent_asset_id dependency edges,
      // constrained royalty_bps, self-edge check); still no DDL on
      // universal_royalty_ledger — the referencing pin below holds.
      '0021_derivative_royalty_cascade.sql',
      // Music sample cascade + statutory cover mechanicals (Deep Royalties
      // PR 17): the per-work clearance contract table (parent_composition_id
      // dependency edges, constrained license_bps, self-edge check) and the
      // composition publisher registry for statutory mechanical routing;
      // still no DDL on universal_royalty_ledger — the referencing pin
      // below holds.
      '0022_sample_cascade_cover_mechanicals.sql',
      // Film multi-territory withholding + cross-collateralization firewall
      // (Deep Royalties PR 18): the per-line pre-conversion withholding log
      // and the per-territory routing envelopes; still no DDL on
      // universal_royalty_ledger — the referencing pin below holds.
      '0023_film_territory_withholding_firewall.sql',
      // Webtoon studio splits + per-language translation cascades (Deep
      // Royalties PR 20): the studio split registry, the per-language
      // localization contracts, the translation-cost amortization
      // schedule/consumed lines, and the isolated recoupment
      // pools/applications; still no DDL on universal_royalty_ledger — the
      // referencing pin below holds.
      '0024_webtoon_studio_translation_cascades.sql',
      // IP adaptation optioning — the author-first option-fee cascade (Deep
      // Royalties PR 21): the option agreement of record, the ordered
      // author-side IP allocations (guarded, type-matched FK to the
      // agreement), and the durable publishing ip_rights_cleared
      // verification state; still no DDL on universal_royalty_ledger — the
      // referencing pin below holds.
      '0025_ip_option_agreements_author_cascade.sql',
      // Merch COGS + collaboration waterfall (PR 22, the founder merchandise
      // directive): the FIFO production lots and append-only consumptions,
      // the collaboration agreements and recoupment applications, the
      // designer royalty tiers and billings, and the consignment
      // settlements; still no DDL on universal_royalty_ledger — the
      // referencing pin below holds.
      '0026_merch_cogs_collaboration_waterfall.sql',
      // Merchandise returns reserve + fulfillment confirmation (PR 23, the
      // founder merchandise directive): the per-SKU reserve policy of
      // record, the append-only fulfillment tracking ledger, and the
      // position-locked reserve drawdown ledger; still no DDL on
      // universal_royalty_ledger — the referencing pin below holds.
      '0027_merch_returns_reserve_fulfillment.sql',
      // AI model registry (PR 24, the founder AI directive + the
      // tokenization patch): the per-model nested split terms of record
      // and the contributor dataset-token-weight registry; still no DDL
      // on universal_royalty_ledger — the referencing pin below holds.
      '0028_ai_model_registry.sql',
      // AI training dispute freeze + payout gate states + dataset
      // deprecations (PR 25, the founder AI directive + the tokenization
      // patch): the dispute of record, the payout-gate state tri-states,
      // the deprecation registry, and the allocation archives; still no
      // DDL on universal_royalty_ledger — the referencing pin below
      // holds.
      '0029_ai_dispute_freeze_consent_likeness_gates.sql',
      // Book/magazine recoupment pools + editorial split ledger (PR 26,
      // the founder publishing directive): the sequential advance
      // recoupment pools/applications, the editorial split schedules, and
      // the split accruals; still no DDL on universal_royalty_ledger — the
      // referencing pin below holds.
      '0030_book_recoupment_editorial_splits.sql',
      // Foreign-tax hold + book returns reserve (PR 27, the founder
      // publishing directive): the withholding-tax-credit and ISBN-rights
      // verification states, the founder-banded per-ISBN reserve policy,
      // the position-locked reserve drawdowns, the publisher return
      // chargebacks, and the chargeback offset applications; still no DDL
      // on universal_royalty_ledger — the referencing pin below holds.
      '0031_foreign_tax_hold_book_returns_reserve.sql',
      // Art-market waterfalls (PR 28, the founder art directive): the
      // fabrication recoupment pools/applications, the percentage split
      // schedules/accruals, and the museum licensing agency-fee policies;
      // still no DDL on universal_royalty_ledger — the referencing pin
      // below holds.
      '0032_art_market_waterfalls.sql',
      // Estate succession + multi-heir splitting (PR 29, the founder
      // estate directive): the probate certificates of record, the
      // versioned heir schedules, the append-only receiving-entity
      // transitions, the per-artwork split accruals with provenance
      // hashes, and the estate payout-gate states; still no DDL on
      // universal_royalty_ledger — the referencing pin below holds.
      '0033_estate_succession_multi_heir_splitting.sql',
      // AGBOR box office + theatrical recoupment (PR 30, the founder live
      // theater directive): the versioned production deals of record, the
      // per-stop settlement sheets keyed on the production/venue/show-date
      // triple, the position-locked investor recoupment applications, and
      // the split accruals; still no DDL on universal_royalty_ledger — the
      // referencing pin below holds.
      '0034_agbor_box_office_theatrical_recoupment.sql',
      // Promoter settlement escrow + comedy audio rights (PR 31, the founder
      // tour + live comedy directive): the per-stop night-of-show audit
      // closes of record, the theatrical payout-gate states keyed per
      // (payee, production), and the venue hall-fee policies in the
      // founder-banded 1,500–2,500 bps range; still no DDL on
      // universal_royalty_ledger — the escrow rides the existing ledger
      // kind/status vocabulary, and the referencing pin below holds.
      '0035_promoter_settlement_escrow_theater_gates_comedy_audio.sql',
      '0036_licensing_net_sales_tiered_royalties_sublicense.sql',
      // Advance/MG recoupment + audit reserve + payout gate states (PR 33,
      // migration 0037): the commitment/application/term-close tables, the
      // audit-reserve policy/drawdown/reconciliation tables, and the payout
      // gate states of record; still no DDL on universal_royalty_ledger —
      // the buckets and journals ride the existing ledger vocabulary, and
      // the referencing pin below holds.
      '0037_licensing_mg_recoupment_audit_reserve_gate_states.sql',
      // NIL compliance parser + roster waterfall (PR 34, the founder NIL
      // directive): ten durable NIL record tables — programs, waterfalls,
      // school caps, cap verifications, business-purpose audits, payout and
      // pool applications, group splits, state rules, and payout gate
      // states; still no DDL on universal_royalty_ledger — the applications
      // ride their own NIL tables, and the referencing pin below holds.
      '0038_nil_compliance_parser_roster_waterfall.sql',
      // NIL audit escrow + transfer portal clawback (PR 35, the founder
      // escrow directive): six durable tables — the escrow policies
      // (the founder-banded 5–10% rate), the position-locked escrow
      // drawdowns, the verified reconciliations (the release gate's
      // key), the advance schedules (the pro-ration's terms), the
      // transfer portal entries (the clawback's trigger), and the
      // pro-rated unearned-advance clawbacks with the pro-ration
      // identity pinned in a CHECK; still no DDL on
      // universal_royalty_ledger — the buckets and journals ride the
      // existing ledger vocabulary, and the referencing pin below holds.
      '0039_nil_audit_escrow_transfer_portal_clawback.sql',
      // Spatial POS + occupancy royalties + zone allocation (PR 36, the
      // founder spatial directive): eight durable tables — the occupancy
      // tier schedules (the founder's 5%/8% throughput example), the
      // shared facility overhead policies, the zone assignments to IP
      // owners, the micro-royalty unit rates, the cumulative annual
      // throughput tracker, and the three append-only application
      // ledgers (occupancy royalties, zone allocations, micro-royalties)
      // with the calculator identities pinned in CHECKs; still no DDL on
      // universal_royalty_ledger — the applications ride their own
      // spatial tables, and the referencing pin below holds.
      '0040_spatial_pos_occupancy_royalties_zone_allocation.sql',
      // PR 37 (the founder spatial directive): eleven additive tables for
      // CapEx recoupment, quarterly MSG closes, pop-up decommissioning,
      // spatial audit escrow, and payout gate states; still no DDL on
      // universal_royalty_ledger — the referencing pin below holds.
      '0041_spatial_capex_msg_popup_escrow_gate_states.sql',
      // PR 38 (the founder fitness directive): sixteen additive tables for
      // fitness policies and monthly trackers, co-creation modules, and the
      // seven replay-guarded application ledgers (realization, trainer
      // royalty, live residual, franchise override, co-brand split,
      // algorithm royalty, co-creation waterfall); still no DDL on
      // universal_royalty_ledger — the referencing pin below holds.
      '0042_fitness_telemetry_trainer_royalties_sync_music.sql',
      // PR 39 (the founder fitness directive): six additive tables for the
      // FITNESS_AUDIT_ESCROW bucket (the founder-banded 5–10% rate), the
      // position-locked drawdowns, the verified reconciliations (the
      // release gate's key), the hipaa_gdpr_privacy_cleared +
      // territorial_studio_exclusivity_verified payout gate states, the
      // per-program instant live-event bonus policies, and the bonus
      // applications of record; still no DDL on universal_royalty_ledger —
      // the referencing pin below holds.
      '0043_fitness_audit_escrow_payout_gates_live_bonuses.sql',
    ]);
    const referencing = migrations.filter((file) =>
      readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').includes('universal_royalty_ledger'),
    );
    expect(referencing).toEqual(['0001_covenant_init.sql']);
  });
});
