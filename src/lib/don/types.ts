export const PLAID_PRODUCTS = ["auth", "identity"] as const;
export type PlaidProduct = (typeof PLAID_PRODUCTS)[number];

export const KYC_STATUSES = ["pending", "verified", "failed"] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const PLAID_KYC_ACTIONS = ["create_link_token", "verify_identity"] as const;
export type PlaidKycAction = (typeof PLAID_KYC_ACTIONS)[number];

export type KycAddress = {
  street: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
};

export type KycIdentityPayload = {
  legal_name: string;
  date_of_birth: string;
  email: string;
  phone: string | null;
  ssn_last_4: string | null;
  address: KycAddress | null;
};

export type CreateLinkTokenInput = {
  action: "create_link_token";
  creator_id: string;
  products: PlaidProduct[];
};

export type VerifyIdentityInput = {
  action: "verify_identity";
  creator_id: string;
  public_token: string | null;
  link_token: string | null;
  identity: KycIdentityPayload;
};

export type PlaidKycInput = CreateLinkTokenInput | VerifyIdentityInput;

export type PlaidLinkTokenRecord = {
  id: string;
  creator_id: string;
  link_token: string;
  public_token: string;
  access_token: string;
  expiration: string;
  products: string;
  created_at: string;
};

export type KycVerificationRecord = {
  id: string;
  creator_id: string;
  plaid_link_token: string | null;
  plaid_public_token: string | null;
  status: KycStatus;
  identity_json: string;
  failure_reason: string | null;
  created_at: string;
  verified_at: string | null;
};

export const PAYEE_ROLES = [
  "creator",
  "label",
  "publisher",
  "producer",
  "other",
] as const;
export type PayeeRole = (typeof PAYEE_ROLES)[number];

export const SETTLEMENT_RAILS = ["ach", "rtp"] as const;
export type SettlementRail = (typeof SETTLEMENT_RAILS)[number];

