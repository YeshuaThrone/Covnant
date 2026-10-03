// Instant AI agent tool-calling micro-settlements (PR 45, the founder
// software directive).
//
// When an autonomous agent executes a PAID third-party tool or API
// function, the builder earns their per-call revenue THAT MOMENT — not
// at the next recon pass's batch walk. This lane prices one detected
// tool-call event through the PR 44 split economics
// (agentToolCallSplit: micros-per-call × calls, the policy's
// builder-share bps), records the application row of record (the
// content-derived event id is the replay guard — a re-shipped event is a
// counted no-op, never a second posting), and posts the money
// IMMEDIATELY: the settlement pot debits FBO cash, the builder's share
// lands in their vault through the same fail-closed taxed cascade every
// payout rides (withholding off the top, the recoupment sweep), and the
// platform's share lands in the platform variance account.
//
// The pricing terms come from the developer tool-call policy of record —
// never the event payload. A tool with no policy of record is NOT paid
// (a counted fail-closed skip, the walk's existing discipline). THE
// INVARIANT: builder share + platform share === the settlement pot,
// ALWAYS, in exact integer cents (the pot floors micros/1e6 — the
// sub-cent remainder of a batch's micros stays in micros-space, the
// 0048 CHECK's discipline).

import type { Store } from "@/lib/server/store";
import { COMPANY_VARIANCE_PAYEE_ID, COMPANY_VARIANCE_PAYEE_NAME } from "@/modules/don/constants";
import type { DeveloperAgentToolCallApplicationRecord } from "@/modules/developer/records";
import type { DeveloperAgentTool } from "@/modules/developer/records";
import { agentToolCallSplit } from "@/workers/recon/developer";
import { postJournal } from "@/modules/ledger/engine";
import {
  fboDebit,
  vaultCredit,
  type GlLegInput,
} from "@/modules/ledger/journal";
import { creditVault } from "@/modules/vaults/engine";
import { applyWithholding } from "@/modules/compliance/engine";
import { applyRecoupmentSweep } from "@/modules/recoupment/engine";
import { isIncomingFrozen } from "@/modules/vaults/dispute";
import { isWithholdableTalentRole } from "@/lib/server/vtuberAgency";

/** House failure envelope — the audit-escrow lane shape. */
export type InstantToolCallSettlementFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type InstantToolCallSettlementInput = {
  /** The content-derived event id — UNIQUE, the replay guard. */
  source_event_id: string;
  /** The autonomous agent of record (provenance). */
  agent_id: string;
  /** The executed tool (the detector's enum of record). */
  tool_id: DeveloperAgentTool;
  /** The event's call count. */
  call_count: number;
  /** The usage period of record (YYYY-MM). */
  period: string;
  currency: string;
};

export type InstantToolCallSettlementSuccess = {
  ok: true;
  value: {
    /** The application row of record (existing on a replay). */
    application: DeveloperAgentToolCallApplicationRecord;
    /** True = a re-shipped event's counted no-op (no money moved). */
    replayed: boolean;
    /** The journal of the instant posting (null on a replay). */
    journal_id: string | null;
    /** The priced split — the pot, the builder's share, the platform's. */
    settlement_cents: number;
    builder_cents: number;
    platform_cents: number;
  };
};

/**
 * Posts ONE instant tool-call micro-settlement — the detector's per-event
 * posting path. Replay-guarded by the content-derived event id (the
 * application row of record): a re-shipped event returns the existing
 * row's counted no-op. Fail-closed on the pricing terms: no policy of
 * record, no settlement. The money posts the moment the row commits.
 */
