// The INSTANT hardware OTA feature-unlock micro-settlements (PR 46, the
// founder hardware directive) — the behavioral suite: a purchased unlock
// that activates patented hardware (self-driving sensors, adaptive
// suspension) prices through the founder's split economics and posts THE
// MOMENT the activation feed detects it — the sensor patent licensor's
// share lands in their vault through the taxed cascade, the platform's
// share lands in the platform variance account, and one balanced journal
// rides the posting. The replay guard is the content-derived event id (a
// re-shipped event is a counted no-op, never a second posting); the
// pricing terms come from the OTA unlock policy of record — no policy,
// no settlement, never a guessed rate. Licensor share + platform share
// === the settlement pot, ALWAYS, in exact integer cents.

import { describe, expect, it } from "vitest";

import { InMemoryStore } from "@/lib/server/inMemoryStore";
import type { Store } from "@/lib/server/store";
import { COMPANY_VARIANCE_PAYEE_ID } from "@/modules/don/constants";
import { postInstantOtaUnlockSettlement } from "@/lib/server/hardwareOtaUnlockSettlements";
import { otaUnlockSplit } from "@/workers/recon/hardware";

const T0 = new Date("2026-10-03T12:00:00.000Z");

const BASE_EVENT = {
  source_event_id: "ota-2026-10-03-0001",
  feature_code: "fcs_self_driving_sensors",
  device_imei_mac: "IMEI-356938035643809",
  period: "2026-10",
  currency: "USD",
};

function makeStore(): Store {
  return new InMemoryStore();
}

/** A verified TIN/W-9 profile — the no-backup-withholding state of record. */
async function seedVerifiedTaxProfile(store: Store, payeeId: string): Promise<void> {
  await store.upsertCreatorTaxProfile({
    creator_id: payeeId,
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: T0.toISOString(),
  });
}

async function seedOtaUnlockPolicy(
  store: Store,
  licensorPayeeId = "sensor-licensor-apex",
  microsPerUnlock = 149_000_000,
  licensorShareBps = 7_000,
): Promise<void> {
  await store.upsertHardwareOtaUnlockPolicy({
    feature_code: "fcs_self_driving_sensors",
    sensor_licensor_payee_id: licensorPayeeId,
    micros_per_unlock: microsPerUnlock,
    licensor_share_bps: licensorShareBps,
  });
}

/** The payee's total vault balance across all buckets. */
async function vaultTotal(store: Store, payeeId: string): Promise<number> {
  const vault = await store.getVault(payeeId);
  if (vault === undefined) return 0;
  return vault.available_balance + vault.pending_balance + vault.reserve_balance;
}

function expectFailure(
  result: { ok: false; code: string } | { ok: true },
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    expect.unreachable("expected a failure result");
  }
  expect(result.code).toBe(code);
}

