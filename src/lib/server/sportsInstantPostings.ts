// The sports instant postings EXECUTION (PR 51, the founder sports
// directive) — the moment PR 50's staged sports applications become
// MONEY, in real time.
//
// PR 50's royalty walks compute the secondary resale market's three-way
// royalty cut and the biometric tracking feeds' micro-payout splits and
// STAGE them — sports_resale_royalty_applications and
// sports_biometric_micro_payout_applications — with journal_id null.
// THIS engine completes each staged application:
//
//   1. Read the staged application of record — fail-closed when absent.
//   2. A stamped journal_id IS the posting of record: counted no-op, no
//      second pricing, no second posting.
//   3. Re-verify the conservation identity against the staged pot
//      (legs sum === pot) BEFORE anything moves.
//   4. Post INSTANTLY: FBO cash debits the pot; every leg rides the SAME
//      fail-closed taxed cascade every payout credits through
//      (withholding off the top, the recoupment sweep). The cascade
//      credits each payee's GROSS (withheld and recouped portions move
//      within the house accounts, not out of the split), so the legs ===
//      pot, ALWAYS. The resale legs' payee identities come from the
//      venue×league resale royalty POLICY of record — the application
//      carries the amounts, the policy carries the identities (the
//      terms-of-record discipline).
//   5. CAS-stamp the journal id onto the staged application — the
//      journal of record marks the posting complete; a replayed or
//      concurrent invocation reads the stamp and refuses.
//
// THE INVARIANT: the staged application is the row of record — it exists
// even if the posting is interrupted (the OTA instant-posting discipline:
// the reconciliation of staged applications against journals surfaces
// any gap). The walk's single-worker claim discipline guards the
// posting window; the journal stamp guards every later replay.

import type { Store } from "@/lib/server/store";
import type {
  SportsBiometricMicroPayoutApplicationRecord,
  SportsResaleRoyaltyApplicationRecord,
} from "@/modules/sports/records";
import { postJournal } from "@/modules/ledger/engine";
import { fboDebit, type GlLegInput } from "@/modules/ledger/journal";
import { creditTaxedCascadePayee } from "@/lib/server/patentLitigationEscrow";

/** House failure envelope — the GPU cascade's shape. */
export type SportsInstantPostingFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
};

export type SportsInstantPostingCredit = {
  payee_id: string;
  payee_name: string;
  leg: string;
  gross_cents: number;
  net_cents: number;
};

/** Shared success shape — the staged application, the replay flag, the
 * journal, the pot, and the credits this execution moved. */
export type SportsInstantPostingSuccess<A> = {
  ok: true;
  value: {
    /** The staged application of record (journal-stamped after posting). */
    application: A;
    /** True when the journal of record already existed — a replay. */
    replayed: boolean;
    /** The posted journal when this execution moved money. */
    journal_id: string | null;
    pot_cents: number;
    credits: SportsInstantPostingCredit[];
  };
};

/**
 * The PURE conservation check — the staged legs must sum EXACTLY to the
 * staged pot, every leg a whole non-negative cent amount. The staged
 * row's CHECKs pin this at rest; the engine re-verifies before money
 * moves (never trust a payload's own arithmetic).
 */
export function sportsLegsConservePot(
  legs: { amount_cents: number }[],
  potCents: number,
): boolean {
  if (!Number.isInteger(potCents) || potCents < 0) {
    return false;
  }
  let total = 0;
  for (const leg of legs) {
    if (!Number.isInteger(leg.amount_cents) || leg.amount_cents < 0) {
      return false;
    }
    total += leg.amount_cents;
  }
  return total === potCents;
}

// ---------------------------------------------------------------------------
// The biometric micro-payout — athlete wallet + league data rights, the
// moment the tracking feed's application stages.
// ---------------------------------------------------------------------------

/**
 * Executes ONE staged biometric micro-payout application — the instant
 * posting between the athlete's wallet ledger and the league's data
 * rights ledger on licensed biometric telemetry. Idempotent BY STAGED
 * APPLICATION: a replayed execution reads the journal stamp and refuses
 * with the same counted no-op — never a second posting.
 */
export async function executeSportsBiometricMicroPayout(
  store: Store,
  sourceEventId: string,
  now: Date = new Date(),
): Promise<
  | SportsInstantPostingSuccess<SportsBiometricMicroPayoutApplicationRecord>
  | SportsInstantPostingFailure