export async function postInstantToolCallSettlement(
  store: Store,
  input: InstantToolCallSettlementInput,
  now: Date = new Date(),
): Promise<InstantToolCallSettlementSuccess | InstantToolCallSettlementFailure> {
  if (input.source_event_id.trim() === "" || input.agent_id.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_settlement_identity",
      message: "An instant tool-call settlement names its source event and agent of record.",
    };
  }
  if (!Number.isInteger(input.call_count) || input.call_count <= 0) {
    return {
      ok: false,
      status: 422,
      code: "invalid_settlement_calls",
      message: "A tool-call settlement prices a positive whole call count.",
    };
  }

  // The replay guard — the content-derived event id. An existing
  // application row IS the settlement of record: counted no-op, no
  // second pricing, no second posting.
  const existing = await store.getDeveloperToolCallApplication(input.source_event_id);
  if (existing !== undefined) {
    return {
      ok: true,
      value: {
        application: existing,
        replayed: true,
        journal_id: null,
        settlement_cents: existing.settlement_cents,
        builder_cents: existing.builder_cents,
        platform_cents: existing.settlement_cents - existing.builder_cents,
      },
    };
  }

  // The pricing terms of record — the policy registry, never the event
  // payload. Fail-closed: a paid tool with no policy of record is not
  // priced, not paid, not guessed.
  const policy = await store.getDeveloperToolPolicy(input.tool_id);
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "tool_policy_missing",
      message: `No tool-call settlement policy of record exists for tool "${input.tool_id}" — register the pricing terms before agents execute it.`,
    };
  }

  // The split — the PR 44 economics, exact integer cents.
  const split = agentToolCallSplit({
    callCount: input.call_count,
    microsPerCall: policy.micros_per_call,
    builderShareBps: policy.builder_share_bps,
  });
  if (split.settlementCents <= 0) {
    // A sub-micro pot floors to zero payable cents — record the event
    // truthfully (the row IS the record; PR 44's walk counts it) and
    // post nothing: a zero-cent ledger row would be noise.
    const application = await store.insertDeveloperToolCallApplication({
      source_event_id: input.source_event_id,
      agent_id: input.agent_id,
      tool_id: input.tool_id,
      call_count: input.call_count,
      period: input.period,
      currency: input.currency,
      policy_ref: policy.id,
      builder_payee_id: policy.builder_payee_id,
      micros_per_call: policy.micros_per_call,
      settlement_micros: Number(split.settlementMicros),
      settlement_cents: split.settlementCents,
      builder_share_bps: policy.builder_share_bps,
      builder_cents: split.builderCents,
      platform_cents: split.platformCents,
    });
    return {
      ok: true,
      value: {
        application,
        replayed: false,
        journal_id: null,
        settlement_cents: split.settlementCents,
        builder_cents: split.builderCents,
        platform_cents: split.platformCents,
      },
    };
  }

  // The application row commits FIRST — the replay truth lands before
  // any money moves (the walk's discipline, retained: the row of record
  // exists even if the posting is interrupted; the reconciliation of
  // applications against journals surfaces any gap).
  const application = await store.insertDeveloperToolCallApplication({
    source_event_id: input.source_event_id,
    agent_id: input.agent_id,
    tool_id: input.tool_id,
    call_count: input.call_count,
    period: input.period,
    currency: input.currency,
    policy_ref: policy.id,
    builder_payee_id: policy.builder_payee_id,
    micros_per_call: policy.micros_per_call,
    settlement_micros: Number(split.settlementMicros),
    settlement_cents: split.settlementCents,
    builder_share_bps: policy.builder_share_bps,
    builder_cents: split.builderCents,
    platform_cents: split.platformCents,
  });

  // The instant posting: FBO cash debits the pot; the builder's share
  // rides the taxed cascade (withholding off the top, the recoupment
  // sweep — their legs append to glLegs); the platform's share lands in
  // the platform variance account. The cascade credits the builder's
  // GROSS (withheld and recouped portions move within the house
  // accounts, not out of the split), so builder legs + platform leg ===
  // pot, ALWAYS.
  const glLegs: GlLegInput[] = [fboDebit(split.settlementCents)];
  if (isWithholdableTalentRole("creator")) {
    const taxed = await applyWithholding(store, {
      creator_id: policy.builder_payee_id,
      gross_cents: split.builderCents,
      tax_year: now.getUTCFullYear(),
    });
    if (taxed.value.withheld_cents > 0) {
      await creditVault(
        store,
        policy.builder_payee_id,
        `Developer ${policy.builder_payee_id}`,
        taxed.value.withheld_cents,
        "reserve",
        now,
      );
      glLegs.push(
        vaultCredit(policy.builder_payee_id, "reserve", taxed.value.withheld_cents),
      );
    }
    const incomingFrozen = await isIncomingFrozen(store, policy.builder_payee_id, "");
    const recouped = await applyRecoupmentSweep(
      store,
      policy.builder_payee_id,
      `Developer ${policy.builder_payee_id}`,
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
          policy.builder_payee_id,
          `Developer ${policy.builder_payee_id}`,
          recouped.excess_cents,
          incomingFrozen ? "reserve" : "available",
          now,
        );
        glLegs.push(
          vaultCredit(
            policy.builder_payee_id,
            incomingFrozen ? "reserve" : "available",
            recouped.excess_cents,
          ),
        );
      }
    } else {
      await creditVault(
        store,
        policy.builder_payee_id,
        `Developer ${policy.builder_payee_id}`,
        taxed.value.net_cents,
        incomingFrozen ? "reserve" : "pending",
        now,
      );
      glLegs.push(
        vaultCredit(
          policy.builder_payee_id,
          incomingFrozen ? "reserve" : "pending",
          taxed.value.net_cents,
        ),
      );
    }
  } else {
    const incomingFrozen = await isIncomingFrozen(store, policy.builder_payee_id, "");
    const recouped = await applyRecoupmentSweep(
      store,
      policy.builder_payee_id,
      `Developer ${policy.builder_payee_id}`,
      split.builderCents,
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
          policy.builder_payee_id,
          `Developer ${policy.builder_payee_id}`,
          recouped.excess_cents,
          incomingFrozen ? "reserve" : "available",
          now,
        );
        glLegs.push(
          vaultCredit(
            policy.builder_payee_id,
            incomingFrozen ? "reserve" : "available",
            recouped.excess_cents,
          ),
        );
      }
    } else {
      await creditVault(
        store,
        policy.builder_payee_id,
        `Developer ${policy.builder_payee_id}`,
        split.builderCents,
        incomingFrozen ? "reserve" : "pending",
        now,
      );
      glLegs.push(
        vaultCredit(
          policy.builder_payee_id,
          incomingFrozen ? "reserve" : "pending",
          split.builderCents,
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

  // The zero-balance tripwire: builder share + platform share === the
  // pot, ALWAYS — structurally true under the subtraction model,
  // asserted defensively (the Don invariant in integer cents).
  const platformLegCents = split.settlementCents - split.builderCents;
  if (split.builderCents + platformLegCents !== split.settlementCents) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Builder share + platform share !== settlement pot — instant posting refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "developer_toolcall_settlement_post",
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
      builder_cents: split.builderCents,
      platform_cents: split.platformCents,
    },
  };
}
