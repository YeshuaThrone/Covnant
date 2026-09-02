# Covnant Platform — Acceptance Report

**Verdict: the pinned production-build spec (§1–§8, art_zXNe0LQJ head `40bc82fd`) is satisfied.** All four PRs merged to `main`; the release sweep verified every acceptance criterion against `main` as merged, with the full Playwright suite, Vitest suite, lint, typecheck, production build, and scratch-Postgres schema verification green.

| # | Spec acceptance criterion | Evidence | Status |
|---|---|---|---|
| 1 | **Engine & SDK** — vendored CovenantMasterSDK is byte-for-byte protected (SHA-256 `9c3bda6a…` tripwire), portable, and the CBT identity is round-trip stable | `tests/sdk.vitest.ts` (Vitest), tripwire `npm run verify:engine` | ✅ |
| 2 | **Deep Onyx brand** — CV ribbon monogram on the shell nav, landing, and favicon; gradient H1 "Own Your Creation."; `#0D0F12` shell; **zero Bluesy artifacts** repo-wide (retired name, "AI assistant", retired pricing-tier copy) | `e2e/brand.spec.ts` (monogram on shell + landing, body background, favicon, repo-wide scan) | ✅ |
| 3 | **Multi-pool engine & Asset Studio** — Save enables only when all three independently validated pools read exactly 100.0000%; deterministic integer-unit weighting; identifier pills (ISRC/ISWC/EIDR + CVT display code) on the asset detail | Vitest pool-edge cases in PR 2 (pool at 99.9999% rejected, equal-4×25, irregular rounding); E2E `e2e/asset-studio.spec.ts` (Save disabled at one pool, still disabled at two, enabled exactly at three 100.0000% pools; pills asserted on the detail page) | ✅ |
| 4 | **Contract Vault** — 14 deterministic templates under two industries; asset-of-record hydration from stored pools; draft → immutable FINAL; export | Vitest generator/round-trip/audit tests in PR 3; E2E `e2e/contract-vault.spec.ts` (14 template cards, industry tabs, Split Sheet generated from a registered asset with holder hydration, Save draft → Mark final → `/export` HTTP 200 with holders in the document) | ✅ |
| 5 | **Universal Royalty Ledger & settlement** — single idempotent `settleRoyalty` transaction; platform splits by allowlist (85/15 default); 10% covenant fee; corner dust to the platform wallet; withholding; deterministic synthetic transaction IDs | Vitest `tests/settlement-tax.vitest.ts` (over-invoiced royalty rejected, idempotent replay, platform split, corner-dust, EUR conversion, ledger totals) | ✅ |
| 6 | **Tax rules** — W8BEN exemption; W9 and EIN below the $600 threshold with `$0` tax rows; mixed-currency rounding by integer units; payout-rail validation (IBAN, SWIFT, PayPal) | Vitest `tests/settlement-tax.vitest.ts` (exempt/BUSINESS_SOURCE, $1,000 W9, $500 EIN, cross-currency) | ✅ |
| 7 | **Persistence & webhook** — Supabase Postgres via migrations with in-memory fallback; SDK singleton; claims webhook route validated | Vitest `tests/platform.vitest.ts` + `tests/webhook-route.vitest.ts`; CI `schema` job applies both migrations to scratch Postgres and asserts the engine's exact columns (`universal_royalty_ledger`: `transaction_id`, `cbt_code`, `platform`, `gross_settled`, `covenant_fee`, `corner_dust_collected`, `currency`, `disbursements`, `created_at`; `cbt_assets`; `platform_allowlists`; `contracts`) | ✅ |
| 8 | **Release & CI** — all PRs CI-green with the Obvious footer on every PR body; `main` green across three jobs (verify: lint/unit/build · schema · e2e) | CI runs on PRs 1–4 (footers verified); `main` run [33684935840](https://github.com/YeshuaThrone/Covnant/actions/runs/33684935840) — verify + schema + e2e all green at head `b4deb8d` | ✅ |

## Verification summary

- **Vitest: 42/42** across five suites (vendored SDK, platform/persistence, splits, settlement-tax, claims webhook route).
- **Playwright: 6/6** on `main` (brand, Bluesy-absence, multi-pool gate, identifier pills, vault template list, vault flow) against the production build.
- **Lint / typecheck / production build:** clean.
- **Engine tripwire:** vendored `gemini-code-1787976937198_2.ts` unmodified (`9c3bda6a…`).

## Known engine quirks (documented, not blocking)

The engine's in-file example under-charges withholding tax by a factor of 100 relative to its own stated percentages, and its per-event 1099 threshold diverges from the annual $600 threshold implemented per the spec. Both are documented in PR 4 and in test comments; the implementation follows the spec (and general US practice). Amending these requires an engine amendment and re-blessing from the engine owner.

## Scope boundary (per spec §8)

Authentication and raw tax-ID collection are intentionally out of scope for v1. The web app trusts the sandbox's local session; production hardening is a v2 concern.
