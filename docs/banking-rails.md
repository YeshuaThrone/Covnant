# Banking Rails — Stripe Funding, Lithic Payouts, Plaid Verification

Status: **stubs, fail-closed, shaped for live keys.** No app-level `STRIPE_*`,
`LITHIC_*`, or `PLAID_*` keys exist yet. Every entry point returns a structured
not-configured envelope while keys are absent — never a fake success.

Founder canon (2026-09-30): "We build the API with Stripe and Lithic to FUEL
the Gold Board. The Gold Board is the financial ledger. Plaid is available as
well." Stripe and Lithic are the rails that move money into and out of the
Gold Board ledger; Plaid authorizes and verifies creator bank accounts.

## Module map

| Module | Role |
| --- | --- |
| `src/services/banking/types.ts` | Shared rail contracts (results, transfers, config, funding) |
| `src/services/banking/transport.ts` | Injectable `fetch` transport — tests mock it, never the network |
| `src/services/banking/lithic.ts` | Lithic adapter: `dispatchAch`, `createVirtualCard` |
| `src/services/banking/stripe.ts` | Stripe adapter: `createFundingCharge`, signature verification |
| `src/services/banking/plaid.ts` | Plaid adapter: `createLinkToken`, `exchangePublicToken`, `getBankAccountVerification` |
| `src/modules/banking/validation.ts` | Payload validators (UUID idempotency, vertical enum, funding metadata) |
| `src/modules/compliance/payoutGate.ts` | The fail-closed payout compliance gate (all verticals) |
| `src/modules/don/baasAdapter.ts` | Lithic as a BaaS provider — payout execution beside the vault engine |

Routes:

| Route | Gate | Purpose |
| --- | --- | --- |
| `POST /api/v1/lithic/ach/dispatch` | Operator session + compliance gate | ACH payout OUT of the Gold Board (on settlement) |
| `POST /api/v1/lithic/cards` | Operator session + compliance gate | Gold Note Card issuing (virtual card stub) |
| `POST /api/v1/plaid/link-token` | Creator session | Plaid Link token for the creator's OWN bank |
| `POST /api/v1/plaid/bank-accounts` | Creator session | Verification status + last-4 masks for connected accounts |
| `POST /api/v1/webhooks/stripe` | Stripe signature (own scheme) | Funding events IN to the Gold Board |

## Not-configured canon

Adapter posture follows `sandboxRail.ts` and the Don adapter patterns: when a
provider's environment is absent, entry points return a structured envelope —

```json
{ "ok": false, "status": 503, "code": "lithic_not_configured",
  "message": "LITHIC_API_KEY and LITHIC_ENV must be configured to dispatch ACH transfers." }
```

Codes: `lithic_not_configured`, `stripe_not_configured`, `plaid_not_configured`,
`stripe_signature_not_configured`. A missing provider config is a **503**, not
a silent success and not a 500. Zero outbound calls are made when unconfigured
(proven by tests with a `fetch` spy).

## Environment

| Variable | Enables |
| --- | --- |
| `LITHIC_API_KEY`, `LITHIC_ENV` (`sandbox` \| `production`) | ACH dispatch, card issuing |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Funding charges, webhook verification |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | Link tokens, public-token exchange, account verification |

## The payout compliance gate — fail-closed, three conditions plus the vertical family

`POST /api/v1/lithic/ach/dispatch` and `POST /api/v1/lithic/cards` run the
same gate (`evaluatePayoutCompliance` in `src/modules/compliance/payoutGate.ts`)
after operator authentication and before any provider capability is disclosed
(a refused caller cannot even learn whether Lithic is configured):

1. **`operator_settlement_approved` must be `true`** — the request states it;
   the settlement path (not recon completion) is what sets it.
2. **Creator `user_kyc_status` must be `verified`** — sourced from the latest
   `kyc_verifications` row for the payee (Plaid-backed when present).
   Absent or unknown KYC state refuses (`kyc_state_unknown`).
3. **Vertical family satisfied** — the asset's vertical selects the gate
   family (below). Absent or unknown state refuses (`vertical_state_unknown`).

Every refusal is a structured `403` envelope with a named code
(`settlement_not_approved`, `kyc_unverified`, `kyc_state_unknown`,
`vertical_state_unknown`, or a family-specific code) — **never default to
allowing**. Unknown is failure.

### Vertical gate families (founder canon, 2026-09-30)

The gate branches on the asset vertical; each family reads the state the
recon layer will populate (via `setVerticalComplianceStateSource`). Until
that state exists, every payout refuses — the default source returns unknown.

