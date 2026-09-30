/**
 * The recon enqueue route's import boundary (spec art_7M0snhxc, verification
 * row 3) — a structure test that walks the route's RUNTIME import graph from
 * source and asserts no heavy-work module is reachable:
 *
 *   - anything under src/workers/** (the CVT worker lane — PR #78's
 *     bidirectional layers guardrail pins the repo-wide rule; this walk
 *     pins the enqueue route's side of it: isolation is the product),
 *   - the agent's model client (src/lib/agent/modelClient — no model call
 *     may ride a recon enqueue),
 *   - the vendored engine (engine/covenant-master-sdk.ts),
 *   - the Don ledger write path (lib/ledger/store — the recon queue never
 *     touches ledger tables directly),
 *   - next/cache (write-adjacent).
 *
 * `import type` statements are STRIPPED before walking: they are erased at
 * compile time and contribute nothing to the runtime graph. That strip is
 * the soundness argument, not an escape hatch — a runtime import cannot
 * hide in a type-only statement.
 */
import { existsSync } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROUTE_FILE = path.resolve(__dirname, '../route.ts');
// __tests__ sits six levels below src/ (src/app/api/covnant/recon/jobs/__tests__).
const SRC_ROOT = path.join(__dirname, '..', '..', '..', '..', '..', '..');

/**
 * Heavy-work modules the enqueue route's graph must never reach. The store
 * FACADE (lib/server/store) and the three backends it constructs are the
 * sanctioned write path — reachable by design; engines, parsers, workers,
 * the ledger store, and Next cache are not.
 */
const BANNED = [
  '/workers/',
  'modelClient',
  'engine/covenant-master-sdk',
  'ledger/store',
  'next/cache',
] as const;

function stripTypeOnlyImports(source: string): string {
  return source.replace(/import\s+type\s+[\s\S]*?from\s*['"][^'"]+['"]\s*;?/g, '');
}

function runtimeImportSpecs(source: string): string[] {
  const stripped = stripTypeOnlyImports(source);
  const specs: string[] = [];
  const patterns = [
    /import\s+[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]/g,
    /export\s+[\s\S]*?from\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) {
      specs.push(match[1] as string);
    }
  }
  return specs;
}

function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('@/')) return null;
  const base = spec.startsWith('@/')
    ? path.join(SRC_ROOT, spec.slice(2))
    : path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isBanned(target: string): string | null {
  for (const banned of BANNED) {
    if (target.includes(banned)) return banned;
  }
  return null;
}

function walk(entry: string): { reached: Set<string>; violations: string[] } {
  const reached = new Set<string>();
  const violations: string[] = [];
  const queue: string[] = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (reached.has(file)) continue;
    reached.add(file);
    const banned = isBanned(file);
    if (banned && file !== entry) {
      violations.push(`${file} is reachable via banned module "${banned}"`);
      continue;
    }
    const source = readFileSync(file, 'utf8');
    for (const spec of runtimeImportSpecs(source)) {
      const bareHit = isBanned(spec);
      if (bareHit && !spec.startsWith('.') && !spec.startsWith('@')) {
        violations.push(`${file} imports banned bare module "${spec}"`);
        continue;
      }
      const resolved = resolveSpec(file, spec);
      if (resolved) queue.push(resolved);
    }
  }
  return { reached, violations };
}

describe('recon enqueue import boundary (verification row 3)', () => {
  it('reaches no worker, engine, parser, or ledger-write module from the enqueue route', () => {
    const result = walk(ROUTE_FILE);
    // The walk must be real — resolve the canon imports or the test is a no-op.
    for (const mustReach of ['rateLimit', 'sessionCreator', 'clientAddress', 'http', 'apiAccess']) {
      expect(
        [...result.reached].some((file) => file.endsWith(`/server/${mustReach}.ts`)),
        `walker failed to reach ${mustReach} — the boundary test cannot be trusted`,
      ).toBe(true);
    }
    // The ONE write rides the store FACADE (server/store), never a backend.
    expect(
      [...result.reached].some((file) => file.endsWith('/server/store.ts')),
      'walker failed to reach the store facade — the boundary test cannot be trusted',
    ).toBe(true);
    // The recon validation module is pure zod — reachable and expected.
    expect([...result.reached].some((file) => file.endsWith('modules/recon/validation.ts'))).toBe(true);
    expect(result.violations).toEqual([]);
  });
});
