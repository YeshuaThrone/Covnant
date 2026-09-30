/**
 * Layer guardrail (spec build item 5): the UCT lane (`src/app/**`) and the
 * CVT worker lane (`src/workers/**`) share no imports. Enqueuing recon work
 * is a store insert, never a function call into the worker, and the worker
 * never reaches back into Next route modules — the boundary that keeps heavy
 * background work out of the request cycle is a property of the whole tree,
 * so unlike route.boundary.test.ts (one entry file, banned module list) this
 * test walks EVERY module in each lane and bans the other lane as a region.
 *
 * Same technique as route.boundary.test.ts: source-scanned runtime import
 * graph with `import type` stripped (erased at compile time, so a runtime
 * import cannot hide in a type-only statement).
 *
 * `src/workers` does not exist until the recon-worker PR lands; both walks
 * pass vacuously until then. The self-check below pins the walker to a real
 * route and a real lib module, so an enumeration failure can never masquerade
 * as a green boundary.
 */
import { existsSync } from 'fs';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// __tests__ sits six levels below src/ (src/app/api/covnant/agent/register/__tests__).
const SRC_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const APP_ROOT = path.join(SRC_ROOT, 'app');
const WORKERS_ROOT = path.join(SRC_ROOT, 'workers');

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
  // isFile, not existsSync: `./helpers` must resolve to helpers.ts, never to
  // the directory itself (readFileSync on a directory is EISDIR).
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    base,
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function listModules(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) out.push(...listModules(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function isUnder(file: string, region: string): boolean {
  const rel = path.relative(region, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Memoized reachability: every file's runtime graph is read once. */
const reachCache = new Map<string, Set<string>>();

function reach(file: string, onStack: Set<string>): Set<string> {
  const cached = reachCache.get(file);
  if (cached) return cached;
  if (onStack.has(file)) return new Set<string>();
  onStack.add(file);
  const acc = new Set<string>([file]);
  for (const spec of runtimeImportSpecs(readFileSync(file, 'utf8'))) {
    const resolved = resolveSpec(file, spec);
    if (resolved) for (const reached of reach(resolved, onStack)) acc.add(reached);
  }
  onStack.delete(file);
  reachCache.set(file, acc);
  return acc;
}

function violations(entries: string[], bannedRegion: string): string[] {
  const found: string[] = [];
  for (const entry of entries) {
    for (const file of reach(entry, new Set<string>())) {
      if (isUnder(file, bannedRegion)) {
        found.push(`${path.relative(SRC_ROOT, entry)} -> ${path.relative(SRC_ROOT, file)}`);
      }
    }
  }
  return found;
}

describe('layer import boundary: src/app vs src/workers', () => {
  it('the walker really enumerates and resolves — a vacuous green is worthless', () => {
    const appFiles = listModules(APP_ROOT);
    const registerRoute = appFiles.find((file) =>
      file.endsWith(path.join('api', 'covnant', 'agent', 'register', 'route.ts')),
    );
    expect(registerRoute, 'app enumeration missed the registration route').toBeDefined();
    const reached = reach(registerRoute as string, new Set<string>());
    expect(
      [...reached].some((file) => file.endsWith(path.join('lib', 'agent', 'modelClient.ts'))),
      'walker failed to resolve the route graph — the boundary test cannot be trusted',
    ).toBe(true);
  });

  it('no src/app module imports from src/workers', () => {
    expect(violations(listModules(APP_ROOT), WORKERS_ROOT)).toEqual([]);
  });

  it('no src/workers module imports from src/app', () => {
    // Vacuous until the worker lane exists (recon-worker PR); the region ban
    // is what the CBT "never" rule makes structural once it does.
    expect(violations(listModules(WORKERS_ROOT), APP_ROOT)).toEqual([]);
  });
});
