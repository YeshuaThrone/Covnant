/**
 * Three-backend parity for the hardware lane (PR 46, the founder
 * hardware directive) — the worker end-to-end over InMemoryStore,
 * SqliteStore, and SupabaseStore (behavioral fake).
 *
 * The scenario: all four sender sheets ingested → pinned strict profile
 * dispatch → the seven hardware walks (realizations, tiered FRAND SEP
 * royalties with the cumulative tracker, automotive OEM pool routings,
 * essentiality-weighted waterfalls, clean-tech telemetry micro-payouts,
 * cross-license nettings, OTA unlock instant settlements) → the OTA
 * instant posting's vault movement; then the same four sheets re-shipped
 * (the counted no-op replay). Every backend must produce the identical
 * result counters, the identical application rows of record, and the
 * identical vault money.
 */
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";
import { COMPANY_VARIANCE_PAYEE_ID } from "@/modules/don/constants";
import type { ReconJobResult } from "@/modules/recon/records";
import { hardwareRowEventId } from "../hardware";
import { runOnce } from "../worker";
import { loadFixture } from "./fixtures";
import { makeFakeSupabaseStore } from "./fakeSupabase";
import { HARDWARE_FIXTURES, registerHardwarePolicies } from "./hardwareScenario";

const NOW = () => new Date("2026-10-03T12:00:00Z");

const BACKENDS = [
  { name: "InMemoryStore", make: () => new InMemoryStore() },
  { name: "SqliteStore", make: () => new SqliteStore(":memory:") },
  {
    name: "SupabaseStore",
    make: () => makeFakeSupabaseStore(),
  },
] as const;

/** The hardware lane does no vault matching — a null lookup is the vault. */
function nullVault() {
  return { findByIdentifier: async () => null };
}

/**
 * Ingests each of the four sender sheets, enqueues its recon job, and
 * runs the worker once per job — the real ingest → job → parse → walk
 * path. Returns the four jobs' result objects.
 */
async function runHardwarePass(
  store: Store,
): Promise<Array<ReconJobResult | null | undefined>> {
  const results: Array<ReconJobResult | null | undefined> = [];
  for (const fixture of HARDWARE_FIXTURES) {
    const ingest = await store.insertStatementIngest({
      format: "csv_statement",
      source: "statement",
      file_name: fixture,
      content: loadFixture(fixture),
      status: "parsed",
      event_count: null,
      error: null,
      created_at: NOW().toISOString(),
    });
    await store.createReconJob({ source: "statement", ingest_id: ingest.id });
    const processed = await runOnce({ store, vault: nullVault(), now: NOW });
    results.push(processed?.job.result);
  }
  return results;
}

/** The hardware_* counters, summed across a pass's four job results. */
function hardwareCounters(
  results: Array<ReconJobResult | null | undefined>,
): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const result of results) {
    if (!result) continue;
    for (const [key, value] of Object.entries(result)) {
      if (key.startsWith("hardware_") && typeof value === "number") {
        sums[key] = (sums[key] ?? 0) + value;
      }
    }
  }
  return sums;
}

/** The payee's total vault balance across all buckets. */
async function vaultTotal(store: Store, payeeId: string): Promise<number> {
  const vault = await store.getVault(payeeId);
  if (vault === undefined) return 0;
  return vault.available_balance + vault.pending_balance + vault.reserve_balance;
}

interface ProjectionRow {
  asp: number;
  cogs: number;
  bom: number;
  net: number;
  verdict: string;
  imei: string;
  eid: string | null;
  family: string;
  pool: string;
}

/**
 * The lane's rows of record, projected id-free (UUIDs and timestamps
 * legitimately differ per backend; content-derived event ids, money,
 * and verdicts may not). The order follows the fixtures' row order —
 * deterministic on every backend.
 */
