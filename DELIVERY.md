# Covnant — Local Delivery Manifest

**Date:** 2026-09-02 · **Branch:** `feat/brand-schema-sdk` (local, 5 commits) · **GitHub delivery:** parked per your instruction — nothing has been pushed.

## What is on disk

Everything lives in this working tree (`/home/user/work/covenant`):

| Deliverable | Location | State |
| --- | --- | --- |
| Next.js 15 + Tailwind 4 + TypeScript scaffold (ES2020) | `.`, `src/app` | ✅ lint + build green |
| GitHub Actions CI (lint → test → build) | `.github/workflows/ci.yml` | ✅ committed |
| Brand shell — Deep Onyx, Electric Blue/Metallic Gold tokens, CV ribbon monogram, "Own Your Creation." hero | `src/app/*`, `src/components/brand/*`, `src/lib/brand.ts` | ✅ committed |
| Covenant SQL schema — `cbt_assets`, `universal_royalty_ledger`, `platform_allowlists` | `supabase/migrations/0001_covenant_init.sql` | ✅ committed |
| In-memory/Supabase data-source switch | `src/lib/data-source.ts`, `.env.example` | ✅ committed |
| **CovenantMasterSDK v2.0.0 engine, vendored byte-for-byte** | `src/engine/covenant-master-sdk.ts` | ✅ hash-verified `9c3bda6a…`, tripwire test passes |
| Unit tests — engine smoke, split validation, tax rates, hash integrity, brand tokens, data-source switch | `src/engine/__tests__/`, `src/lib/__tests__/` | ✅ 10/10 pass |
| **MCP harness — 9 tools exposing the engine over stdio** | `mcp/server.ts`, `mcp/tsconfig.json`, `mcp/README.md` | ✅ type-check pass, boots clean |
| Production build | `.next/` (regenerate with `npm run build`) | ✅ 5 static pages |

## Verification (local, this tree)

- `npm run lint` — clean
- `npm run test` — 10/10 pass, including the SHA-256 byte-identity tripwire on the vendored engine
- `npm run build` — Next 15.5.25 production build green
- `npx tsc -p mcp/tsconfig.json --noEmit` — harness type-check pass
- `npx tsx mcp/server.ts` — boots, banner: engine ready, in-memory persistence

## Run it locally

```bash
npm install
npm run dev        # http://localhost:3000 — Deep Onyx shell, hero, monogram
npm run test       # unit suite
npx tsx mcp/server.ts   # MCP harness (stdio)
```

## Git state

- `main` = scaffold commit `2c7fb61` (CI workflow included)
- `feat/brand-schema-sdk` = main + brand shell + schema/data-source + vendored engine + monogram favicon (commits `8020308`, `299ff29`, `3bf5263`, `bba2e32`)
- Nothing pushed. When GitHub access is resolved, delivery resumes with:
  `git push origin main && git push origin feat/brand-schema-sdk`, then PR 1 from the branch.

## Parked work (approved DAG, awaiting GitHub access)

- PR 2 · Multi-pool split engine & asset studio
- PR 3 · Fourteen-template contract vault
- PR 4 · Ledger, settlement, tax & verification
- Release · Cross-PR E2E & acceptance sweep