describe("postInstantOtaUnlockSettlement — the per-unlock instant post", () => {
  it("prices through the OTA split and posts immediately: licensor vault + platform share + one balanced journal", async () => {
    const store = makeStore();
    await seedVerifiedTaxProfile(store, "sensor-licensor-apex");
    await seedOtaUnlockPolicy(store);

    const before = await vaultTotal(store, "sensor-licensor-apex");
    const platformBefore = await vaultTotal(store, COMPANY_VARIANCE_PAYEE_ID);

    const settled = await postInstantOtaUnlockSettlement(store, BASE_EVENT, T0);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;

    // The split is the founder's OTA economics exactly: a $1.49 per-unlock
    // pot; the licensor's 70% floors to 104 cents, platform 45.
    expect(settled.value.settlement_cents).toBe(149);
    expect(settled.value.licensor_cents).toBe(104);
    expect(settled.value.platform_cents).toBe(45);
    expect(settled.value.replayed).toBe(false);
    expect(settled.value.journal_id).not.toBeNull();

    // The application row of record carries the split and the policy ref.
    const row = await store.getHardwareOtaUnlockApplication(BASE_EVENT.source_event_id);
    expect(row).toBeDefined();
    expect(row?.licensor_cents).toBe(104);
    expect(row?.platform_cents).toBe(45);
    expect(row?.settlement_cents).toBe(149);
    expect(row?.sensor_licensor_payee_id).toBe("sensor-licensor-apex");
    expect(row?.feature_code).toBe("fcs_self_driving_sensors");
    expect(row?.device_imei_mac).toBe("IMEI-356938035643809");

    // The licensor's share LANDED in their vault (verified TIN, no YTD —
    // no withholding, no recoupment: the full share posts).
    const after = await vaultTotal(store, "sensor-licensor-apex");
    expect(after - before).toBe(104);

    // The platform's share landed in the platform variance account.
    const platformAfter = await vaultTotal(store, COMPANY_VARIANCE_PAYEE_ID);
    expect(platformAfter - platformBefore).toBe(45);

    // THE INVARIANT: licensor + platform === pot, ALWAYS.
    expect(settled.value.licensor_cents + settled.value.platform_cents).toBe(
      settled.value.settlement_cents,
    );
  });

  it("replays a re-shipped unlock event as a counted no-op — no second row, no second posting, no vault movement", async () => {
    const store = makeStore();
    await seedVerifiedTaxProfile(store, "sensor-licensor-apex");
    await seedOtaUnlockPolicy(store);

    const first = await postInstantOtaUnlockSettlement(store, BASE_EVENT, T0);
    expect(first.ok).toBe(true);

    const before = await vaultTotal(store, "sensor-licensor-apex");
    const platformBefore = await vaultTotal(store, COMPANY_VARIANCE_PAYEE_ID);

    const replayed = await postInstantOtaUnlockSettlement(store, BASE_EVENT, T0);
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.replayed).toBe(true);
    expect(replayed.value.journal_id).toBeNull();
    expect(replayed.value.licensor_cents).toBe(104);

    // Nothing moved twice.
    expect((await vaultTotal(store, "sensor-licensor-apex")) - before).toBe(0);
    expect((await vaultTotal(store, COMPANY_VARIANCE_PAYEE_ID)) - platformBefore).toBe(0);
  });

  it("refuses a feature with no policy of record — fail-closed, never a guessed rate", async () => {
    const store = makeStore();
    await seedVerifiedTaxProfile(store, "sensor-licensor-apex");

    expectFailure(
      await postInstantOtaUnlockSettlement(store, BASE_EVENT, T0),
      "ota_unlock_policy_missing",
    );
    // Nothing recorded, nothing posted.
    expect(
      await store.getHardwareOtaUnlockApplication(BASE_EVENT.source_event_id),
    ).toBeUndefined();
  });

  it("records a sub-micro pot truthfully — the row of record exists, no journal, no vault movement", async () => {
    const store = makeStore();
    await seedVerifiedTaxProfile(store, "sensor-licensor-apex");
    // 1 micro per unlock — the pot floors micros/1e6 to 0 payable cents.
    await seedOtaUnlockPolicy(store, "sensor-licensor-apex", 1, 7_000);

    const settled = await postInstantOtaUnlockSettlement(store, BASE_EVENT, T0);
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.settlement_cents).toBe(0);
    expect(settled.value.licensor_cents).toBe(0);
    expect(settled.value.platform_cents).toBe(0);
    expect(settled.value.journal_id).toBeNull();

    const row = await store.getHardwareOtaUnlockApplication(BASE_EVENT.source_event_id);
    expect(row).toBeDefined();
    expect(row?.settlement_cents).toBe(0);
  });

  it("refuses a blank source event or feature identity", async () => {
    const store = makeStore();
    expectFailure(
      await postInstantOtaUnlockSettlement(store, { ...BASE_EVENT, source_event_id: "  " }, T0),
      "invalid_settlement_identity",
    );
    expectFailure(
      await postInstantOtaUnlockSettlement(store, { ...BASE_EVENT, feature_code: "" }, T0),
      "invalid_settlement_identity",
    );
  });
});

describe("otaUnlockSplit — the per-unlock royalty split", () => {
  it("prices the unlock pot exactly — the floor discipline", () => {
    // $2.49 per unlock, licensor 85%: 249 × 8500/10000 = 211.65 → 211;
    // platform 38. The split conserves: 211 + 38 === 249.
    const split = otaUnlockSplit({ microsPerUnlock: 249_000_000, licensorShareBps: 8_500 });
    expect(split.settlementCents).toBe(249);
    expect(split.licensorCents).toBe(211);
    expect(split.platformCents).toBe(38);
    expect(split.licensorCents + split.platformCents).toBe(split.settlementCents);
  });
});