async function hardwareProjection(store: Store) {
  const realizations: Array<ProjectionRow | null> = [];
  for (const senderRowId of ["CVA-2026-03-0001", "CVA-2026-03-0002", "CVA-2026-03-0003"]) {
    const row = await store.getHardwareRealizationApplication(
      hardwareRowEventId("realization", {
        sender: "cellular_activation",
        period: "2026-03",
        senderRowId,
      }),
    );
    realizations.push(
      row
        ? {
            asp: row.device_wholesale_asp_cents,
            cogs: row.component_cogs_base_cents,
            bom: row.non_essential_bom_cents,
            net: row.net_patentable_device_value_base_cents,
            verdict: row.verdict,
            imei: row.device_imei_mac,
            eid: row.eid,
            family: row.patent_family_id,
            pool: row.sep_pool_code,
          }
        : null,
    );
  }

  const sep: Array<{
    royalty: number;
    cumulativeBefore: number;
    cumulativeAfter: number;
    tierLegs: unknown;
  }> = [];
  for (const senderRowId of ["MAC-2026-03-0001", "MAC-2026-03-0002", "MAC-2026-03-0003"]) {
    const row = await store.getHardwareSepRoyaltyApplication(
      hardwareRowEventId("sep_royalty", {
        sender: "mac_address_log",
        period: "2026-03",
        senderRowId,
      }),
    );
    if (row) {
      sep.push({
        royalty: row.royalty_cents,
        cumulativeBefore: row.cumulative_units_before,
        cumulativeAfter: row.cumulative_units_after,
        tierLegs: JSON.parse(row.tier_legs),
      });
    }
  }

  const routings: Array<{
    serials: number;
    cellular: number;
    navigation: number;
    total: number;
    cellularPool: string;
    navigationPool: string;
  }> = [];
  const waterfalls: Array<{
    pot: number;
    allocated: number;
    legs: unknown;
  }> = [];
  for (const senderRowId of ["BAT-2026-03-0001", "BAT-2026-03-0002", "BAT-2026-03-0003"]) {
    const row = await store.getHardwarePoolRoutingApplication(
      hardwareRowEventId("pool_routing", {
        sender: "production_serial",
        period: "2026-03",
        senderRowId,
      }),
    );
    if (row) {
      routings.push({
        serials: row.serials_produced,
        cellular: row.cellular_routed_cents,
        navigation: row.navigation_routed_cents,
        total: row.total_routed_cents,
        cellularPool: row.cellular_pool_code,
        navigationPool: row.navigation_pool_code,
      });
      for (const poolCode of ["POOL-5G-VEHICLE", "POOL-NAV-AVANCI"]) {
        const waterfall = await store.getHardwarePoolWaterfallApplication(
          row.source_event_id,
          poolCode,
        );
        if (waterfall) {
          waterfalls.push({
            pot: waterfall.pool_fee_pot_cents,
            allocated: waterfall.allocated_total_cents,
            legs: JSON.parse(waterfall.split_legs),
          });
        }
      }
    }
  }

  const telemetry: Array<{ kwhMicros: number; royaltyMicros: number; royaltyCents: number }> = [];
  for (const senderRowId of ["TLM-2026-03-0001", "TLM-2026-03-0002"]) {
    const row = await store.getHardwareTelemetryRoyaltyApplication(
      hardwareRowEventId("telemetry", {
        sender: "smart_grid_telemetry",
        period: "2026-03",
        senderRowId,
      }),
    );
    if (row) {
      telemetry.push({
        kwhMicros: row.kwh_micros,
        royaltyMicros: row.royalty_micros,
        royaltyCents: row.royalty_cents,
      });
    }
  }

  const net = await store.getHardwareCrossLicenseNetSettlement("XLA-5G-WIFI7-2026", "2026-03");

  const otaRows: Array<{
    feature: string;
    imei: string;
    settlement: number;
    licensor: number;
    platform: number;
  }> = [];
  const ota = await store.getHardwareOtaUnlockApplication(
    hardwareRowEventId("ota_unlock", {
      sender: "cellular_activation",
      period: "2026-03",
      senderRowId: "OTA-2026-03-0001",
    }),
  );
  if (ota) {
    otaRows.push({
      feature: ota.feature_code,
      imei: ota.device_imei_mac,
      settlement: ota.settlement_cents,
      licensor: ota.licensor_cents,
      platform: ota.platform_cents,
    });
  }

  return {
    realizations,
    sep,
    routings,
    waterfalls,
    telemetry,
    net: net
      ? {
          owedAToB: net.owed_a_to_b_cents,
          owedBToA: net.owed_b_to_a_cents,
          netCents: net.net_cents,
          direction: net.direction,
        }
      : null,
    ota: otaRows,
    licensorVault: await vaultTotal(store, "sensor-licensor-apex"),
    platformVault: await vaultTotal(store, COMPANY_VARIANCE_PAYEE_ID),
  };
}

