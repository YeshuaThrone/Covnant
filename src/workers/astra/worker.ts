/**
 * CVT Astra extraction agent — traversal engine (PR 6).
 *
 * The single code path every dashboard runs through. One traversal:
 *
 *   decrypt credentials IN MEMORY (vault read path)
 *     → open a session for the profile
 *     → drive the login (deterministic selectors; RECON_VISION_* fallback
 *       on a selector miss — fail-closed when the seam is unset)
 *     → land on the dashboard, harvest statement links by the profile's
 *       href pattern
 *     → download each link's bytes (in-memory, never a temp file)
 *     → capture REDACTED audit artifacts (login page, dashboard page)
 *     → hand off every capture: statement_ingests + ONE recon job enqueue
 *     → stamp the connection's traversal provenance
 *
 * Failure semantics: ANY error → the traversal record carries the redacted
 * reason, the provenance write records it (never flipping connection
 * status — disconnect is the holder's act), and nothing is enqueued. An
 * empty dashboard is not a failure: 'no_statements' still verifies the
 * dashboard was reached and authenticated. A landing that never
 * authenticates — a failed login bounces to an error page — records
 * 'auth_failed' and NEVER stamps verifiedAt: a rotated-credential
 * connection must read as broken, not healthy.
 */

import { decryptCredential } from '@/modules/vault/crypto';
import type {
  DecryptedDistributorCredentials,
  DistributorConnectionRecord,
} from '@/modules/vault/records';
import type { Store } from '@/lib/server/store';

import { credentialSecrets, redactCredentials, redactError } from './credentials';
import { handOffStatement } from './handoff';
import { profileFor, type AstraAdapterProfile } from './profiles';
import type {
  AstraSweepSummary,
  AstraTraversalOutcome,
  AstraTraversalRecord,
  CapturedStatement,
  TraversalArtifact,
} from './records';
import type { DashboardAnchor, DashboardPage, DashboardSession } from './session';
import { selectorPresentIn } from './session';
import { locateControlViaVision } from './visionFallback';

/** Everything the traversal needs from the process around it. */
export interface AstraWorkerDeps {
  store: Store;
  /** Opens the session for a traversal — fixture double or Playwright. */
  openSession(profile: AstraAdapterProfile): Promise<DashboardSession>;
  /** Vision client override for tests; default reads the PR 2 seam. */
  visionClient?: Parameters<typeof locateControlViaVision>[2];
  /** Clock override for deterministic timestamps in tests. */
  now?: () => string;
}

/**
 * Build the in-memory working set from a row's ciphertexts. The ONLY
 * function in the lane that decrypts; its result never outlives the
 * traversal's session.
 */
export function decryptConnectionCredentials(
  connection: DistributorConnectionRecord,
): DecryptedDistributorCredentials {
  return {
    distributor: connection.distributor,
    username: decryptCredential(connection.username_encrypted),
    password: decryptCredential(connection.password_encrypted),
    encryptedUsername: connection.username_encrypted,
    encryptedPassword: connection.password_encrypted,
  };
}

/** Statement links on the dashboard, by the profile's href pattern. */
export function harvestStatementLinks(
  profile: AstraAdapterProfile,
  anchors: readonly DashboardAnchor[],
): readonly DashboardAnchor[] {
  const pattern = new RegExp(profile.statementHrefPattern);
  // Profile patterns are PATH-relative (e.g. ^/distrokid/reports/...) —
  // parseAnchors hands back fully-qualified URLs, so test the pathname,
  // never the raw href.
  return anchors.filter((anchor) => {
    try {
      return pattern.test(new URL(anchor.href).pathname);
    } catch {
      return pattern.test(anchor.href); // not a parseable URL — test raw
    }
  });
}

