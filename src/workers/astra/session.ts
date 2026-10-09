/**
 * CVT Astra extraction agent — dashboard session seam (PR 6).
 *
 * The traversal engine never touches a real browser: it drives the
 * `DashboardSession` seam, and THIS module is the only file that knows how
 * sessions come to be. Two drivers:
 *
 *  - `openFixtureSession` — the recorded-dashboards double used by tests
 *    (and by main.ts when ASTRA_BASE_URL is not set): pages come from the
 *    recorded fixture composer, fill/click are observed but inert, and
 *    downloads resolve to the recorded statement bytes.
 *  - `openPlaywrightSession` — the headless production driver. Credentials
 *    reach the real page ONLY through `fill()` (Playwright's own in-memory
 *    input path); they are never persisted, never logged, and never
 *    serialized into the session's observable state.
 *
 * Both drivers share the secrecy contract: whatever enters `fill()` never
 * comes back out. The no-credential-leak test pins this from the engine
 * side (it inspects every artifact, error, and console emission) and the
 * fixture driver pins it structurally (it holds filled values in memory
 * and exposes none of them through any serializable surface).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The observable behavior the traversal engine needs from a dashboard. */
export interface DashboardSession {
  goto(url: string): Promise<DashboardPage>;
  close(): Promise<void>;
}

/** One page the session is looking at. */
export interface DashboardPage {
  /**
   * Type into a control. This is the ONLY place plaintext credentials are
   * ever handed to — the browser-equivalent in-memory input path.
   */
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  /** The page's fully-qualified anchor list (href + text). */
  anchors(): Promise<readonly DashboardAnchor[]>;
  /** The page's HTML — for redacted audit capture only. */
  html(): Promise<string>;
  /**
   * The page's final URL after navigation and any redirects — the
   * authenticated-landing check's default observable.
   */
  url(): Promise<string>;
  /**
   * Cookie NAMES visible to the page — names only, never values (the
   * secrecy contract: values never leave the browser process).
   */
  cookieNames(): Promise<readonly string[]>;
  /** Fetch a linked resource's bytes (a statement download). */
  download(url: string): Promise<string>;
}

export interface DashboardAnchor {
  href: string;
  text: string;
}

export interface RecordedFixture {
  /** Fully-qualified page URL the fixture set was captured at. */
  url: string;
  /** The recorded page HTML. */
  html: string;
}

/**
 * The fixture driver's page catalog: recorded login/dashboard pages plus
 * the raw statement bytes keyed by fully-qualified href. The fixture
 * composer in the test suite builds these; main.ts with fixtures on disk
 * can too.
 */
export interface FixtureCatalog {
  pages: readonly RecordedFixture[];
  /** href → recorded raw statement content. */
  downloads: ReadonlyMap<string, string>;
}

export class MissingFixtureError extends Error {
  constructor(
    public readonly kind: 'page' | 'download',
    public readonly url: string,
  ) {
    super(`Astra fixture ${kind} not recorded: ${url}`);
    this.name = 'MissingFixtureError';
  }
}

// ---------------------------------------------------------------------------
// Selector vocabulary — the grammar the adapter profiles use. The fixture
// driver matches against it (a real browser throws on a missing node; the
// fixture lane models that so selector drift is testable), and the fixture
// composer renders controls from it (recordings match profiles by
// construction, not by hand-maintained parallel HTML).
// ---------------------------------------------------------------------------

interface ParsedSelector {
  tag: string | null;
  id: string | null;
  classes: readonly string[];
  attrs: Readonly<Record<string, string>>;
}

