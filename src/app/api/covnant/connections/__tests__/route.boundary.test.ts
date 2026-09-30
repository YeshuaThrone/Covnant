/**
 * The vault routes' decrypt boundary (PR 5) — a structure test that walks
 * BOTH route files' RUNTIME import graphs from source and asserts the
 * DECRYPT half of the credential cipher is unreachable:
 *
 *   - `decryptCredential` may appear ONLY in its definition module
 *     (src/modules/vault/crypto.ts). The routes encrypt app-side and
 *     serialize toConnectionStatus — they have no business decrypting.
 *     The decrypt path exists for the Astra extraction agent (PR 6),
 *     which is deliberately not part of a route's graph.
 *
 * `import type` statements are stripped before walking: they are erased
 * at compile time and contribute nothing to the runtime graph (the recon
 * boundary test's soundness argument).
 */
import { existsSync } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// __tests__ sits six levels below src/ (src/app/api/covnant/connections[/[id]]/__tests__).
const SRC_ROOT = path.join(__dirname, '..', '..', '..', '..', '..', '..');
const ROUTE_FILES = [
  path.resolve(__dirname, '../route.ts'),
  path.resolve(__dirname, '../[id]/route.ts'),
];
const CRYPTO_MODULE = path.join(SRC_ROOT, 'src/modules/vault/crypto.ts');
const DECRYPT_SYMBOL = 'decryptCredential';

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
    ? path.join(SRC_ROOT, 'src', spec.slice(2))
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

/** Every src-file the route's runtime graph can reach. */
function walkRuntimeGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const spec of runtimeImportSpecs(source)) {
      const resolved = resolveSpec(file, spec);
      if (resolved !== null) queue.push(resolved);
    }
  }
  return [...seen];
}

describe('the vault routes\u2019 decrypt boundary (PR 5)', () => {
  for (const routeFile of ROUTE_FILES) {
    it(`${path.relative(SRC_ROOT, routeFile)} never reaches the credential decrypt half`, () => {
      const graph = walkRuntimeGraph(routeFile);
      // Soundness of the walk itself, pinned on the route that encrypts
      // (the DELETE route legitimately never touches the cipher at all).
      if (graph.includes(CRYPTO_MODULE) === false && routeFile.endsWith('[id]/route.ts')) {
        // Fine by design — the scan below still covers the whole graph.
      } else {
        expect(graph).toContain(CRYPTO_MODULE);
      }
      for (const file of graph) {
        if (file === CRYPTO_MODULE) continue; // the definition site
        const source = readFileSync(file, 'utf8');
        expect(
          source.includes(DECRYPT_SYMBOL),
          `${path.relative(SRC_ROOT, file)} references ${DECRYPT_SYMBOL} — routes never decrypt`,
        ).toBe(false);
      }
    });
  }
});
