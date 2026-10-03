// Instant hardware OTA feature-unlock micro-settlements (PR 46, the
// founder hardware directive).
//
// When a vehicle owner purchases an OTA software update that activates
// hardware functionality — unlocking self-driving sensors, adaptive
// suspension, or any other patented capability — the sensor patent
// licensor earns their per-unlock royalty THAT MOMENT — not at the next
// recon pass's batch walk. This lane prices one detected unlock event
// through the founder's split economics (otaUnlockSplit: the policy's
// micros-per-unlock pot, the licensor's bps share), records the
// application row of record (the content-derived event id is the replay
// guard — a re-shipped event is a counted no-op, never a second
// posting), and posts the money IMMEDIATELY: the settlement pot debits
// FBO cash, the licensor's share lands in their vault through the same
// fail-closed taxed cascade every payout rides (withholding off the
// top, the recoupment sweep), and the platform's share lands in the
// platform variance account.
//
// The pricing terms come from the hardware OTA unlock policy of record —
// never the event payload. A feature with no policy of record is NOT
// paid (a counted fail-closed skip, the walk's existing discipline).
// THE INVARIANT: licensor share + platform share === the settlement pot,
// ALWAYS, in exact integer cents (the pot floors micros/1e6 — the
// sub-cent remainder stays in micros-space, the 0048 CHECK discipline).

import type { Store } from "@/lib/server/store";
import { COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME } from "@/modules/don/constants";
import type { HardwareOtaUnlockApplicationRecord } from "@/modules/hardware/records";
import { otaUnlockSplit } from "@/workers/recon/hardware";
import { postJournal } from "@/modules/ledger/engine";
import { fboDebit, vaultCredit, type GlLegInput } from "@/modules/ledger/journal";
import { creditVault } from "@/modules/vaults/engine";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep } from "@/modules/recoupment/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import { isWithholdableTalentRole } from "@/lib/server/vtuberAgency";

/** House failure envelope — the audit-escrow lane shape. */
export type InstantOtaUnlockSettlementFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type InstantOtaUnlockSettlementInput = {
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  /** The unlocked feature (the policy registry's key of record). */
  feature_code: string;
  /** The activated device's identity of record (provenance). */
  device_imei_mac: string;
  /** The usage period of record (YYYY-MM). */
  period: string;
  currency: string;
};

export type InstantOtaUnlockSettlementSuccess = {
  ok: true;
  value: {
    /** The application row of record (existing on a replay). */
    application: HardwareOtaUnlockApplicationRecord;
    /** True = a re-shipped event's counted no-op (no money moved). */
    replayed: boolean;
    /** The journal of the instant posting (null on a replay). */
    journal_id: string | null;
    /** The priced split — the pot, the licensor's share, the platform's. */
    settlement_cents: number;
    licensor_cents: number;
    platform_cents: number;
  };
};

/**
 * Posts ONE instant OTA feature-unlock micro-settlement — the
 * activation feed's per-event posting path. Replay-guarded by the
 * content-derived event id (the application row of record): a
 * re-shipped event returns the existing row's counted no-op.
 * Fail-closed on the pricing terms: no policy of record, no
 * settlement. The money posts the moment the row commits.
 */