/** Parse the profile selector grammar: tag, #id, .class, [attr="value"]. */
export function parseSelector(selector: string): ParsedSelector {
  let rest = selector.trim();
  const tag = rest.match(/^([a-zA-Z][a-zA-Z0-9-]*)/)?.[1] ?? null;
  if (tag !== null) {
    rest = rest.slice(tag.length);
  }
  const id = rest.match(/^#([A-Za-z0-9_-]+)/)?.[1] ?? null;
  if (id !== null) {
    rest = rest.replace(/^#[A-Za-z0-9_-]+/, '');
  }
  const classes = [...rest.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  const attrs: Record<string, string> = {};
  for (const m of rest.matchAll(/\[([a-zA-Z-]+)(?:="([^"]*)")?\]/g)) {
    attrs[m[1]!] = m[2] ?? '';
  }
  return { tag, id, classes, attrs };
}

/** Does one HTML tag's source satisfy the parsed selector? */
function tagMatches(parsed: ParsedSelector, tagHtml: string): boolean {
  const tag = (tagHtml.match(/^<([a-zA-Z0-9-]+)/)?.[1] ?? '').toLowerCase();
  if (parsed.tag !== null && parsed.tag.toLowerCase() !== tag) {
    return false;
  }
  if (parsed.id !== null && !new RegExp(`\\bid="${parsed.id}"`).test(tagHtml)) {
    return false;
  }
  for (const cls of parsed.classes) {
    if (!new RegExp(`\\bclass="[^"]*\\b${cls}\\b[^"]*"`).test(tagHtml)) {
      return false;
    }
  }
  for (const [name, value] of Object.entries(parsed.attrs)) {
    const attr = tagHtml.match(new RegExp(`\\b${name}(?:="([^"]*)")?`));
    if (attr === null) {
      return false;
    }
    if (value !== '' && attr[1] !== value) {
      return false;
    }
  }
  return true;
}

/** Does the page's HTML contain a node satisfying the selector? */
export function selectorPresentIn(html: string, selector: string): boolean {
  const parsed = parseSelector(selector);
  for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    if (tagMatches(parsed, m[0])) {
      return true;
    }
  }
  return false;
}

/**
 * Render a control tag satisfying the selector — the fixture composer's
 * building block. `extraAttrs` rides along (e.g. type="password").
 */
export function renderControlFor(
  selector: string,
  extraAttrs: Readonly<Record<string, string>> = {},
): string {
  const parsed = parseSelector(selector);
  const tag = parsed.tag ?? (parsed.classes.length > 0 ? 'button' : 'input');
  const parts: string[] = [tag];
  if (parsed.id !== null) {
    parts.push(`id="${parsed.id}"`);
  }
  if (parsed.classes.length > 0) {
    parts.push(`class="${parsed.classes.join(' ')}"`);
  }
  for (const [name, value] of Object.entries(parsed.attrs)) {
    parts.push(`${name}="${value}"`);
  }
  for (const [name, value] of Object.entries(extraAttrs)) {
    parts.push(`${name}="${value}"`);
  }
  // Void elements take no closing tag.
  return ['br', 'img', 'input', 'hr'].includes(tag)
    ? `<${parts.join(' ')}/>`
    : `<${parts.join(' ')}></${tag}>`;
}

/**
 * The fixture session — walks a recorded page catalog. Fill/click are
 * observed-but-inert: values live in a non-serializable memory buffer that
 * nothing reads (the browser's analog: what you typed stays in the DOM).
 */
export function openFixtureSession(catalog: FixtureCatalog): DashboardSession {
  const currentUrl: { url: string | null } = { url: null };

  function fixturePage(url: string): RecordedFixture {
    const page = catalog.pages.find((candidate) => candidate.url === url);
    if (!page) {
      throw new MissingFixtureError('page', url);
    }
    return page;
  }

  const session: DashboardSession = {
    async goto(url) {
      currentUrl.url = url;
      fixturePage(url); // fail fast on an unrecorded page
      return fixturePageFor(url);
    },
    async close() {
      currentUrl.url = null;
    },
  };

  function fixturePageFor(url: string): DashboardPage {
    return {
      async fill(selector, value) {
        // Presence-checked like a real browser (a missing node throws),
        // then inert: the value is accepted and dropped. Asserting it was
        // RECEIVED is the suite's job via the recording variant, never via
        // serialization.
        const page = fixturePage(currentUrl.url ?? '');
        if (!selectorPresentIn(page.html, selector)) {
          throw new Error(`fixture selector miss on ${url}: ${selector}`);
        }
        void value;
      },
      async click(selector) {
        const page = fixturePage(currentUrl.url ?? '');
        if (!selectorPresentIn(page.html, selector)) {
          throw new Error(`fixture selector miss on ${url}: ${selector}`);
        }
      },
      async anchors() {
        return parseAnchors(fixturePage(url).html, url);
      },
      async html() {
        return fixturePage(url).html;
      },
      async url() {
        // The fixture was recorded at this URL — exactly what goto() navigated.
        return url;
      },
      async cookieNames() {
        // Fixtures don't model cookies — no profile's fixture needs one.
        return [];
      },
      async download(href) {
        const resolved = resolveHref(href, url);
        const content = catalog.downloads.get(resolved);
        if (content === undefined) {
          throw new MissingFixtureError('download', resolved);
        }
        return content;
      },
    };
  }

  return session;
}

/** A fill/click observation — selectors only, never values. */
export interface SessionObservation {
  action: 'fill' | 'click';
  selector: string;
}

/**
 * Recording wrapper for the fixture session — the adapter tests observe
 * THAT the profile's selectors were driven, while the values stay inside
 * the inert fill path (the observations buffer never returns values, never
 * logs them, and never serializes them; the no-credential-leak test
 * asserts this).
 */
export function openRecordingFixtureSession(catalog: FixtureCatalog): {
  session: DashboardSession;
  observations: SessionObservation[];
} {
  const observations: SessionObservation[] = [];
  const inner = openFixtureSession(catalog);
  const session: DashboardSession = {
    async goto(url) {
      const page = await inner.goto(url);
      return {
        async fill(selector, value) {
          observations.push({ action: 'fill', selector });
          await page.fill(selector, value);
        },
        async click(selector) {
          observations.push({ action: 'click', selector });
          await page.click(selector);
        },
        anchors: () => page.anchors(),
        html: () => page.html(),
        url: () => page.url(),
        cookieNames: () => page.cookieNames(),
        download: (href) => page.download(href),
      };
    },
    close: () => inner.close(),
  };
  return { session, observations };
}

function resolveHref(href: string, pageUrl: string): string {
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return href;
  }
}

/** Extract fully-qualified anchors from recorded HTML. */
export function parseAnchors(html: string, pageUrl: string): DashboardAnchor[] {
  const anchors: DashboardAnchor[] = [];
  const anchorPattern = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = resolveHref(match[1]!, pageUrl);
    const text = match[2]!
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    anchors.push({ href, text });
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// Production driver — headless Playwright. Loaded lazily so tests and the
// fixture path never require a browser install.
// ---------------------------------------------------------------------------

export interface PlaywrightSessionOptions {
  baseUrl: string;
  /** Wall-clock budget per page action, seconds (default 45). */
  timeoutSeconds?: number;
}

export async function openPlaywrightSession(
  options: PlaywrightSessionOptions,
): Promise<DashboardSession> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      // Credentials and cookies never leave the browser process; no disk
      // persistence, no traces, no HAR.
    });
    const page = await context.newPage();
    const timeout = (options.timeoutSeconds ?? 45) * 1000;
    page.setDefaultTimeout(timeout);

    const session: DashboardSession = {
      async goto(url) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        return playwrightPage(page, options.baseUrl);
      },
      async close() {
        await context.close();
        await browser.close();
      },
    };
    return session;
  } catch (error) {
    // Post-launch setup failed, so the caller never received a session and
    // its cleanup cannot reach the browser — close it here, then let the
    // original failure propagate (a failing close must not mask it).
    await browser.close().catch(() => undefined);
    throw error;
  }
}

