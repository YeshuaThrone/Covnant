# AGENTS.md — repo contract

The rules every coding agent (and human) must follow when changing this repo.
Architecture background lives in `README.md` and `docs/covenant-layers.md`; this
file is the operating contract.

## Commands

npm only. Never introduce another package manager (see Lockfile).

```bash
npm ci                                  # install (CI uses this too — lockfile must match package.json)
npm run dev                             # Next.js dev server (Turbopack), http://localhost:3000
npm run lint                            # eslint — must end with 0 errors
npm run typecheck                       # tsc --noEmit && tsc --noEmit -p covnant-sdk  (BOTH trees)
npm run test                            # full vitest unit suite (~1–2 min)
npm run test:e2e                        # Playwright e2e (builds + starts the production server)
npm run worker:recon|worker:astra|worker:telemetry   # the three CVT worker processes
```

## Required local gates before every push

1. `npm run test` — full vitest suite green.
2. `npm run lint` — zero errors.
3. `npm run typecheck` — clean across both trees.

CI additionally runs the Playwright e2e suite and the schema job (every
migration applied twice to scratch Postgres). Local gates are the primary
gate; CI is the final gate.

## Lockfile — single source

`package-lock.json` is the only tracked lockfile; npm is the only blessed
package manager (`packageManager` field pins the version). `bun.lock`,
`bun.lockb`, `yarn.lock`, and `pnpm-lock.yaml` are git-ignored — never commit
them. If `npm ci` and `package.json` disagree, fix the lockfile with
`npm install` before pushing.

## Migrations — supabase/migrations/

Raw SQL files named `NNNN_description.sql`, applied in lexical (version) order.
There is no drizzle, ORM generator, or snapshot in this repo — schema changes
are hand-written SQL migrations.

- **Never edit an already-applied migration.** Add a new numbered file.
- **Every migration must be idempotent.** CI applies every file **twice**
  under `ON_ERROR_STOP=1`; the second apply must be a clean no-op.
- Migrations `0003`+ assume the Supabase environment (`auth.users`,
  `auth.uid()`, the `authenticated`/`service_role` roles). CI provides a
  **test-only auth shim** immediately before `0003` — never ship the shim as
  a migration.
- New DDL must be reflected in the `schema` CI job's assertions when it adds
  contract-critical tables/columns (see `.github/workflows/ci.yml`).

## Layer boundaries — UCT / CVT / CBT (test-enforced)

Full contract: `docs/covenant-layers.md`.

- **UCT** (User Context) — synchronous Next.js routes under `src/app/**`,
  deployed as Vercel functions. No inline parsing, no model fan-out, no
  dashboard automation inside a request cycle. Heavy work is one `INSERT`
  into `royalty_recon_jobs` → `202`.
- **CVT** (Computer & Data Vision) — the standalone worker processes
  (`src/workers/`): `recon` (claim → parse → match queue), `astra`
  (dashboard extraction sweeps), `telemetry` (BullMQ ingestion consumer).
  Never runs inside Vercel functions; **never writes to ledger tables
  directly**.
- **CBT** (Codebase & Architecture) — the external, human-launched CLI
  harness. Zero runtime exposure in production.
- **Import law (guardrail test-enforced):** `src/app/**` never imports
  `src/workers/**` and `src/workers/**` never imports `src/app/**`. The
  test (`src/app/api/covnant/agent/register/__tests__/layers.boundary.test.ts`)
  walks both import graphs — keep it green.
- **Naming collision, on purpose:** "CBT" is both the layer acronym and the
  product's asset-code family (`cbt_assets.cbt_code`). Neither gets renamed.
  Docs say "CBT (layer)" when the harness is meant.

## SDK naming law — `covnant-sdk/` vs `src/covenant-sdk/`

Two live trees with two spellings, both intentional. Check the spelling before
touching either.

| | `covnant-sdk/` (repo root) | `src/covenant-sdk/` |
|---|---|---|
| Identity | **Universal Royalty Collection SDK** — collection nodes, statement parsers, MUL clearance, match, recovery, luminate | The in-app collection layer — facade, connectors, dispute/distribution/fx, identifiers, MCP tools |
| Imported as | relative path (`../../../covnant-sdk`) | alias `@/covenant-sdk` |
| Typechecked | `tsc --noEmit -p covnant-sdk` (own tsconfig) — part of `npm run typecheck` | main tsconfig |
| `agent-prep.ts` | the clean re-entry of the 2026-09-13 Gemini mission payload — **byte-pinned** by its test | the mission **config** type (`COVENANT_AGENT_PREP`) — different content entirely |

The two `agent-prep.ts` files share a filename, not content. That is not a
duplicate to merge. Collection-node/parser/MUL work belongs in `covnant-sdk/`;
app-facing collection surfaces belong in `src/covenant-sdk/`.

## Vendored engine

`src/engine/covenant-master-sdk.ts` is the byte-for-byte vendored production
engine (v2.0.0). **Do not edit it.** Its SHA-256 is pinned by
`src/engine/__tests__/vendored-sdk.test.ts` — CI fails on drift. All new
behavior lives in adapters around the engine. Engine upgrades vendor the new
source and re-bless the hash in the same PR.

## Test placement

- **New unit tests** go colocated: `__tests__/<name>.test.ts` next to the
  module under test (the dominant convention — app routes, lib, workers).
- Sibling `<name>.test.ts` files (`src/covenant-sdk/`, some components and
  routes) are legacy-accepted: do not move them, do not add new ones.
- **Integration tests** follow `route.integration.test.ts` under `__tests__/`
  and require real services — they self-skip without `TEST_DATABASE_URL` /
  `REDIS_URL` and run in CI's `identifier-engine` job (Postgres + Redis).
- **E2E** lives in `e2e/*.spec.ts` (Playwright; the mobile smoke in
  `e2e/mobile/`). Layout details: `README.md` → Testing.

## PR conventions

- Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`,
  `refactor:`).
- Squash-merge (`--squash`) — the repo's only merge method.
- PR body carries `## Why` / `## What` / `## How to Review` (plus the Obvious
  footer when the platform requires it).
- Docs/config-only changes may merge on green CI without a human review;
  source changes need review before merge.
- Never push to `main` directly; never force-push to `main`.