> {
  if (sourceEventId.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_posting_identity",
      message: "An instant biometric micro-payout names its staged application of record.",
    };
  }

  // The staged application of record — PR 50's walk staged it with
  // journal_id null. Fail-closed when absent: nothing posts from a
  // staging that does not exist.
  const application = await store.getSportsBiometricMicroPayoutApplication(sourceEventId);
  if (application === undefined) {
    return {
      ok: false,
      status: 404,
      code: "biometric_payout_application_not_found",
      message: "No staged biometric micro-payout application matches that source event.",
    };
  }

  // The journal of record — a stamped journal_id IS the completed
  // posting: counted no-op, never a second split.
  if (application.journal_id !== null) {
    return {
      ok: true,
      value: {
        application,
        replayed: true,
        journal_id: application.journal_id,
        pot_cents: application.payout_pot_cents,
        credits: [],
      },
    };
  }

  // The staged legs of record — re-verify the conservation identity
  // BEFORE anything moves (the payload's own arithmetic is never
  // trusted).
  if (
    !sportsLegsConservePot(
      [
        { amount_cents: application.athlete_leg_cents },
        { amount_cents: application.league_leg_cents },
      ],
      application.payout_pot_cents,
    )
  ) {
    return {
      ok: false,
      status: 500,
      code: "biometric_payout_conservation_violation",
      message: `Staged biometric payout legs for ${sourceEventId} do not conserve the staged pot — posting refused.`,
    };
  }

  // The instant posting: FBO cash debits the pot; the athlete's wallet
  // and the league's data rights ledger ride the taxed cascade (their
  // legs append to glLegs). The cascade credits each payee's GROSS, so
  // the legs === pot, ALWAYS.
  const glLegs: GlLegInput[] = [fboDebit(application.payout_pot_cents)];
  const credits: SportsInstantPostingCredit[] = [];
  const legs: { payee_id: string; payee_name: string; leg: string; amount_cents: number }[] = [
    {
      payee_id: application.athlete_wallet_payee_id,
      payee_name: `Athlete wallet ${application.athlete_wallet_payee_id}`,
      leg: "athlete_data_rights",
      amount_cents: application.athlete_leg_cents,
    },
    {
      payee_id: application.league_data_payee_id,
      payee_name: `League data rights ${application.league_data_payee_id}`,
      leg: "league_data_rights",
      amount_cents: application.league_leg_cents,
    },
  ];
  for (const leg of legs) {
    if (leg.amount_cents === 0) {
      continue;
    }
    const netCents = await creditTaxedCascadePayee(
      store,
      leg.payee_id,
      leg.payee_name,
      leg.amount_cents,
      now,
      glLegs,
      [],
    );
    credits.push({
      payee_id: leg.payee_id,
      payee_name: leg.payee_name,
      leg: leg.leg,
      gross_cents: leg.amount_cents,
      net_cents: netCents,
    });
  }

  // The zero-balance tripwire: the posted legs + dust === the pot,
  // ALWAYS (the Don invariant in integer cents — the cascade's withheld
  // and recouped portions move within the house accounts, inside the
  // legs).
  const totalCredited = credits.reduce((sum, credit) => sum + credit.gross_cents, 0);
  if (totalCredited !== application.payout_pot_cents) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Athlete + league postings !== staged payout pot — instant biometric posting refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "sports_biometric_payout_post",
    ref_type: "ledger_transaction",
    ref_id: application.id,
    legs: glLegs,
  });
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }

  // The journal stamp — the CAS marks the staged application's posting
  // complete (journal_id null → stamped). A concurrent invocation that
  // lost the stamp race reads undefined; the walk's single-worker claim
  // discipline and the reconciliation of staged applications against
  // journals surface any gap (the OTA instant-posting stance).
  const stamped = await store.setSportsBiometricMicroPayoutJournal(
    application.source_event_id,
    posted.journal.id,
  );
  if (stamped === undefined) {
    return {
      ok: false,
      status: 409,
      code: "biometric_payout_already_posted",
      message: `Staged application ${application.source_event_id} is already journal-stamped — a concurrent posting won.`,
    };
  }

  return {
    ok: true,
    value: {
      application: stamped,
      replayed: false,
      journal_id: posted.journal.id,
      pot_cents: application.payout_pot_cents,
      credits,
    },
  };
}

// ---------------------------------------------------------------------------
// The secondary resale royalty — the promoter, venue, and league cuts,
// the moment the resale feed's application stages.
// ---------------------------------------------------------------------------

/**
 * Executes ONE staged resale royalty application — the instant posting of
 * the secondary market's royalty cut across the promoter, venue, and
 * league ledgers. The legs' payee identities come from the
 * venue×league resale royalty POLICY of record (the application carries
 * the amounts; the policy carries the identities — fail-closed when the
 * policy of record has vanished). Idempotent BY STAGED APPLICATION: a
 * replayed execution reads the journal stamp and refuses with the same
 * counted no-op — never a second posting.
 */
export async function executeSportsResaleRoyaltyPosting(
  store: Store,
  sourceEventId: string,
  now: Date = new Date(),
): Promise<
  SportsInstantPostingSuccess<SportsResaleRoyaltyApplicationRecord> | SportsInstantPostingFailure
