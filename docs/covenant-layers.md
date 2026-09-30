# Covenant layers — UCT / CVT / CBT

One company, three kinds of compute: the sub-second user surface, the heavy
background data work, and the unattended maintenance harness — structurally
prevented from blocking each other. This page is the layer contract; the
import half of it is test-enforced by the guardrail in
`src/app/api/covnant/agent/register/__tests__/layers.boundary.test.ts`.

## Layer contract

|           | UCT — User Context                                                                                     | CVT — Computer & Data Vision                                                                                                              | CBT — Codebase & Architecture                                                 |
| --------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Runs**    | Vercel functions (Next.js routes)                                                                       | Standalone worker process, in-repo (`npm run worker:recon`), hosted where long-running processes live                                      | External CLI harness (Claude Code-style), launched by a human                  |
| **Engine**  | `claude-haiku-4-5` default, `claude-sonnet-4-5` escalation (env-overridable)                            | Deterministic code by default; vision/computer-use engine behind `RECON_VISION_*` env — flips on with a key + model ID, no code change     | Agent harness credentials; never a runtime dependency                          |
| **Contract**| Sync request/response, sub-second; heavy work → one `INSERT` into `royalty_recon_jobs` → 202, return     | Claim jobs (`FOR UPDATE SKIP LOCKED`), parse, write `match_queue`, mark result, pg_net webhook → UCT                                       | Repo maintenance, migrations across the Supabase schema, long test suites      |
| **Never**   | No inline parsing, no model fan-out, no dashboard automation in a request cycle                         | Never runs inside Vercel functions; never writes to ledger tables directly                                                                 | No imports from `src/app/**`; zero runtime exposure in production              |

## Hosting

- **UCT** — Vercel functions. Synchronous routes only; a heavy request is
  refused at the design level, not throttled at runtime.
- **CVT** — a dedicated long-running worker host, **decision pending**. The
  leading option is a GitHub Actions scheduled worker (recon is batch, not
  realtime), upgrading to an always-on host (Railway/Fly) when interactive
  dashboard work needs a browser runtime. The worker ships in-repo either way
  and never runs inside a Vercel function.
- **CBT** — no host at all: an external CLI harness launched by a human
  against the repo. It has no runtime footprint in production, and nothing
  under `src/app/**` may import from it.

## Import boundary (test-enforced)

`src/app/**` never imports `src/workers/**`, and `src/workers/**` never
imports `src/app/**`. The guardrail test walks both import graphs from source
and goes red the moment a lane reaches into the other.

## Engine IDs — "Claude 3.5" means the deployed 4.5 IDs

The UCT registration agent runs `claude-haiku-4-5-20251001` (default) with
`claude-sonnet-4-5-20250929` escalation, selected via `AGENT_MODEL` /
`AGENT_MODEL_ESCALATION`. Founder directives that say "Claude 3.5" map to
these deployed 4.5 IDs — the 3.5 model IDs are retired at Anthropic
(`not_found_error` on every variant, verified live against the founder's key
during PR #75 wiring). The code fallbacks carry the same 4.5 IDs, so a lost
env var degrades to a working model, never a 500.

## CVT engine posture — deterministic-first

CSV/TSV statement parsing and rate math are plain code — zero model tokens.
The vision/computer-use engine exists only as an env-gated seam
(`RECON_VISION_*`) for PDF/image formats; with no engine configured, a
non-tabular job fails honestly with a named error, never a partial parse. No
OpenAI key exists in the workspace today, so the seam is off by default.

## Naming collision — CBT means two things, on purpose

- **Product noun:** CBT asset codes — `cbt_assets.cbt_code`, the catalog
  identifier the recon engine matches statements against. In use as-is; **do
  not rename**.
- **Layer acronym:** CBT (layer) — the Codebase & Architecture maintenance
  harness described above.

Docs say "CBT (layer)" when the harness is meant. Neither gets renamed.