describe("the hardware lane's three-backend parity", () => {
  it("produces identical counters, rows, and vault money across InMemory, SQLite, and the Supabase fake", async () => {
    const outcomes = [];
    for (const backend of BACKENDS) {
      const store = backend.make();
      await registerHardwarePolicies(store);

      // First pass: the four sheets settle everything they can price.
      const first = hardwareCounters(await runHardwarePass(store));
      const projection = await hardwareProjection(store);

      // Replay: the same sheets re-shipped — counted no-ops, no money.
      const replay = hardwareCounters(await runHardwarePass(store));

      outcomes.push({ first, projection, replay });
    }

    // Every backend agrees with every other — counters, rows, and money.
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toEqual(outcomes[2]);

    // And the shared outcome is the founder's math, end to end through
    // the real worker: the realizations (two paid + one held), the tier
    // walks, the routings and their waterfalls, the telemetry payouts,
    // the netted cross-license settlement, and the OTA instant post.
    const { first, projection, replay } = outcomes[0];
    expect(first.hardware_realizations_committed).toBe(3);
    expect(first.hardware_realization_held_non_positive_net).toBe(1);
    expect(first.hardware_sep_royalties_committed).toBe(3);
    expect(first.hardware_oem_routings_committed).toBe(3);
    expect(first.hardware_pool_waterfalls_committed).toBe(3);
    expect(first.hardware_telemetry_royalties_committed).toBe(2);
    expect(first.hardware_cross_license_nettings_committed).toBe(3);
    expect(first.hardware_ota_unlock_settlements_committed).toBe(1);
    expect(first.hardware_ota_unlock_instant_postings).toBe(1);
    expect(first.hardware_net_patentable_value_base_cents).toBe(97_500);
    expect(first.hardware_sep_royalty_cents).toBe(348_000);
    expect(first.hardware_oem_routed_cents).toBe(507_110);
    expect(first.hardware_pool_distributed_cents).toBe(495_110);
    expect(first.hardware_telemetry_royalty_cents).toBe(108);
    expect(first.hardware_cross_license_net_dispatch_cents).toBe(867_000);
    expect(first.hardware_ota_licensor_cents).toBe(104);
    expect(first.hardware_ota_platform_cents).toBe(45);

    // The replay pass: every walk counted its rows as no-ops and no
    // money moved anywhere.
    expect(replay.hardware_realizations_replayed).toBe(3);
    expect(replay.hardware_sep_royalties_replayed).toBe(3);
    expect(replay.hardware_oem_routings_replayed).toBe(3);
    expect(replay.hardware_telemetry_royalties_replayed).toBe(2);
    expect(replay.hardware_ota_unlock_settlements_replayed).toBe(1);
    expect(replay.hardware_realizations_committed ?? 0).toBe(0);
    expect(replay.hardware_sep_royalties_committed ?? 0).toBe(0);
    expect(replay.hardware_oem_routings_committed ?? 0).toBe(0);
    expect(replay.hardware_pool_waterfalls_committed ?? 0).toBe(0);
    expect(replay.hardware_telemetry_royalties_committed ?? 0).toBe(0);
    expect(replay.hardware_cross_license_nettings_committed ?? 0).toBe(0);
    expect(replay.hardware_ota_unlock_settlements_committed ?? 0).toBe(0);
    expect(replay.hardware_net_patentable_value_base_cents ?? 0).toBe(0);
    expect(replay.hardware_sep_royalty_cents ?? 0).toBe(0);
    expect(replay.hardware_oem_routed_cents ?? 0).toBe(0);
    expect(replay.hardware_ota_licensor_cents ?? 0).toBe(0);
    expect(replay.hardware_ota_platform_cents ?? 0).toBe(0);

    // The rows of record: the realization identity pins per row, the
    // tier legs carry the founder's $3.00 ceiling, the waterfalls
    // conserve, and the netted settlement is the 342000-cent dispatch.
    expect(projection.realizations).toHaveLength(3);
    expect(projection.realizations.every((row) => row !== null)).toBe(true);
    if (projection.realizations[0]) {
      expect(
        projection.realizations[0].cogs +
          projection.realizations[0].bom +
          projection.realizations[0].net,
      ).toBe(projection.realizations[0].asp);
    }
    expect(projection.sep[0]?.royalty).toBe(180_000);
    expect(projection.sep[0]?.cumulativeAfter).toBe(600);
    expect(projection.sep[1]?.royalty).toBe(165_000);
    expect(projection.sep[1]?.cumulativeAfter).toBe(1300);
    expect(projection.routings[0]?.total).toBe(445_110);
    expect(projection.waterfalls).toHaveLength(3); // hamburg: both pools, rotation: cellular only (zero nav fee), orphan: no routing row
    for (const waterfall of projection.waterfalls) {
      expect(waterfall.allocated).toBe(waterfall.pot);
    }
    expect(projection.telemetry.map((row) => row.royaltyCents)).toEqual([90, 18]);
    expect(projection.net).toEqual({
      owedAToB: 345_000,
      owedBToA: 3_000,
      netCents: 342_000,
      direction: "a_to_b",
    });
    expect(projection.ota).toEqual([
      {
        feature: "fcs_self_driving_sensors",
        imei: "IMEI-356938035643809",
        settlement: 149,
        licensor: 104,
        platform: 45,
      },
    ]);

    // The instant posting's vault money is identical everywhere.
    expect(projection.licensorVault).toBe(104);
    expect(projection.platformVault).toBe(45);
  });
});