export async function postInstantOtaUnlockSettlement(
  store: Store,
  input: InstantOtaUnlockSettlementInput,
  now: Date = new Date(),
): Promise<InstantOtaUnlockSettlementSuccess | InstantOtaUnlockSettlementFailure> {
  if (input.source_event_id.trim() === "" || input.feature_code.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_settlement_identity",
      message: "An instant OTA unlock settlement names its source event and feature of record.",
    };
  }

  // The replay guard — the content-derived event id. An existing
  // application row IS the settlement of record: counted no-op, no
  // second pricing, no second posting.
  const existing = await store.getHardwareOtaUnlockApplication(input.source_event_id);
  if (existing !== undefined) {
    return {
      ok: true,
      value: {
        application: existing,
        replayed: true,
        journal_id: null,
        settlement_cents: existing.settlement_cents,
        licensor_cents: existing.licensor_cents,
        platform_cents: existing.platform_cents,
      },
    };
  }

  // The pricing terms of record — the policy registry, never the event
  // payload. Fail-closed: a purchased unlock with no policy of record
  // is not priced, not paid, not guessed.
  const policy = await store.getHardwareOtaUnlockPolicy(input.feature_code);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "ota_unlock_policy_missing",
      message: `No OTA unlock royalty policy of record exists for feature "${input.feature_code}" — register the sensor licensor's terms before the feature sells.`,
    };
  }

  // The split — the founder's economics, exact integer cents.
  const split = otaUnlockSplit({
    microsPerUnlock: policy.micros_per_unlock,
    licensorShareBps: policy.licensor_share_bps,
  });
  if (split.settlementCents <= 0) {
    // A sub-micro pot floors to zero payable cents — record the event
    // truthfully (the row IS the record; the walk counts it) and post
    // nothing: a zero-cent ledger row would be noise.
    const application = await store.insertHardwareOtaUnlockApplication({
      source_event_id: input.source_event_id,
      feature_code: input.feature_code,
      policy_ref: policy.id,
      sensor_licensor_payee_id: policy.sensor_licensor_payee_id,
      device_imei_mac: input.device_imei_mac,
      period: input.period,
      currency: input.currency,
      micros_per_unlock: policy.micros_per_unlock,
      licensor_share_bps: policy.licensor_share_bps,
      settlement_micros: Number(split.settlementMicros),
      settlement_cents: split.settlementCents,
      licensor_cents: split.licensorCents,
      platform_cents: split.platformCents,
    });
    return {
      ok: true,
      value: {
        application,
        replayed: false,
        journal_id: null,
        settlement_cents: split.settlementCents,
        licensor_cents: split.licensorCents,
        platform_cents: split.platformCents,
      },
    };
  }

  // The application row commits FIRST — the replay truth lands before
  // any money moves (the walk's discipline, retained: the row of record
  // exists even if the posting is interrupted; the reconciliation of
  // applications against journals surfaces any gap).
  const application = await store.insertHardwareOtaUnlockApplication({
    source_event_id: input.source_event_id,
    feature_code: input.feature_code,
    policy_ref: policy.id,
    sensor_licensor_payee_id: policy.sensor_licensor_payee_id,
    device_imei_mac: input.device_imei_mac,
    period: input.period,
    currency: input.currency,
    micros_per_unlock: policy.micros_per_unlock,
    licensor_share_bps: policy.licensor_share_bps,
    settlement_micros: Number(split.settlementMicros),
    settlement_cents: split.settlementCents,
    licensor_cents: split.licensorCents,
    platform_cents: split.platformCents,
  });

  // The instant posting: FBO cash debits the pot; the sensor patent
  // licensor's share rides the taxed cascade (withholding off the top,
  // the recoupment sweep — their legs append to glLegs); the platform's
  // share lands in the platform variance account. The cascade credits
  // the licensor's GROSS (withheld and recouped portions move within
  // the house accounts, not out of the split), so licensor legs +
  // platform leg === pot, ALWAYS.
  const glLegs: GlLegInput[] = [fboDebit(split.settlementCents)];
  if (isWithholdableTalentRole("creator")) {
    const taxed = await applyWithholding(store, {
      creator_id: policy.sensor_licensor_payee_id,
      gross_cents: split.licensorCents,
      tax_year: now.getUTCFullYear(),
    });
    if (taxed.value.withheld_cents > 0) {
      await creditVault(
        store,
        policy.sensor_licensor_payee_id,
        `Hardware licensor ${policy.sensor_licensor_payee_id}`,
        taxed.value.withheld_cents,
        "reserve",
        now,
      );
      glLegs.push(
        vaultCredit(policy.sensor_licensor_payee_id, "reserve", taxed.value.withheld_cents),
      );
    }
    const incomingFrozen = await isIncomingFrozen(store, policy.sensor_licensor_payee_id, "");
    const recouped = await applyRecoupmentSweep(
      store,
      policy.sensor_licensor_payee_id,
      `Hardware licensor ${policy.sensor_licensor_payee_id}`,
      taxed.value.net_cents,
      now,
      { excess_target: incomingFrozen ? "reserve" : "available" },
    );
    if (recouped.applied) {
      if (recouped.recouped_cents > 0) {
        glLegs.push(
          vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "available", recouped.recouped_cents),
        );
      }
      if (recouped.excess_cents > 0) {
        await creditVault(
          store,
          policy.sensor_licensor_payee_id,
          `Hardware licensor ${policy.sensor_licensor_payee_id}`,
          recouped.excess_cents,
          incomingFrozen ? "reserve" : "available",
          now,
        );
        glLegs.push(
          vaultCredit(
            policy.sensor_licensor_payee_id,
            incomingFrozen ? "reserve" : "available",
            recouped.excess_cents,
          ),
        );
      }
    } else {
      await creditVault(
        store,
        policy.sensor_licensor_payee_id,
        `Hardware licensor ${policy.sensor_licensor_payee_id}`,
        taxed.value.net_cents,
        incomingFrozen ? "reserve" : "pending",
        now,
      );
      glLegs.push(
        vaultCredit(
          policy.sensor_licensor_payee_id,
          incomingFrozen ? "reserve" : "pending",
          taxed.value.net_cents,
        ),
      );
    }
  } else {
    const incomingFrozen = await isIncomingFrozen(store, policy.sensor_licensor_payee_id, "");
    const recouped = await applyRecoupmentSweep(
      store,
      policy.sensor_licensor_payee_id,
      `Hardware licensor ${policy.sensor_licensor_payee_id}`,
      split.licensorCents,
      now,
      { excess_target: incomingFrozen ? "reserve" : "available" },
    );
    if (recouped.applied) {
      if (recouped.recouped_cents > 0) {
        glLegs.push(
          vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "available", recouped.recouped_cents),
        );
      }
      if (recouped.excess_cents > 0) {
        await creditVault(
          store,
          policy.sensor_licensor_payee_id,
          `Hardware licensor ${policy.sensor_licensor_payee_id}`,
          recouped.excess_cents,
          incomingFrozen ? "reserve" : "available",
          now,
        );
        glLegs.push(
          vaultCredit(
            policy.sensor_licensor_payee_id,
            incomingFrozen ? "reserve" : "available",
            recouped.excess_cents,
          ),
        );
      }
    } else {
      await creditVault(
        store,
        policy.sensor_licensor_payee_id,
        `Hardware licensor ${policy.sensor_licensor_payee_id}`,
        split.licensorCents,
        incomingFrozen ? "reserve" : "pending",
        now,
      );
      glLegs.push(
        vaultCredit(
          policy.sensor_licensor_payee_id,
          incomingFrozen ? "reserve" : "pending",
          split.licensorCents,
        ),
      );
    }
  }
  if (split.platformCents > 0) {
    await creditVault(
      store,
      COMPANY_VARIANCE_PAYEE_ID,
      COMPANY_VARIANCE_PAYEE_NAME,
      split.platformCents,
      "available",
      now,
    );
    glLegs.push(vaultCredit(COMPANY_VARIANCE_PAYEE_ID, "available", split.platformCents));
  }

  // The zero-balance tripwire: licensor share + platform share === the
  // pot, ALWAYS — structurally true under the subtraction model,
  // asserted defensively (the Don invariant in integer cents).
  if (split.licensorCents + split.platformCents !== split.settlementCents) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Licensor share + platform share !== settlement pot — instant posting refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "hardware_ota_unlock_settlement_post",
    ref_type: "ledger_transaction",
    ref_id: application.id,
    legs: glLegs,
  });
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }

  return {
    ok: true,
    value: {
      application,
      replayed: false,
      journal_id: posted.journal.id,
      settlement_cents: split.settlementCents,
      licensor_cents: split.licensorCents,
      platform_cents: split.platformCents,
    },
  };
}