> {
  if (sourceEventId.trim() === "") {
    return {
      ok: false,
      status: 422,
      code: "invalid_posting_identity",
      message: "An instant resale royalty posting names its staged application of record.",
    };
  }

  // The staged application of record — fail-closed when absent.
  const application = await store.getSportsResaleRoyaltyApplication(sourceEventId);
  if (application === undefined) {
    return {
      ok: false,
      status: 404,
      code: "resale_royalty_application_not_found",
      message: "No staged resale royalty application matches that source event.",
    };
  }

  // The journal of record — a stamped journal_id IS the completed
  // posting: counted no-op, never a second split.
  if (application.journal_id !== null) {
    return {
      ok: true,
      value: {
        application,
        replayed: true,
        journal_id: application.journal_id,
        pot_cents: application.royalty_pot_cents,
        credits: [],
      },
    };
  }

  // The payee identities of record — the venue×league policy of record.
  // Fail-closed when absent: the walk that staged this application wrote
  // FROM this policy, so its absence is a corrupted state, never a
  // guessed routing.
  const policy = await store.getSportsResaleRoyaltyPolicy(
    application.venue_gln,
    application.league_rights_code,
  );
  if (policy === undefined) {
    return {
      ok: false,
      status: 422,
      code: "missing_resale_royalty_policy",
      message: `No resale royalty policy of record exists for venue "${application.venue_gln}" × league "${application.league_rights_code}" — the legs' payees are unknowable. Posting refused.`,
    };
  }

  // The staged legs of record — re-verify the conservation identity
  // BEFORE anything moves.
  if (
    !sportsLegsConservePot(
      [
        { amount_cents: application.promoter_leg_cents },
        { amount_cents: application.venue_leg_cents },
        { amount_cents: application.league_leg_cents },
      ],
      application.royalty_pot_cents,
    )
  ) {
    return {
      ok: false,
      status: 500,
      code: "resale_royalty_conservation_violation",
      message: `Staged resale royalty legs for ${sourceEventId} do not conserve the staged pot — posting refused.`,
    };
  }

  // The instant posting: FBO cash debits the pot; the promoter, venue,
  // and league ledgers ride the taxed cascade (their legs append to
  // glLegs). The cascade credits each payee's GROSS, so the legs ===
  // pot, ALWAYS.
  const glLegs: GlLegInput[] = [fboDebit(application.royalty_pot_cents)];
  const credits: SportsInstantPostingCredit[] = [];
  const legs: { payee_id: string; payee_name: string; leg: string; amount_cents: number }[] = [
    {
      payee_id: policy.promoter_payee_id,
      payee_name: policy.promoter_payee_name,
      leg: "promoter_royalty",
      amount_cents: application.promoter_leg_cents,
    },
    {
      payee_id: policy.venue_payee_id,
      payee_name: policy.venue_payee_name,
      leg: "venue_royalty",
      amount_cents: application.venue_leg_cents,
    },
    {
      payee_id: policy.league_payee_id,
      payee_name: policy.league_payee_name,
      leg: "league_royalty",
      amount_cents: application.league_leg_cents,
    },
  ];
  for (const leg of legs) {
    if (leg.amount_cents === 0) {
      continue;
    }
    const netCents = await creditTaxedCascadePayee(
      store,
      leg.payee_id,
      leg.payee_name,
      leg.amount_cents,
      now,
      glLegs,
      [],
    );
    credits.push({
      payee_id: leg.payee_id,
      payee_name: leg.payee_name,
      leg: leg.leg,
      gross_cents: leg.amount_cents,
      net_cents: netCents,
    });
  }

  // The zero-balance tripwire: the posted legs + dust === the pot,
  // ALWAYS.
  const totalCredited = credits.reduce((sum, credit) => sum + credit.gross_cents, 0);
  if (totalCredited !== application.royalty_pot_cents) {
    return {
      ok: false,
      status: 500,
      code: "zero_balance_violation",
      message:
        "Promoter + venue + league postings !== staged royalty pot — instant resale posting refused.",
    };
  }

  const posted = await postJournal(store, {
    kind: "sports_resale_royalty_post",
    ref_type: "ledger_transaction",
    ref_id: application.id,
    legs: glLegs,
  });
  if (!posted.ok) {
    return { ok: false, status: 500, code: posted.code, message: posted.message };
  }

  // The journal stamp — the CAS marks the staged application's posting
  // complete (journal_id null → stamped). A concurrent invocation that
  // lost the stamp race reads undefined; the reconciliation of staged
  // applications against journals surfaces any gap.
  const stamped = await store.setSportsResaleRoyaltyJournal(
    application.source_event_id,
    posted.journal.id,
  );
  if (stamped === undefined) {
    return {
      ok: false,
      status: 409,
      code: "resale_royalty_already_posted",
      message: `Staged application ${application.source_event_id} is already journal-stamped — a concurrent posting won.`,
    };
  }

  return {
    ok: true,
    value: {
      application: stamped,
      replayed: false,
      journal_id: posted.journal.id,
      pot_cents: application.royalty_pot_cents,
      credits,
    },
  };
}
