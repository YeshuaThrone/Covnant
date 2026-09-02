# Covnant

**Own Your Creation.** — Automated Contract Vault & Smart Ledger Verification.

Covnant registers creative assets ("Covenant Block" assets) across music, film/TV,
publishing, games, and emerging media; manages rights holders and royalty splits;
settles royalties with BigInt precision; and generates industry agreements
deterministically from registered asset data.

## Stack

- Next.js (App Router, server actions) + TypeScript + Tailwind CSS
- Vendored `CovenantMasterSDK` engine (`src/engine/covenant-master-sdk.ts`) — **do not edit**;
  all new behavior lives in adapters around it. Integrity is enforced by test.
- Supabase persistence (`supabase/migrations/`) with an in-memory fallback when
  credentials are absent (`cp .env.example .env.local`)
- Vitest unit tests; GitHub Actions CI (lint → test → build)

## Develop

```bash
npm install
npm run dev        # http://localhost:3000
npm run test       # vitest
npm run lint
npm run build
```

## Engine vendoring

`src/engine/covenant-master-sdk.ts` is the byte-for-byte vendored production
engine (v2.0.0). `src/engine/__tests__/vendored-sdk.test.ts` pins its SHA-256 —
CI fails if the file drifts. Engine upgrades require re-blessing the hash in
the same PR that vendors the new source.