/** Prefix match that respects path segments — `/bank` never matches `/bankrupted`. */
function urlStartsWithPrefix(url: string, prefix: string): boolean {
  if (!url.startsWith(prefix)) {
    return false;
  }
  const rest = url.slice(prefix.length);
  return rest === '' || /^[/?#]/.test(rest);
}

/**
 * The verifiedAt gate: did the dashboard landing actually authenticate?
 * Default (no profile marker): the final URL still starts with the
 * dashboardUrl — a failed login bounces the landing page to an error or
 * login re-render whose URL has left the dashboard. Any observation
 * failure fails closed: an unobservable page is not authenticated.
 */
export async function dashboardAuthenticated(
  page: DashboardPage,
  profile: AstraAdapterProfile,
): Promise<boolean> {
  const marker = profile.authMarker;
  try {
    if (marker === undefined || marker.kind === 'url_prefix') {
      const prefix = marker === undefined ? profile.dashboardUrl : marker.value;
      return urlStartsWithPrefix(await page.url(), prefix);
    }
    if (marker.kind === 'element') {
      // Works for both drivers: html() is the (unredacted-in-memory,
      // never-persisted) page body; the selector grammar is the profile's own.
      return selectorPresentIn(await page.html(), marker.selector);
    }
    return (await page.cookieNames()).includes(marker.name);
  } catch {
    return false;
  }
}

/**
 * Drive one fill-or-vision step. Deterministic selectors first; on a
 * selector miss (the driver throws), the redacted page goes to the vision
 * locator — a null answer (unset seam, engine down, unusable reply) fails
 * the step closed and the traversal records why.
 */
async function fillOrVision(
  page: DashboardPage,
  selector: string,
  value: string,
  control: 'username_input' | 'password_input',
  secrets: readonly string[],
  deps: AstraWorkerDeps,
): Promise<void> {
  try {
    await page.fill(selector, value);
  } catch (error) {
    const html = await page.html();
    const located = await locateControlViaVision(
      { control, pageHtml: html },
      secrets,
      deps.visionClient,
    );
    if (located === null) {
      throw new Error(
        `selector_miss (vision fallback unavailable): ${redactError(error, secrets)}`,
      );
    }
    await page.fill(located.selector, value);
  }
}

async function submitOrVision(
  page: DashboardPage,
  selector: string,
  secrets: readonly string[],
  deps: AstraWorkerDeps,
): Promise<void> {
  try {
    await page.click(selector);
  } catch (error) {
    const html = await page.html();
    const located = await locateControlViaVision(
      { control: 'submit_button', pageHtml: html },
      secrets,
      deps.visionClient,
    );
    if (located === null) {
      throw new Error(
        `selector_miss (vision fallback unavailable): ${redactError(error, secrets)}`,
      );
    }
    await page.click(located.selector);
  }
}

/** Redaction-gated audit capture — the only way HTML becomes an artifact. */
async function captureArtifact(
  page: DashboardPage,
  label: string,
  secrets: readonly string[],
): Promise<TraversalArtifact> {
  const raw = await page.html();
  return {
    label,
    kind: 'page_capture',
    content: redactCredentials(raw, secrets),
  };
}

/** Pure record assembly — every traversal exit funnels through here. */
function assembleRecord(
  base: AstraTraversalRecordBase,
  outcome: AstraTraversalOutcome,
  statements: readonly CapturedStatement[],
  artifacts: readonly TraversalArtifact[],
  ingestIds: readonly string[],
  jobIds: readonly string[],
  error: string | null,
  finishedAt: string,
): AstraTraversalRecord {
  return {
    ...base,
    outcome,
    statements,
    artifacts,
    ingestIds,
    jobIds,
    error,
    startedAt: base.startedAt,
    finishedAt,
  };
}

/** The record's identity fields, fixed before the traversal body runs. */
interface AstraTraversalRecordBase {
  connectionId: string;
  holderId: string;
  distributor: DistributorConnectionRecord['distributor'];
  vertical: AstraAdapterProfile['vertical'] | null;
  startedAt: string;
}

/**
 * One connection's traversal — the sweep's unit. Credentials exist only
 * inside this function's scope; everything that outlives it (artifacts,
 * ingest rows, the provenance write) has passed the redaction gate.
 */
export async function traverseConnection(
  connection: DistributorConnectionRecord,
  deps: AstraWorkerDeps,
): Promise<AstraTraversalRecord> {
  const now = deps.now ?? (() => new Date().toISOString());
  const profile = profileFor(connection.distributor);
  const base: AstraTraversalRecordBase = {
    connectionId: connection.id,
    holderId: connection.holder_id,
    distributor: connection.distributor,
    vertical: profile?.vertical ?? null,
    startedAt: now(),
  };

  let credentials: DecryptedDistributorCredentials | null = null;
  let session: DashboardSession | null = null;
  try {
    if (profile === undefined) {
      // Runtime drift guard: the registry test prevents this, but a sweep
      // must record honestly if it ever happens — never skip silently.
      const reason = 'no_adapter_profile_registered';
      await deps.store
        .markDistributorTraversal(connection.id, { error: reason })
        .catch(() => undefined);
      return assembleRecord(base, 'failed', [], [], [], [], reason, now());
    }

    credentials = decryptConnectionCredentials(connection);
    const secrets = credentialSecrets(credentials);
    const artifacts: TraversalArtifact[] = [];

    session = await deps.openSession(profile);

    // Deterministic login. The username rides the redaction gate too —
    // dashboards echo it in "invalid credentials" errors.
    const loginPage = await session.goto(profile.loginUrl);
    artifacts.push(
      await captureArtifact(loginPage, `login:${connection.distributor}`, secrets),
    );
    await fillOrVision(
      loginPage,
      profile.selectors.username,
      credentials.username,
      'username_input',
      secrets,
      deps,
    );
    await fillOrVision(
      loginPage,
      profile.selectors.password,
      credentials.password,
      'password_input',
      secrets,
      deps,
    );
    await submitOrVision(loginPage, profile.selectors.submit, secrets, deps);

    // The dashboard harvest — delimited-text captures only this PR.
    const dashboardPage = await session.goto(profile.dashboardUrl);
    artifacts.push(
      await captureArtifact(dashboardPage, `dashboard:${connection.distributor}`, secrets),
    );

    // The verifiedAt gate: a failed login bounces the landing page to an
    // anchor-free error page — indistinguishable from an empty dashboard
    // by links alone. Never stamp verified on faith.
    if (!(await dashboardAuthenticated(dashboardPage, profile))) {
      const reason = 'auth_failed: dashboard authentication marker not observed after login';
      await deps.store
        .markDistributorTraversal(connection.id, { error: reason })
        .catch(() => undefined);
      return assembleRecord(base, 'auth_failed', [], artifacts, [], [], reason, now());
    }

    const links = harvestStatementLinks(profile, await dashboardPage.anchors());

    if (links.length === 0) {
      // An authenticated empty dashboard still verifies: the marker held.
      await deps.store
        .markDistributorTraversal(connection.id, { verifiedAt: now() })
        .catch(() => undefined);
      return assembleRecord(base, 'no_statements', [], artifacts, [], [], null, now());
    }

    // Download, redact-gate, hand off — one ingest + one enqueue each.
    const statements: CapturedStatement[] = [];
    const ingestIds: string[] = [];
    const jobIds: string[] = [];
    for (const link of links) {
      const content = await dashboardPage.download(link.href);
      const statement: CapturedStatement = {
        fileName: link.href.split('/').pop() ?? link.href,
        content,
        format: 'csv_statement',
      };
      statements.push(statement);
      const handoff = await handOffStatement(
        deps.store,
        statement,
        connection.holder_id,
        secrets,
        now,
      );
      ingestIds.push(handoff.ingestId);
      jobIds.push(handoff.jobId);
    }

    const marked = await deps.store
      .markDistributorTraversal(connection.id, { verifiedAt: now() })
      .catch(() => undefined);
    return assembleRecord(
      base,
      'extracted',
      statements,
      artifacts,
      ingestIds,
      jobIds,
      marked === undefined ? 'provenance_write_failed: connection row missing' : null,
      now(),
    );
  } catch (error) {
    // The scrubber runs BEFORE anything records — the raw error never
    // leaves this scope. A traversal failure never flips connection status.
    const secrets = credentials === null ? [] : credentialSecrets(credentials);
    const reason = redactError(error, secrets);
    await deps.store
      .markDistributorTraversal(connection.id, { error: reason })
      .catch(() => undefined);
    return assembleRecord(base, 'failed', [], [], [], [], reason, now());
  } finally {
    await session?.close().catch(() => undefined);
    // Drop the working set explicitly — the in-memory span ends here.
    credentials = null;
  }
}

/**
 * The sweep — list every ACTIVE connection, traverse each, summarize.
 * One traversal at a time: a holder's dashboards are traversed oldest
 * first, and a browser lane stays serial (no credential cross-talk).
 */
export async function runAstraSweep(deps: AstraWorkerDeps): Promise<{
  summary: AstraSweepSummary;
  traversals: readonly AstraTraversalRecord[];
}> {
  const connections = await deps.store.listActiveDistributorConnections();
  const traversals: AstraTraversalRecord[] = [];
  for (const connection of connections) {
    traversals.push(await traverseConnection(connection, deps));
  }
  const summary: AstraSweepSummary = {
    traversed: traversals.length,
    extracted: traversals.filter((record) => record.outcome === 'extracted').length,
    noStatements: traversals.filter((record) => record.outcome === 'no_statements').length,
    authFailed: traversals.filter((record) => record.outcome === 'auth_failed').length,
    failed: traversals.filter((record) => record.outcome === 'failed').length,
    statementsCaptured: traversals.reduce(
      (total, record) => total + record.statements.length,
      0,
    ),
    jobsEnqueued: traversals.reduce((total, record) => total + record.jobIds.length, 0),
  };
  return { summary, traversals };
}