export const LEDGER_STATUSES = [
  "pending_settlement",
  "submitted",
  "settled",
  "failed",
  // Unclaimed royalty holding (PR 7): recon-identified unallocated funds sit
  // in holding until identity AND splits are fully verified. A held row's
  // kind is 'unclaimed_holding'; release settles it through the normal
  // clearance-gated settlement path (status → 'settled' + release journal).
  "unclaimed_holding",
  // Film waterfall escrow (PR 9): a film distributor's receipt locks in
  // escrow until the statement line items are cross-referenced against the
  // signed deal memo and CAMA agreement; the verified release settles the
  // row (status → 'settled') and routes the money into the waterfall.
  "escrow_waterfall_pending",
  // Gaming cashout pending (PR 13): funds entering from a game platform's
  // payout program hold until Astra cross-references the platform payout
  // batch against verified studio contracts and store statements AND the
  // batch's fiat settlement has completed. A locked row's kind is
  // 'virtual_currency_cashout_pending'; the verified release settles it
  // through the normal clearance-gated settlement path (status → 'settled'
  // + release journal).
  "virtual_currency_cashout_pending",
  // Esports prize pool pending (PR 14): a tournament organizer's prize-pool
  // remittance locked into the batch's waterfall escrow until the verified
  // release runs the sequential recoupment waterfall (status → 'settled').
  "esports_prize_pool_pending",
  // VTuber agency licensing holdback (PR 15): a managed talent's income
  // locked in the per-agency holdback until the verified release runs the
  // agency deduction stack — agency management (20–40%), 3D model rigging
  // and avatar IP licensing holdbacks, tech setup amortization — before net
  // income releases to the talent (status → 'settled').
  "avatar_ip_licensing_holdback",
  // Translation/localization escrow (PR 20): a foreign language feed's
  // translation royalty locked in the per-series-per-language escrow until
  // localization costs fully amortize and the verified release runs the
  // localization cascade — localizer royalty first, then the studio split
  // bands — before net funds allocate to the primary author (status →
  // 'settled').
  "translation_localization_pending",
  // Merchandise returns reserve (PR 23, the founder merchandise directive):
  // the founder-banded holdback (10–15%) of a merch payout allocation locks
  // at dispatch until the returns window elapses; customer returns and
  // payment chargebacks draw it down position-locked, and the verified
  // release after the window settles it to the beneficiary of record
  // (status → 'settled').
  "merch_returns_reserve",
  // UNAUTHORIZED_TRAINING_HOLD (PR 25, the founder AI directive + the
  // tokenization patch's opt-out): an AI model's unclaimed-holding legs
  // FREEZE here while a rights holder's IP attribution dispute against the
  // training dataset is active — the money is on the ledger, visibly, and
  // cannot release. Kind never changes (kind marks WHAT the row is —
  // still 'unclaimed_holding' money; status carries the state machine).
  // The ONLY thaw is the verified resolution path: the dispute's CAS
  // resolution (filed → resolved) through the training-dispute module
  // flips the frozen legs back to status 'unclaimed_holding', at which
  // point the normal clearance-gated release applies. No migration:
  // ledger_transactions.status is free text (0006 has no check
  // constraint), so the state extends the existing ledger contract in
  // place.
  "unauthorized_training_hold",
  // FOREIGN_TAX_HOLD (PR 27, the founder publishing directive): a FOREIGN
  // print royalty's unclaimed-holding leg FREEZES here, keyed on the sale
  // territory's country code (the scope stamp
  // 'foreign_tax_hold:{country_code}:{tax_year}' in split_run_id — the PR 25
  // scope discipline), until a VERIFIED withholding tax credit of record
  // lands for that country and tax year — treaty evidence, for example a
  // US-UK treaty credit. Fail-closed before that: the ONLY exit is the
  // verified release sweep, and the standing unclaimed-holding release
  // refuses a frozen leg outright. Kind never changes (kind marks WHAT the
  // row is — still 'unclaimed_holding' money; status carries the state
  // machine). No migration: ledger_transactions.status is free text (0006
  // has no check constraint), so the state extends the existing ledger
  // contract in place.
  "foreign_tax_hold",
  // Book returns reserve (PR 27, the founder publishing directive): the
  // 15–20% of a physical print allocation held per ISBN for the 90–120 day
  // returns window. Publisher returns and chargebacks draw it down
  // position-locked, and the verified release after the window settles the
  // remainder to the beneficiary of record (status → 'settled').
  "book_returns_reserve",
  // PROMOTER_BOX_OFFICE_SETTLEMENT_PENDING (PR 31, the founder
  // touring/comedy settlement-protection directive): a tour stop's box
  // office net LOCKS here — keyed per stop by the escrow row's
  // 'promoter_settlement:{production}:{venue}:{showDate}' payee — until the
  // FINAL night-of-show audit closes and the close of record verifies. No
  // migration: ledger_transactions.status is free text (0006 has no check
  // constraint), so the state extends the existing ledger contract in
  // place, the film/esports escrow precedent.
  "promoter_box_office_settlement_pending",
  // COMEDY_AUDIO_RIGHTS_PENDING (PR 31): a comedy special's AUDIO royalty
  // (SiriusXM, Spotify) posts here — its OWN rights stream, isolated in
  // payee, GL account, and kind from the physical live ticket sales
  // streams. Audio money is licensed-recording money; ticket money is box
  // office money; kind never lets a query fold one into the other.
  "comedy_audio_rights_pending",
  // AUDIT_RESERVE_ESCROW (PR 33, the founder licensing-audit directive):
  // the 5–10% (founder-banded, per-scope policy of record) of a licensing
  // royalty credit that locks here — keyed per license scope by the escrow
  // row's 'audit_reserve_escrow:{scopeKey}' sentinel payee — while the
  // contract's audit exposure runs. Quarterly retail audit reconciliations
  // and inventory write-offs draw it down position-locked; the verified
  // reconciliation of record opens the release (fail-closed: no
  // reconciliation of record, no release), and the released remainder
  // settles it (status → 'settled'). Kind marks WHAT the row is for its
  // whole life, the same division every escrow state above uses. No
  // migration: ledger_transactions.status is free text (0006 has no check
  // constraint), so the state extends the existing ledger contract in
  // place, the film/esports/promoter precedent.
  "audit_reserve_escrow",
  // MG_SHORTFALL_DUE (PR 33, the founder licensing guarantee directive): a
  // licensee's annual minimum-guarantee shortfall — the advance of record
  // did not fully recoup at contract term close — debits here as the
  // invoice of record AGAINST the licensee of record (payee = the
  // licensee, the term-close id stamped in line_item_id). The row is the
  // receivable's face on the Don ledger: visible, priced, and never a
  // guessed amount (the shortfall derives from the append-only recoupment
  // truth at close). Kind marks WHAT the row is for its whole life. No
  // migration: ledger_transactions.status is free text, the same
  // extension-in-place discipline as every escrow state above.
  "mg_shortfall_due",
  // NIL_AUDIT_ESCROW (PR 35, the founder NIL directive): the 5–10%
  // (founder-banded, per-scope policy of record) of an athletic department
  // distribution that locks here — keyed per (payee, school) scope by the
  // escrow row's 'nil_audit_escrow:{scopeKey}' sentinel payee — while the
  // athlete's compliance exposure runs. Mid-season NCAA Transfer Portal
  // reconciliations and tax withholdings draw it down position-locked; the
  // verified reconciliation of record opens the release (fail-closed: no
  // reconciliation of record, no release), and the released remainder
  // settles it (status → 'settled'). Kind marks WHAT the row is for its
  // whole life. No migration: ledger_transactions.status is free text, the
  // same extension-in-place discipline as every escrow state above.
  "nil_audit_escrow",
  // NIL_UNEARNED_CLAWBACK (PR 35, the founder NIL directive): an athlete
  // entering the transfer portal prior to contract completion — the
  // pro-rated unearned NIL advance balance debits here as the hold of
  // record AGAINST the athlete (payee = the athlete, the contract id
  // stamped in line_item_id). The row is the receivable's face on the Don
  // ledger: visible, priced, and never a guessed amount (the balance
  // derives from the advance schedule of record — floor-only integer
  // arithmetic, exact to the cent). Kind marks WHAT the row is for its
  // whole life. No migration: the same extension-in-place discipline.
  "nil_unearned_clawback",
  // SPATIAL_AUDIT_ESCROW (PR 37, the founder spatial directive): the
  // 5–12% (founder-banded, per-scope policy of record) of a venue's park
  // earnings that locks here — keyed per scope by the escrow row's
  // 'spatial_audit_escrow:{scopeKey}' sentinel payee — while the scope's
  // local exposure runs. Local entertainment sales taxes, safety
  // compliance holdbacks, and quarterly park concession reconciliations
  // draw it down position-locked; the verified reconciliation of record
  // opens the release (fail-closed: no reconciliation of record, no
  // release), and a pop-up scope's final disbursement additionally
  // requires its post-event inventory write-off and site restoration
  // reserve of record. The released remainder settles it (status →
  // 'settled'). Kind marks WHAT the row is for its whole life. No
  // migration: ledger_transactions.status is free text, the same
  // extension-in-place discipline as every escrow state above.
  "spatial_audit_escrow",
  // FITNESS_AUDIT_ESCROW (PR 39, the founder fitness directive): the
  // 5–10% (founder-banded, per-scope policy of record) of a fitness IP
  // payout that locks here — keyed per (trainer, studio franchise) scope
  // by the escrow row's 'fitness_audit_escrow:{scopeKey}' sentinel payee
  // — while the trainer's compliance exposure runs. Member chargeback
  // reserves, class return allowances, and quarterly sync music licensing
  // audits draw it down position-locked; the verified reconciliation of
  // record opens the release (fail-closed: no reconciliation of record,
  // no release), and the released remainder settles it (status →
  // 'settled'). Kind marks WHAT the row is for its whole life. No
  // migration: ledger_transactions.status is free text, the same
  // extension-in-place discipline as every escrow state above.
  "fitness_audit_escrow",
  // CULINARY_AUDIT_ESCROW (PR 41, the founder culinary directive): the
  // 5–10% (founder-banded, per-scope policy of record) of a culinary IP
  // payout that locks here — keyed per (chef, ghost kitchen) scope by the
  // escrow row's 'culinary_audit_escrow:{scopeKey}' sentinel payee —
  // while the kitchen's compliance exposure runs (health inspections,
  // territorial exclusivity). Customer refund allowances, food spoilage
  // chargebacks, and quarterly ingredient supplier quality audits draw it
  // down position-locked; the verified reconciliation of record opens the
  // release (fail-closed: no reconciliation of record, no release), and
  // the released remainder settles it (status → 'settled'). A viral-menu
  // pop-up scope must ALSO have its post-campaign packaging write-off of
  // record before any release (fail-closed). Kind marks WHAT the row is
  // for its whole life. No migration: ledger_transactions.status is free
  // text, the same extension-in-place discipline as every escrow state
  // above.
  "culinary_audit_escrow",
  // SERVICE_AUDIT_ESCROW (PR 43, the founder services directive): the
  // 5–10% (founder-banded, per-scope policy of record) of a franchise
  // service payout that locks here — keyed per (stylist, salon location)
  // scope by the escrow row's 'service_audit_escrow:{scopeKey}' sentinel
  // payee — while the location's compliance exposure runs (health board
  // licensing, territorial franchise exclusivity). Client refund
  // allowances, product return chargebacks, and quarterly backbar
  // inventory audits draw it down position-locked; the verified
  // reconciliation of record opens the release (fail-closed: no
  // reconciliation of record, no release), and the released remainder
  // settles it (status → 'settled'). Kind marks WHAT the row is for its
  // whole life. No migration: ledger_transactions.status is free text,
  // the same extension-in-place discipline as every escrow state above.
  "service_audit_escrow",
  // SOFTWARE_AUDIT_ESCROW (PR 45, the founder software directive): the
  // 5–10% (founder-banded, per-scope policy of record) of a developer IP
  // payout that locks here — keyed per (developer, API endpoint) scope by
  // the escrow row's 'software_audit_escrow:{scopeKey}' sentinel payee —
  // while the payout's exposure runs (API uptime SLA, security audit
  // clearance). Uptime outage penalty refunds, API rate-limit breach
  // credits, and quarterly security compliance audits draw it down
  // position-locked; the verified reconciliation of record opens the
  // release (fail-closed: no reconciliation of record, no release), and
  // the released remainder settles it (status → 'settled'). Kind marks
  // WHAT the row is for its whole life. No migration:
  // ledger_transactions.status is free text, the same extension-in-place
  // discipline as every escrow state above.
  "software_audit_escrow",
  // PATENT_LITIGATION_ESCROW (PR 47, the founder hardware directive): the
  // 10–15% (founder-banded ELEVATED, per-scope policy of record) of a
  // hardware patent payout that locks here — keyed per (licensor payee,
  // SEP pool) scope by the escrow row's
  // 'patent_litigation_escrow:{scopeKey}' sentinel payee — while the
  // payout's litigation exposure runs (FRAND rate court determination, SEP
  // essentiality audit). Global court rate redeterminations, anti-suit
  // injunction penalties, and cross-border patent validity challenges draw
  // it down position-locked; the verified reconciliation of record opens
  // the release (fail-closed: no reconciliation of record, no release),
  // and the released remainder settles it (status → 'settled'). Kind marks
  // WHAT the row is for its whole life. No migration:
  // ledger_transactions.status is free text, the same extension-in-place
  // discipline as every escrow state above.
  "patent_litigation_escrow",
  // Resource audit escrow (PR 49, the founder resource directive): the
  // 5–15% of a resource payout auto-locked while the owner's commodity
  // price reconciliation, pipeline variance audit, and environmental
  // regulatory exposure run — drawn down by those three classes
  // position-locked; released on the verified reconciliation of record.
  // Kind marks WHAT the row is for its whole life, the same division
  // every escrow kind above uses. No migration:
  // ledger_transactions.status is free text, the same extension-in-place
  // discipline as every escrow state above.
  "resource_audit_escrow",
  // Event cancellation escrow (PR 51, the founder sports directive): the
  // 15–20% of a scope's net gate receipts auto-locked at payout while the
  // event's cancellation exposure runs — drawn down by weather delays,
  // athlete withdrawals, and mandatory ticket refund calls
  // position-locked; released only after the event's completion
  // telemetry verifies AND 48 hours elapse post-event. Kind marks WHAT
  // the row is for its whole life, the same division every escrow state
  // above uses. No migration: ledger_transactions.status is free text,
  // the same extension-in-place discipline as every escrow state above.
  "event_cancellation_escrow",
  // MSG_SHORTFALL_DUE (PR 37, the founder spatial directive): a regional
  // licensee's or pop-up park operator's quarterly Minimum Spatial
  // Guarantee shortfall — the quarter's spatial royalty earnings of
  // record did not meet the guarantee priced from the venue's reserved
  // footprint — debits here as the invoice of record AGAINST the
  // operator of record (payee = the operator, the quarter key stamped in
  // line_item_id). The row is the receivable's face on the Don ledger:
  // visible, priced, and never a guessed amount (the shortfall derives
  // from the append-only spatial royalty truth at close). Kind marks WHAT
  // the row is for its whole life. No migration: the same
  // extension-in-place discipline.
  "msg_shortfall_due",
] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export const LEDGER_KINDS = [
  "royalty",
  "payout",
  "payout_failed_reversal",
  // Banking-rails funding (PR 4): verified Stripe webhook receipts post the
  // money-IN leg. Never written by charge creation — only the signed
  // payment_intent.succeeded webhook posts it.
  "funding_received",
  // Unclaimed royalty holding (PR 7): a recon-sourced credit parked in
  // holding. Kind marks WHAT the row is for its whole life (status carries
  // the state machine), the same division 'payout_failed_reversal' uses.
  "unclaimed_holding",
  // Film waterfall escrow (PR 9): a film distributor's receipt locked in
  // escrow for the waterfall. Kind marks WHAT the row is for its whole life
  // (a released receipt stays kind 'escrow_waterfall_pending' with status
  // 'settled'), the same division PR 7 uses.
  "escrow_waterfall_pending",
  // Gaming cashout pending (PR 13): a game platform's fiat payout batch
  // locked until the cross-reference (studio contracts + store statements)
  // and the batch's fiat settlement verify. Kind marks WHAT the row is for
  // its whole life (a released receipt stays kind
  // 'virtual_currency_cashout_pending' with status 'settled'), the same
  // division PR 7 and PR 9 use.
  "virtual_currency_cashout_pending",
  // Esports prize pool pending (PR 14): a tournament's prize-pool receipt,
  // locked per batch until the verified waterfall release. Kind marks WHAT
  // the row is for its whole life (a released receipt stays kind
  // 'esports_prize_pool_pending' with status 'settled'), the same division
  // PR 7, PR 9, and PR 13 use.
  "esports_prize_pool_pending",
  // VTuber agency licensing holdback (PR 15): a managed talent's income
  // locked in the per-agency holdback until the verified release runs the
  // agency deduction stack. Kind marks WHAT the row is for its whole life
  // (a released receipt stays kind 'avatar_ip_licensing_holdback' with
  // status 'settled'), the same division PR 7, PR 9, PR 13, and PR 14 use.
  "avatar_ip_licensing_holdback",
  // Translation/localization escrow (PR 20): a foreign language feed's
  // translation royalty locked per series+language until localization costs
  // fully amortize and the verified release runs the localization cascade.
  // Kind marks WHAT the row is for its whole life (a released receipt stays
  // kind 'translation_localization_pending' with status 'settled'), the same
  // division PR 7, PR 9, PR 13, PR 14, and PR 15 use.
  "translation_localization_pending",
  // Merch returns reserve (PR 23): the 10–15% of a merch payout allocation
  // held per contract for the returns window. Kind marks WHAT the row is
  // for its whole life (a released or fully-drawn reserve stays kind
  // 'merch_returns_reserve' with status 'settled'), the same division PR 7,
  // PR 9, PR 13, PR 14, PR 15, and PR 20 use.
  "merch_returns_reserve",
  // Book returns reserve (PR 27): the 15–20% of a physical print allocation
  // held per ISBN for the 90–120 day returns window. Kind marks WHAT the row
  // is for its whole life (a released or fully-drawn reserve stays kind
  // 'book_returns_reserve' with status 'settled'), the same division PR 7,
  // PR 9, PR 13, PR 14, PR 15, PR 20, and PR 23 use.
  "book_returns_reserve",
  // Promoter box office settlement pending (PR 31): a tour stop's box
  // office net, locked per stop until the final night-of-show audit closes.
  // Kind marks WHAT the row is for its whole life (a released receipt stays
  // kind 'promoter_box_office_settlement_pending' with status 'settled'),
  // the same division PR 7, PR 9, PR 13, PR 14, PR 15, PR 20, PR 23, and
  // PR 27 use.
  "promoter_box_office_settlement_pending",
  // Comedy audio rights pending (PR 31): a comedy special's AUDIO royalty
  // (SiriusXM, Spotify), its own rights stream — NEVER a box office account,
  // never a ticket-sales kind. Kind marks WHAT the row is for its whole
  // life, the same division every escrow state above uses.
  "comedy_audio_rights_pending",
  // Audit reserve escrow (PR 33): the founder-banded 5–10% of a licensing
  // royalty credit held per license scope for the contract's audit
  // exposure — drawn down by quarterly retail audit reconciliations and
  // inventory write-offs, released with a verified reconciliation of
  // record. Kind marks WHAT the row is for its whole life (a released or
  // fully-drawn reserve stays kind 'audit_reserve_escrow' with status
  // 'settled'), the same division PR 7, PR 9, PR 13, PR 14, PR 15, PR 20,
  // PR 23, PR 27, and PR 31 use.
  "audit_reserve_escrow",
  // Minimum-guarantee shortfall due (PR 33): the licensee's annual MG
  // shortfall debited as the invoice of record at contract term close —
  // the receivable's face on the Don ledger, priced from the append-only
  // recoupment truth, never guessed. Kind marks WHAT the row is for its
  // whole life, the same division every kind above uses.
  "mg_shortfall_due",
  // NIL audit escrow (PR 35): the founder-banded 5–10% of an athletic
  // department distribution held per (payee, school) scope for the
  // athlete's compliance exposure — drawn down by mid-season NCAA
  // Transfer Portal reconciliations and tax withholdings, released with a
  // verified reconciliation of record. Kind marks WHAT the row is for its
  // whole life (a released or fully-drawn escrow stays kind
  // 'nil_audit_escrow' with status 'settled'), the same division every
  // escrow kind above uses.
  "nil_audit_escrow",
  // Unearned NIL advance clawback (PR 35): an athlete's pro-rated
  // unearned advance balance, debited as the hold of record on transfer
  // portal entry prior to contract completion — the receivable's face on
  // the Don ledger, priced from the advance schedule of record, never
  // guessed. Kind marks WHAT the row is for its whole life, the same
  // division every kind above uses.
  "nil_unearned_clawback",
  // Spatial audit escrow (PR 37): the founder-banded 5–12% of a venue's
  // park earnings held per scope for the scope's local exposure — drawn
  // down by local entertainment sales taxes, safety compliance
  // holdbacks, and quarterly park concession reconciliations, released
  // with a verified reconciliation of record (a pop-up scope's release
  // additionally gated on its post-event inventory write-off and site
  // restoration reserve of record). Kind marks WHAT the row is for its
  // whole life (a released or fully-drawn escrow stays kind
  // 'spatial_audit_escrow' with status 'settled'), the same division
  // every escrow kind above uses.
  "spatial_audit_escrow",
  // Fitness audit escrow (PR 39): the founder-banded 5–10% of a fitness
  // IP payout held per (trainer, studio franchise) scope for the
  // trainer's compliance exposure — drawn down by member chargeback
  // reserves, class return allowances, and quarterly sync music licensing
  // audits, released with a verified reconciliation of record. Kind marks
  // WHAT the row is for its whole life (a released or fully-drawn escrow
  // stays kind 'fitness_audit_escrow' with status 'settled'), the same
  // division every escrow kind above uses.
  "fitness_audit_escrow",
  // Culinary audit escrow (PR 41, the founder culinary directive): the
  // 5–10% of a culinary IP payout auto-locked while the ghost kitchen's
  // health-inspection and territorial-exclusivity exposure runs — drawn
  // down by customer refund allowances, food spoilage chargebacks, and
  // quarterly ingredient supplier quality audits; released on the
  // verified reconciliation of record, with a viral-menu pop-up scope
  // additionally gated on its post-campaign packaging write-off. Kind
  // marks WHAT the row is for its whole life, the same division every
  // escrow kind above uses.
  "culinary_audit_escrow",
  // Service audit escrow (PR 43, the founder services directive): the
  // 5–10% of a franchise service payout auto-locked while the salon
  // location's health-board-licensing and territorial-franchise-
  // exclusivity exposure runs — drawn down by client refund allowances,
  // product return chargebacks, and quarterly backbar inventory audits;
  // released on the verified reconciliation of record. Kind marks WHAT
  // the row is for its whole life, the same division every escrow kind
  // above uses.
  "service_audit_escrow",
  // Software audit escrow (PR 45, the founder software directive): the
  // 5–10% of a developer IP payout auto-locked while the payout's API
  // uptime SLA and security-audit exposure runs — drawn down by uptime
  // outage penalty refunds, API rate-limit breach credits, and quarterly
  // security compliance audits; released on the verified reconciliation
  // of record. Kind marks WHAT the row is for its whole life, the same
  // division every escrow kind above uses.
  "software_audit_escrow",
  // Patent litigation escrow (PR 47, the founder hardware directive): the
  // ELEVATED 10–15% of a hardware patent payout auto-locked while the
  // payout's litigation exposure runs — drawn down by global court rate
  // redeterminations, anti-suit injunction penalties, and cross-border
  // patent validity challenges; released on the verified reconciliation
  // of record. Kind marks WHAT the row is for its whole life, the same
  // division every escrow kind above uses.
  "patent_litigation_escrow",
  // Resource audit escrow (PR 49, the founder resource directive): the
  // 5–15% of a resource payout locked per (owner payee, parcel) scope —
  // while the payout's commodity true-up, pipeline variance, and
  // environmental regulatory exposure run. Monthly commodity price
  // reconciliations, pipeline variance audits, and environmental
  // regulatory compliance checks draw it down position-locked; the
  // verified reconciliation of record opens the release (fail-closed: no
  // reconciliation of record, no release), and the released remainder
  // settles it (status → 'settled'). Kind marks WHAT the row is for its
  // whole life, the same division every escrow kind above uses.
  "resource_audit_escrow",
  // Event cancellation escrow (PR 51, the founder sports directive): the
  // 15–20% of a scope's net gate receipts locked per (promoter payee,
  // event) scope — while the event's cancellation exposure runs. Weather
  // delays, athlete withdrawals, and mandatory ticket refund calls draw
  // it down position-locked; the release opens only after the event's
  // completion telemetry verifies AND 48 hours elapse post-event
  // (fail-closed: no verified telemetry of record, no release; the clock
  // not yet elapsed, no release), and the released remainder settles it
  // (status → 'settled'). Kind marks WHAT the row is for its whole life,
  // the same division every escrow kind above uses.
  "event_cancellation_escrow",
  // MSG_SHORTFALL_DUE (PR 37, the founder spatial directive): a regional licensee
  // or pop-up park operator's quarterly MSG shortfall debited as the
  // invoice of record at quarter close — the receivable's face on the
  // Don ledger, priced from the venue's reserved-footprint guarantee
  // terms and the append-only spatial royalty truth, never guessed. Kind
  // marks WHAT the row is for its whole life, the same division every
  // kind above uses.
  "msg_shortfall_due",
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const BAAS_PROVIDERS = ["column", "unit", "lithic"] as const;
export type BaasProvider = (typeof BAAS_PROVIDERS)[number];

export type SplitPartyInput = {
  payee_id: string;
  payee_name: string;
  role: PayeeRole;
  share_bps: number;
};

export type RoyaltyLineItemInput = {
  work_id: string;
  work_title: string;
  amount_cents: number;
  splits: SplitPartyInput[];
};

export type SplitCalculateInput = {
  source: string;
  period: string | null;
  currency: string;
  settle: boolean;
  rail: SettlementRail;
  line_items: RoyaltyLineItemInput[];
  /**
   * Optional saga replay key (audit H3): a retried calculate presenting a key
   * that already produced a split run is refused with 409 instead of
   * double-running the multi-write saga. Absent = unkeyed (null).
   */
  idempotency_key?: string | null;
};

export type AllocatedSplit = SplitPartyInput & { amount_cents: number };

export type AllocatedLineItem = {
  work_id: string;
  work_title: string;
  amount_cents: number;
  splits: AllocatedSplit[];
  company_dust_cents: number;
};

export type SplitRunRecord = {
  id: string;
  source: string;
  period: string | null;
  currency: string;
  gross_cents: number;
  line_item_count: number;
  variance_account_cents: number;
  created_at: string;
  status: "posted" | "reversed";
  /**
   * The saga idempotency key (migration 0009) — unique when present. The
   * split_runs insert is the split-calculation saga's first write, so this
   * key is the replay lock: a retried calculate with a used key is rejected
   * before any line item, ledger row, or vault credit exists. Null for
   * unkeyed runs (today's semantics).
   */
  idempotency_key: string | null;
};

export type RoyaltyLineItemRecord = {
  id: string;
  split_run_id: string;
  work_id: string;
  work_title: string;
  amount_cents: number;
  splits_json: string;
  created_at: string;
};

export type LedgerTransactionRecord = {
  id: string;
  split_run_id: string;
  line_item_id: string;
  payee_id: string;
  payee_name: string;
  role: PayeeRole;
  share_bps: number;
  amount_cents: number;
  currency: string;
  status: LedgerStatus;
  rail: SettlementRail | null;
  baas_provider: BaasProvider | null;
  baas_transfer_id: string | null;
  created_at: string;
  settled_at: string | null;
  kind: LedgerKind;
};

export type BaasTransferRecord = {
  id: string;
  provider: BaasProvider;
  rail: SettlementRail;
  payee_id: string;
  payee_name: string;
  amount_cents: number;
  currency: string;
  status: "submitted" | "settled" | "failed" | "returned";
  ledger_transaction_id: string | null;
  created_at: string;
  estimated_settlement: string | null;
};