| Vertical | Required state (all must be `true`) |
| --- | --- |
| `music` | `rights_separation_settled` (MASTER or PUBLISHING resolved, nothing quarantined unresolved) |
| `film` | `cama_escrow_released` AND `guild_residual_holdback_satisfied` (SAG-AFTRA / WGA / DGA holds from SVOD + foreign theatrical statements) |
| `podcast` | `iab_ad_impression_verified` AND `network_commission_deducted` |
| `gaming` | `platform_commission_deducted` (Apple 15–30%, Steam 30, EGS 12) AND `studio_kyc_verified` AND every named team member passing identity checks |
| `livestream` | `stream_platform_payout_reconciled` AND `tax_withholding_verified` (mandatory for international esports tournament winnings) |
| `publishing` | `ip_rights_cleared`; print books additionally `return_reserve_period_elapsed` AND `isbn_rights_verified` |
| `merch` | `physical_fulfillment_confirmed` (tracking delivered) before non-reserve funds release |
| `ai` | `ai_training_consent_verified` AND `synthetic_voice_likeness_released` |
| `art` | `estate_succession_verified` (legal certificate validated) before estate / multi-heir waterfall dispatch |
| `theater` | `grand_rights_cleared` AND `venue_settlement_reconciled` |
| `licensing` | `territory_cleared` AND `category_exclusivity_verified` |
| `nil` | `nil_cleared` AND `compliance_verified` AND `title_ix_proportionality_cleared`; collective/booster-backed funds hold until institutional cap verification (`collective_or_booster_backed: false` is the only skip) |
| `spatial` | `territorial_zoning_cleared` AND `spatial_audit_verified` |
| `fitness` | `hipaa_gdpr_privacy_cleared` AND `territorial_studio_exclusivity_verified` |
| `culinary` | `health_inspection_cleared` AND `territorial_kitchen_exclusivity_verified` |
| `services` | `health_board_license_verified` AND `territorial_franchise_exclusivity_verified` |
| `software` | `api_uptime_sla_verified` AND `software_security_audit_cleared` |
| `hardware` | `frand_rate_court_determination_cleared` AND `sep_essentiality_audit_verified` |

## Money movement — through the Don ledger contract, never around it

- **Funding IN (Stripe):** `payment_intent.succeeded` events with the
  `gold_board_funding` origin metadata post through the vault credit +
  ledger + `funding_received` journal sequence (the same vault/ledger path
  the Don engine owns). Events without the designated origin, non-USD
  events, and replays (same Stripe event id) are acknowledged without
  posting.
- **Payout OUT (Lithic ACH):** dispatch runs through `payoutFromVault` with
  an injected dispatcher — the existing atomic vault hold, ledger posting,
  transfer record, and journal sequence. A failed dispatch records a null
  provider rather than guessing; the vault hold surfaces honestly.
- **Card issuing (Lithic):** issuance moves no Gold Board money; the same
  compliance gate still runs first.

## Settlement trigger contract (for the Astra agent PR — read this precisely)

**The Lithic dispatch endpoint is invoked on SETTLEMENT, never directly on
recon job completion.**

- Recon completion (the `royalty_recon_jobs` worker) lands **audited events**
  in the Gold Board ledger. It moves no money and calls no banking route.
- Payout movement happens only through the **clearance-gated settlement
  path**: the master-use-license clearance gate runs first; settlement
  approval is recorded; only then is `POST /api/v1/lithic/ach/dispatch`
  invoked with `operator_settlement_approved: true` and the asset's vertical.
- The compliance gate re-verifies everything server-side (operator session,
  Plaid-backed KYC, vertical family). A caller that skips settlement and
  passes `operator_settlement_approved: true` directly is still refused
  unless KYC and vertical state verify — the flag is necessary, never
  sufficient.
- The Astra agent must consume this contract: trigger dispatch from the
  settlement boundary only, pass the vertical, and treat every `403`
  compliance envelope as terminal for that attempt (retry without new
  evidence changes nothing — the gate is deterministic).

## Data minimization

- Plaid responses surface account **masks and verification status only** —
  full account numbers never leave the adapter.
- Lithic requests carry Plaid/processor **tokens** (`destination_bank_token`),
  never raw account or routing numbers.
- No credentials, secrets, or full account numbers are logged anywhere in
  these modules.

## Tests

- `src/services/banking/__tests__/adapters.test.ts` — adapter seams with a
  mocked transport: exact request shapes (method, URL, headers, body),
  not-configured envelopes with zero outbound calls, provider error
  propagation, Plaid account-number redaction.
- `src/modules/compliance/__tests__/payoutGate.test.ts` — every refusal path
  (settlement, KYC, vertical unknown) and the eighteen vertical families,
  including the NIL cap holdback and spatial zoning/audit cases.
- `src/app/api/v1/lithic/ach/dispatch/__tests__/route.test.ts` — operator
  gate, validation, the fail-closed gate order (compliance before capability
  disclosure), not-configured 503 with zero outbound calls, success through
  `payoutFromVault`, honest failure propagation.
- `src/app/api/v1/lithic/cards/__tests__/route.test.ts` — the same discipline
  for Gold Note Card issuing.
- `src/app/api/v1/plaid/link-token/__tests__/route.test.ts` and
  `src/app/api/v1/plaid/bank-accounts/__tests__/route.test.ts` — creator
  session gates, validation, not-configured 503, mask-only success bodies.
- `src/app/api/v1/webhooks/stripe/__tests__/route.test.ts` — Stripe signature
  verification (valid passes, tampered 403, stale 400, unset secret
  fail-closed), malformed JSON, non-funding origins, unsupported currency,
  funding posting, and event replay deduplication.
- `src/modules/banking/__tests__/validation.test.ts` — the payload
  validators' value-level rules, including the full vertical enum.
