# Covnant

**Own Your Creation.** — the entertainment-rights and royalty-clearing
platform. Covnant registers creative assets across seven master verticals;
issues the identity layer (UCTs, CVT handles, CBT asset codes); reconciles
revenue from platform statements; settles royalties on a hash-chained
double-entry ledger with BigInt precision; and generates industry agreements
deterministically from registered asset data.

## Stack

- Next.js 15 (App Router, server actions, Turbopack) + React 19 + TypeScript +
  Tailwind CSS 4
- Vendored `CovenantMasterSDK` engine (`src/engine/covenant-master-sdk.ts`) —
  **do not edit**; all new behavior lives in adapters around it (see Engine
  vendoring below)
- Supabase (Postgres) persistence via `supabase/migrations/`, with an
  in-memory fallback when credentials are absent (`cp .env.example .env.local`)
- SQLite (`better-sqlite3`) as the secondary store — creator YTD earnings use
  atomic increments across Supabase/Postgres, SQLite, and in-memory stores
- Redis + BullMQ job queues (telemetry ingestion); `pino` structured logging;
  `prom-client` metrics
- npm workspace discipline: `package-lock.json` is the only lockfile
  (`packageManager` pins npm)
- Vitest (unit + integration), Playwright (e2e), GitHub Actions CI (four jobs)

## Architecture — three compute layers

One company, three kinds of compute, structurally prevented from blocking
each other. Full contract: [`docs/covenant-layers.md`](docs/covenant-layers.md).

- **UCT — User Context.** The synchronous surface: Next.js routes under
  `src/app/**` on Vercel functions. Sub-second request/response; heavy work is
  one `INSERT` into `royalty_recon_jobs` → `202`, never inline parsing.
- **CVT — Computer & Data Vision.** The background data work: standalone
  worker processes in-repo — `npm run worker:recon` (claim jobs, parse
  statements, write the match queue), `npm run worker:astra` (dashboard
  extraction sweeps), `npm run worker:telemetry` (BullMQ ingestion consumer).
  Never runs inside Vercel functions; never writes ledger tables directly.
- **CBT — Codebase & Architecture.** The unattended maintenance harness:
  an external CLI run by a human against the repo. Zero production runtime.

The UCT↔CVT import boundary is test-enforced
(`layers.boundary.test.ts`). Note: "CBT" names both this layer and the
product's asset-code family — that collision is intentional, neither gets
renamed.

## Vertical taxonomy

Seven master verticals — the canonical definition is
`src/lib/master/taxonomy.ts` (`GlobalEntertainmentCategory`, 29 atomic
sectors): Film & Television, Audio & Recorded Sound, Publishing & Literary,
Live Performance & Comedy, Sports & Athletics, Interactive & Digital Media,
and Commercial & Brand Licensing. Contract templates span all seven.

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
npm run test       # vitest unit suite
npm run lint
npm run typecheck  # both trees: src and covnant-sdk/
npm run build
```

The three CVT workers run standalone: `npm run worker:recon`,
`npm run worker:astra`, `npm run worker:telemetry`.

## Testing

- **Unit (vitest)** — `npm run test`. Tests are colocated
  (`__tests__/<name>.test.ts` next to the module); integration tests follow
  `route.integration.test.ts` and self-skip without
  `TEST_DATABASE_URL`/`REDIS_URL`.
- **E2E (Playwright)** — `npm run test:e2e` builds the production app
  (`next start`) and runs three projects sharing one seeded server:

  | Project | Viewport | Scope |
  |---|---|---|
  | `desktop-chrome` | 1280×720 | the whole suite (except the mobile smoke) |
  | `mobile-chrome` | 390×844 | the money path (`landing-signup.spec.ts`) + `e2e/mobile/` |
  | `mobile-chrome-compact` | 375×720 | the same phone-scoped specs |

  The phone projects emulate iPhone Safari explicitly (viewport, UA, touch,
  `isMobile`) on the Chromium engine CI installs.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs four jobs on every PR:

1. **verify** — lint → typecheck → unit tests → production build
2. **schema** — applies **every** migration to scratch Postgres, twice each
   (the second apply must be a clean no-op), then asserts contract-critical
   tables, columns, and check constraints
3. **identifier-engine** — integration + acceptance suites against real
   Postgres + Redis
4. **e2e** — Playwright against the production build

## Engine vendoring

`src/engine/covenant-master-sdk.ts` is the byte-for-byte vendored production
engine (v2.0.0). `src/engine/__tests__/vendored-sdk.test.ts` pins its SHA-256 —
CI fails if the file drifts. Engine upgrades require re-blessing the hash in
the same PR that vendors the new source.

Agents and contributors: read [`AGENTS.md`](AGENTS.md) before changing
anything — it is the operating contract (commands, migration rules, layer
boundaries, SDK naming law, test placement).
