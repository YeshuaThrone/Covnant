# Covenant MCP Harness

A Model Context Protocol server that exposes the vendored **CovenantMasterSDK
v2.0.0** (`src/engine/covenant-master-sdk.ts`) as MCP tools over stdio.

The engine file is vendored byte-for-byte and is **never modified** — this
harness is a thin adapter. Every tool maps 1:1 onto a public engine method.

## Run

```bash
npm install                  # installs @modelcontextprotocol/sdk, zod, tsx
npx tsx mcp/server.ts        # stdio transport — connect any MCP client
```

Configuration (all optional):

| Env var | Effect |
| --- | --- |
| `COVNANT_PLATFORM_FEE_PCT` | Platform fee fraction, e.g. `0.1` = 10% (default `0`) |
| `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Enables DB hydration for `lookup_asset` (engine falls back to in-memory) |

Type-check: `npx tsc -p mcp/tsconfig.json --noEmit`

## Tools

| Tool | Engine method | Purpose |
| --- | --- | --- |
| `register_asset` | `CovenantMasterSDK.registerCBTAsset` | Validate splits (exact 100%), generate a per-medium CBT code, register the asset |
| `lookup_asset` | `CovenantMasterSDK.getOrHydrateAsset` | Resolve by CBT code from memory, hydrating from Supabase when configured |
| `validate_splits` | `CovenantMasterSDK.validateSplits` | Check rights-holder splits total exactly 100.0000% (±1 at scale 10,000) |
| `settle_royalties` | `CovenantMasterSDK.processRoyaltySettlement` | BigInt proportional disbursement, platform fee, tax withholding, corner-dust, reconciliation |
| `tax_form_requirement` | `CovenantTaxEngine.DetermineTaxFormRequirement` | 1099-MISC / 1099-NEC / 1042-S / NONE for a tax profile at an earnings amount |
| `tax_effective_rate` | `CovenantTaxEngine.calculateEffectiveTaxRate` | Effective withholding rate (24% US backup / 30% foreign default, treaty override) |
| `audit_system` | `CovenantAuditorAgent.RunFullSystemAudit` | Full audit across registered assets and the royalty ledger |
| `register_platform_allowlist` | `CovenantGlobalSocialEngine.registerGlobalAllowlist` | Allowlist a platform account for a CBT code (ACTIVE/REVOKED, incentive share) |
| `process_social_claim` | `CovenantGlobalSocialEngine.processGlobalClaimEvent` | Process a social-platform match-claim (allowlist check, creator incentive, 10% social fee) |

Tool schemas are zod mirrors of the engine's own TypeScript interfaces
(`CovenantBlockAsset`, `SelfServeRightsHolder`, `RoyaltySettlementEvent`,
`TaxProfile`, `GlobalMatchClaimPayload`, `PlatformAllowlistRequest`), so the
harness drifts visibly — via type-check failure — if the engine surface ever
changes.

## MCP client configuration

```json
{
  "mcpServers": {
    "covnant-engine": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"],
      "cwd": "/path/to/covenant",
      "env": { "COVNANT_PLATFORM_FEE_PCT": "0" }
    }
  }
}
```