function playwrightPage(
  page: import('playwright').Page,
  baseUrl: string,
): DashboardPage {
  return {
    async fill(selector, value) {
      await page.fill(selector, value);
    },
    async click(selector) {
      await page.click(selector);
      // Submit navigation settles on its own; give the router a beat.
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    },
    async anchors() {
      const html = await page.content();
      return parseAnchors(html, page.url() || baseUrl);
    },
    async html() {
      return page.content();
    },
    async url() {
      // The final URL after navigation and redirects — the observable a
      // failed login's bounce shows up in.
      return page.url();
    },
    async cookieNames() {
      // Names only, never values — the browser's cookie jar never leaves
      // the process; the engine learns presence, not contents.
      const cookies = await page.context().cookies();
      return cookies.map((cookie) => cookie.name);
    },
    async download(href) {
      const resolved = resolveHref(href, page.url() || baseUrl);
      // In-page fetch keeps the download inside the browser's memory and
      // returns the body text — never a temp file on disk.
      const body = await page.evaluate(async (url) => {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) {
          throw new Error(`download failed: ${response.status} ${url}`);
        }
        return response.text();
      }, resolved);
      return body;
    },
  };
}

/**
 * Disk-backed fixture catalog loader for main.ts dry-runs: reads a
 * fixtures.json manifest (pages: [{url, htmlPath}], downloads:
 * {href: path}) relative to `root`. Test suites build catalogs in memory
 * instead.
 */
export async function loadFixtureCatalogFromDisk(root: string): Promise<FixtureCatalog> {
  const manifestPath = join(root, 'fixtures.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    pages: readonly { url: string; htmlPath: string }[];
    downloads: Readonly<Record<string, string>>;
  };
  const pages = await Promise.all(
    manifest.pages.map(async (entry) => ({
      url: entry.url,
      html: await readFile(join(root, entry.htmlPath), 'utf8'),
    })),
  );
  const downloads = new Map(
    await Promise.all(
      Object.entries(manifest.downloads).map(
        async ([href, path]) =>
          [href, await readFile(join(root, path), 'utf8')] as const,
      ),
    ),
  );
  return { pages, downloads };
}
