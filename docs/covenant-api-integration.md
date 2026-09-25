# Covenant API Integration — Landing Note

**Branch:** `feat/covenant-api-integration` (local only — never pushed, no PR, no deploy)
**Landed through:** `eb539cb` (7 commits off base `02cfccd`)
**Vendor source:** EmeraldVal PR #41 — *feat: Covenant SDK + MCP tools for every Don Engine and collection API*
**Vendor head:** `c754bb40a6fdc6b8bc3f7dd176ee90953fcc9403` (branch `cursor/covenant-sdk-agent-prep-2638`) — read-only; EmeraldVal is never merged, modified, or pushed.
**Spec:** Obvious blueprint *Covenant API Integration — Landing the 26-Tool MCP Next to the Covnant Backend* (art_XDKkJF5U); research map art_rjAaNhss.

This note records what landed, the one adaptation law, how to run the surfaces, the verification gate results at the final head, and the decisions that remain with the founder. No feature code landed in D4 — this note is the deliverable.

---

## 1. What landed

The founder's Covenant API — built in Cursor inside the EmeraldVal repo — vendored into the Covnant repo and adapted to Covnant's async backend:

- **D1** — `src/covenant-sdk/**` (Covenant SDK core: facade, registry, manifest parsing, distribution, connectors, sweeper, splits, dispute, split-ledger, FX, audit-proof, outbound webhook, routes logic, MCP tool host), `src/queues/sweepQueue.ts`, `src/lib/server/covenantRegistry.ts`, and the one net-new module `src/modules/webhooks/{baas,dsp}.ts`.
- **D2** — `src/mcp/{types,catalog,host,don-tools,covenant-mcp-server}.ts`: the 26-tool stdio MCP server, dispatching into Covnant's existing async modules.
- **D3** — the four net-new routes under `src/app/api/v1/`: `works` (POST/GET) and the three sweepers (`sweeper`, `sweeper/async`, `sweeper/luminate`), each a thin Next handler over the already-landed `src/covenant-sdk/routes/*` logic.
- **D4** — this note and the verification gate below. No feature code.

One engine law enforced throughout: **the MCP layer and routes rewire to Covnant's existing async modules and its 72-method async Store** — no duplicate sync engines landed next to the async body (no-parallel-arithmetic law).

## 2. The commit list (`02cfccd..eb539cb`)

| Commit | One line |
|---|---|
| `d63618e` | Land Covenant SDK core, sweep queue, and registry (`src/covenant-sdk/**`, `src/queues/sweepQueue.ts`, `src/lib/server/covenantRegistry.ts`) — store-free vendor body, byte-identical. |
| `9a4d028` | Land BaaS/DSP webhook module as delegation shims to the canonical ingestors in `src/lib/server/webhooks.ts`. |
| `a9eea7b` | Fix the delegation boundary: pass the normalized payload into the canonical ingestor (the shim had handed through the raw body). |
| `9d640f5` | Scope the lint brand guard off the byte-identical vendor drop so vendor tokens can lint clean without touching vendor bytes. |
| `039c474` | Land the 26-tool MCP layer on the async Store: `src/mcp/**`, net-new async `src/modules/ledger/audit.ts`, the `mcp`/`covenant-mcp` scripts, superseded note in `mcp/README.md`. |
| `1c53c7a` | Allow the vendored `covenant-sdk` path and registry name in guarded files (brand-guard allowlist for files that import vendor tokens). |
| `eb539cb` | Land the four net-new Covenant `/api/v1` routes (works POST/GET; sweeper; sweeper/async; sweeper/luminate) with their route tests. |

## 3. The async seam

EmeraldVal's `src/lib/server/store.ts` is ~60 **fully-synchronous** methods over one `SqliteStore` (better-sqlite3). Covnant's file at the same path is the canonical **72-method async** contract — SupabaseStore in production, SQLite dev/test, and `getStore()` throwing `supabase_not_configured` when env is unset.

The adaptation happens at **one place: the dispatch boundary**. Both entry surfaces — the stdio MCP (`src/mcp/don-tools.ts`) and the four HTTP routes — await Covnant's async modules and Store. `src/mcp/don-tools.ts` is the only file where the sync→async edit is deep (every store and module call is awaited); everything else inherits the async body untouched. The two engines keep their own failure shapes across the seam:

- **Inside MCP:** `{ok:false, code, message}` (`mcpErr`).
- **On the wire:** `{error, code}` via `donJsonError` (envelope-identical to the PR's helper). The house `jsonError` is untouched — existing tests assert its exact body.

If Supabase env is unset, `getStore()` throws `supabase_not_configured` **before any query** — the console's fail-closed ladder, inherited for free.

## 4. Byte-identical vs adapted

**Byte-identical (vendor bytes, verified by hash against the vendor tree / unchanged at the gate):**

- `src/covenant-sdk/**` core — including `mcp-tools.ts` (the 7 Covenant tools + `CovenantMcpToolHost`), `mcp-registry.ts`, `routes/{app,routers,result,works,sweep-direct,sweep-async,luminate}.ts`
- `src/lib/server/covenantRegistry.ts`
- `src/queues/sweepQueue.ts`
- `src/mcp/types.ts`, `src/mcp/catalog.ts`, `src/mcp/covenant-mcp-server.ts` (the stdio server — the founder's contract, byte for byte)

**Adapted (landing decisions, each rationale below or in §6):**

- `src/mcp/don-tools.ts` — the seam: every store/module call awaited against the async contract.
- `src/mcp/host.ts` — lazy Don-host construction (deviation b).
- `src/modules/webhooks/{baas,dsp}.ts` — delegation shims (deviation a).
- `src/modules/ledger/audit.ts` — net-new async module extending the journal/chain helpers (deviation c).
- `eslint.config.mjs` — brand-guard scoping + allowlist (deviation d).
- The four route files — Next handlers over the SDK route logic using `donJsonError` and the house rate limiter (deviation e).

**Untouched canonical files:** `src/lib/server/{store,http,rateLimit,plaid,udrSplits}.ts` are never overwritten — the MCP imports them as-is. Hash-verified unchanged against `02cfccd` at the gate (§5).

## 5. Verification gate — actual results at `eb539cb`

| # | Check | Result |
|---|---|---|
| 1 | `npm test` (vitest run) | ✅ **155 test files passed, 1896/1896 tests passed**, exit 0 (10.23s) |
| 2 | `npm run typecheck` (`tsc --noEmit && tsc --noEmit -p covnant-sdk`) | ✅ Root **clean** (the `&&` chain proceeded); covnant-sdk project shows **exactly the 3 pre-existing errors** — `src/lib/splits/shared.ts` (67,3) TS2322 LIVE_EVENT, (67,17) TS2322 GARMENT_LINE, (86,3) TS2353 LIVE_EVENT. Known out-of-scope set; never fixed here. |
| 3 | `npm run lint` (eslint) | ✅ **0 errors, 4 warnings** — all 4 pre-existing in untouched files: `covnant-sdk/src/nodes/sandbox-nodes.test.ts:164` (`_currency` unused), `src/lib/contracts/store.ts:30` and `src/lib/sdk.ts:17,19` (unused eslint-disable directives). |
| 4 | `npm run build` (next build) | ✅ Exit 0. All four new routes in the manifest: `/api/v1/works`, `/api/v1/sweeper`, `/api/v1/sweeper/async`, `/api/v1/sweeper/luminate`. |
| 5 | Untouchable hash comparison vs `02cfccd` | ✅ sha256 MATCH: `src/engine/covenant-master-sdk.ts`, `src/lib/don/splitEngine.ts`, `src/modules/don/dust.ts`, `covnant-sdk/**` (tree diff: 0 lines), `src/lib/server/{store,http,rateLimit,plaid,udrSplits}.ts`, `package-lock.json`, `src/components/admin/types.ts` (the `CONSOLE_TABS` registry — 12 tabs). `package.json` differs **only** by the two spec-sanctioned `mcp`/`covenant-mcp` scripts (3 insertions, 1 comma) — no dependency changes. |
| 6 | Admin console unaffected | ✅ Dev server boots (Ready in 2.6s, `GET /` 200). Unauthenticated `/admin` serves the fail-closed login gate (the console does not advertise itself). Authenticated with `ADMIN_DASHBOARD_PASSWORD`: HTTP 200, **all 12 `CONSOLE_TABS` render** (Overview, Creators, UCT Registry, Ledger, Contracts, Tax, Control Board, Analytics, Intelligence, Creator Analytics, Allowlists, Operations), zero app-error mentions. |

**MCP live probe (stdio, no env):** `npm run mcp` boots — `serverInfo: emeraldval-api-mcp-server 2.0.0`. `tools/list` returns **exactly 26 tools**: 19 Don (`plaid_kyc`, `plaid_exchange`, `splits_calculate`, `recoupment_upsert`, `recoupment_get`, `splits_reverse`, `webhooks_ingest`, `webhooks_baas`, `webhooks_dsp`, `vaults_list`, `vaults_release`, `vaults_payout`, `vaults_dispute_lock`, `ledger_log`, `ledger_audit`, `baas_ach`, `baas_rtp`, `withholding_apply`, `withholding_get`) + 7 Covenant (`register_work_manifest`, `list_work_manifests`, `trigger_blackbox_sweep`, `trigger_blackbox_sweep_async`, `trigger_luminate_sweep`, `query_audit_proof`, `get_channel_unclaimed_metrics`). A Don call (`vaults_list`) with no env returns `isError: true` with payload `{ok:false, code:"store_failure", message:"supabase_not_configured: …"}` — fail-closed before any query.

## 6. The five accepted deviations (with rationale)

**(a) Webhooks landed as delegation shims to the canonical ingestors** (`src/lib/server/webhooks.ts`), not as copies of the PR's ingestion bodies. Covnant already carries the canonical async ingestors (`ingestBaasWebhook`, `ingestDspWebhook`, idempotent by `event_id`); landing the PR's sync bodies would duplicate the engine and split idempotency across two implementations. The shims keep the PR's `@/modules/webhooks/*` import path so the MCP's module ecosystem resolves unchanged, and delegate to the canonical functions. One follow-up fix (`a9eea7b`) normalized the payload at the delegation boundary so the canonical ingestor receives the shape it expects.

**(b) Lazy Don-host construction in `src/mcp/host.ts`.** The drop constructs `DonMcpToolHost` eagerly in the constructor — safe under EmeraldVal's lazy SQLite Store, but under Covnant's fail-closed `getStore()` (which throws `supabase_not_configured` when env is unset) it would crash server boot. The Don host is instead built on first use: the byte-locked stdio server boots and lists all 26 tools with no env, and every Don tool call still fails closed before any query. The Covenant host keeps eager construction (it needs no Store).

**(c) Net-new async `src/modules/ledger/audit.ts`.** Covnant's module tree had no audit module for the MCP's `ledger_audit` tool to call. Rather than vendor the PR's sync module, the audit engine landed as an async-from-birth module extending the existing `journal.ts`/`chain.ts` helpers (hash chain, double-entry checks) — one ledger audit implementation, native to the async body.

**(d) Lint brand-guard scoping/allowlist for vendored tokens.** Covnant's brand guard flags non-Covnant product tokens; the byte-identical vendor drop legitimately contains them (`covenant-sdk` paths, the `emeraldval-api-mcp-server` server name). The rule was scoped off the vendor drop (`9d640f5`) and the vendored path/registry name allowed in the guarded files that import vendor tokens (`1c53c7a`) — so vendor bytes stay untouched and lint stays clean, instead of editing byte-locked files to appease the linter.

**(e) House rate-limit keying — 30/min/IP shared buckets instead of the PR's per-route buckets.** The PR keys each route's limiter by its own bucket; Covnant's existing `checkRateLimit` keys by client IP against a shared 30/min window. The four new routes adopt the house limiter so the whole `/api/v1` surface has one limiter implementation, one 429 contract (`{error:"rate_limited"}`), and uniform behavior — verified by the route tests (31st request in a minute → 429).

## 7. How to run the surfaces

**MCP (stdio):**

```bash
npm run mcp            # alias: npm run covenant-mcp
# = npx tsx src/mcp/covenant-mcp-server.ts
```

Boots **without any env** (verified above): it starts, handshakes, and lists the 26 tools. Registry-only Covenant tools (`register_work_manifest`, `list_work_manifests`, `query_audit_proof`, `get_channel_unclaimed_metrics`, and the sweep triggers) work in-process against `CovenantMcpRegistry`. Don tools that touch the Store fail closed until Supabase env is configured: `{ok:false, code:"store_failure", message:"supabase_not_configured: …"}`.

**Four HTTP routes** (thin Next handlers over `src/covenant-sdk/routes/*` logic; failures in the `{error, code}` envelope via `donJsonError`; rate limit 30/min/IP; no auth — matching today's `/api/v1` surface):

| Route | Success | Failures |
|---|---|---|
| `POST /api/v1/works` | **201** `{ok:true, work, codeCount}` | 400 `malformed_body`; 422 validation; 409 `work_exists` (duplicate); 429 `rate_limited` |
| `GET /api/v1/works` | **200** `{ok:true, works:[…]}` | — |
| `POST /api/v1/sweeper` | **200** `{ok:true, jobId, recoveredRevenueCents, matchesFound, disputes}` (inline sweep) | 400 `malformed_body` |
| `POST /api/v1/sweeper/async` | **202** `{ok:true, jobId, status:"drained", …}` (enqueue + drain inside the request) | 400 `malformed_body` |
| `POST /api/v1/sweeper/luminate` | **200** `{ok:true, …, recordsIngested}` | 400 `malformed_body` |

All four routes share the already-landed SDK route logic — the handlers themselves are the only Next-pinned code.

## 8. The test story

**1896/1896 tests across 155 files** at `eb539cb` — zero regressions. Composition: the pre-existing Covnant lineage (admin console, ledger, contracts, SDK parsers, banking, analytics, …) plus the landed suites. The new suites cover:

- **`src/covenant-sdk/**`** — engines (`covenant-engine`, `engines`), CWR/DDEX connectors + clearance, the universal blackbox sweeper, external-data connectors (Luminate/Jaxsta normalizers), the routes mount table (`routes/app`), outbound webhook dispatch, and the agent-prep / production-pipeline surfaces.
- **`src/modules/webhooks/{baas,dsp}.test.ts`** — the delegation shims: idempotent ingestion through the canonical ingestors, normalized payloads at the boundary, fail-closed provider behavior.
- **`src/modules/ledger/__tests__/audit.test.ts`** — the net-new async audit engine over the journal/chain helpers.
- **`src/mcp/__tests__/host.test.ts`** — the 26-tool host: Don vs Covenant dispatch (`isDonMcpTool`), lazy Don-host construction, injectable store/registry/engine.
- **`src/app/api/v1/works/route.test.ts`** — 201 first registration, 409 duplicate, 400 malformed, 422 invalid manifest, 429 rate limit, GET listing.
- **`src/app/api/v1/sweeper/route.test.ts`** — direct sweep 200, async sweep 202 `status:"drained"` with a subsequent MCP `query_audit_proof` round-trip, luminate 200, 400 malformed.

Tests inject `setStore()`/`InMemoryStore` (async-aware), so every store-touching suite runs against the async contract.

## 9. Accepted-by-design: process-local state

As specified, three state singletons are process-local in the sandbox design — not silent drift, but named founder decisions (§10):

- `CovenantMcpRegistry` — in-memory `Map`s (works, proofs, matches, disputes, payouts, clearances).
- `SandboxSweepQueue` — an in-memory array, drained inside the `sweeper/async` request (202 `status:"drained"`); not durable, not actually asynchronous.
- The rate-limit buckets — in-memory, per-process, reset on restart.

## 10. Named gaps for the founder — decisions, not build items

1. **Auth on the new routes.** The four routes are unauthenticated like the rest of `/api/v1`, rate-limited 30/min/IP. Acceptable for the sandbox; production needs a decision before exposure.
2. **Queue durability.** The in-memory, drained-in-request sweep queue is sandbox-adequate. Durable multi-instance operation needs a real queue (the PR's own comments name BullMQ as the eventual stand-in).
3. **Old 9-tool `mcp/` harness.** Superseded by the 26-tool server; a one-line note now points readers at `src/mcp/`. Deletion stays the founder's call.
4. **Push/PR timing.** The branch is local-only at `eb539cb`, gate green. Push as a PR when the founder says so — nothing is pushed, merged, or deployed without them.
