/**
 * The propose-never-write import boundary (spec acceptance criterion 5) — a
 * structure test that walks the route's RUNTIME import graph from source and
 * asserts no registry-write module is reachable:
 *
 *   - the Covenant SDK store facade (src/lib/sdk.ts: getSdk/indexAsset),
 *   - the split write path (multi-pool.ts: registerMultiPoolAsset / saveAssetSplits),
 *   - the server action itself (assets/actions.ts: registerAssetAction — the
 *     CREATOR's confirm path, never the agent's import),
 *   - the vendored engine (engine/covenant-master-sdk.ts),
 *   - the store implementations (supabaseStore / sqliteStore / inMemoryStore /
 *     server/store / ledger/store),
 *   - next/cache (revalidatePath — write-adjacent).
 *
 * `import type` statements are STRIPPED before walking: they are erased at
 * compile time, contribute nothing to the runtime graph, and registrationDraft
 * uses exactly one (the RegisterAssetPayload compile pin). That strip is the
 * soundness argument, not an escape hatch — a runtime import cannot hide in a
 * type-only statement.
 *
 * Known, intended exception: src/lib/db.ts IS reachable — but only through
 * the shared rate limiter (checkSharedRateLimit's Postgres counter store),
 * which the spec itself mandates. The test pins the importer set of db.ts to
 * { rateLimit.ts } so the counter client cannot be borrowed for registry writes.
 */
import { existsSync } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROUTE_FILE = path.resolve(__dirname, '../route.ts');
// __tests__ sits six levels below src/ (src/app/api/covnant/agent/register/__tests__).
const SRC_ROOT = path.join(__dirname, '..', '..', '..', '..', '..', '..');

/** Registry-write modules the route's graph must never reach. */
const BANNED = [
  '/lib/sdk',
  'splits/multi-pool',
  'assets/actions',
  'engine/covenant-master-sdk',
  'next/cache',
  'server/store',
  'supabaseStore',
  'sqliteStore',
  'inMemoryStore',
  'ledger/store',
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

interface WalkResult {
  reached: Set<string>;
  /** parent files → child module, for the lib/db importer pin. */
  importers: Map<string, Set<string>>;
  violations: string[];
}

function walk(entry: string): WalkResult {
  const reached = new Set<string>();
  const importers = new Map<string, Set<string>>();
  const violations: string[] = [];
  const queue: Array<{ file: string; parent: string | null }> = [{ file: entry, parent: null }];
  while (queue.length > 0) {
    const { file, parent } = queue.shift() as { file: string; parent: string | null };
    if (reached.has(file)) continue;
    reached.add(file);
    if (parent) {
      const parents = importers.get(file) ?? new Set<string>();
      parents.add(parent);
      importers.set(file, parents);
    }
    const banned = isBanned(file);
    if (banned && file !== entry) {
      violations.push(`${file} is reachable via banned module "${banned}"`);
      continue;
    }
    const source = readFileSync(file, 'utf8');
    for (const spec of runtimeImportSpecs(source)) {
      // Bare modules: only the spec string can be checked — but 'next/cache'
      // is exactly the bare write-adjacent module we ban.
      const bareHit = isBanned(spec);
      if (bareHit && !spec.startsWith('.') && !spec.startsWith('@')) {
        violations.push(`${file} imports banned bare module "${spec}"`);
        continue;
      }
      const resolved = resolveSpec(file, spec);
      if (resolved) queue.push({ file: resolved, parent: file });
    }
  }
  return { reached, importers, violations };
}

describe('propose-never-write import boundary (criterion 5)', () => {
  it('reaches no registry-write module from the agent route', () => {
    const result = walk(ROUTE_FILE);
    // The walk must be real — resolve the canon imports or the test is a no-op.
    for (const mustReach of ['rateLimit', 'sessionCreator', 'clientAddress', 'http']) {
      expect(
        [...result.reached].some((file) => file.includes(`/server/${mustReach}.ts`)),
        `walker failed to reach ${mustReach} — the boundary test cannot be trusted`,
      ).toBe(true);
    }
    for (const mustReach of ['registrationDraft', 'modelClient']) {
      expect(
        [...result.reached].some((file) => file.includes(`/lib/agent/${mustReach}.ts`)),
        `walker failed to reach ${mustReach} — the boundary test cannot be trusted`,
      ).toBe(true);
    }
    expect(result.violations).toEqual([]);
  });

  it('allows src/lib/db.ts ONLY as the rate limiter\'s counter client', () => {
    const result = walk(ROUTE_FILE);
    const dbFile = path.join(SRC_ROOT, 'lib/db.ts');
    expect(result.reached.has(dbFile)).toBe(true);
    const parents = result.importers.get(dbFile) ?? new Set<string>();
    for (const parent of parents) {
      expect(parent.endsWith('server/rateLimit.ts')).toBe(true);
    }
  });
});
