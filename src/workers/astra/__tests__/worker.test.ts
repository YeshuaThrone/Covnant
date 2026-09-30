/**
 * CVT Astra extraction agent — traversal engine tests.
 *
 * The three verifying test classes from the build brief, plus the engine
 * semantics:
 *
 *  1. PER-DISTRIBUTOR ADAPTER TESTS — every registered profile traverses
 *     its recorded fixtures: the profile's own selectors drive the login,
 *     the recorded statement link is harvested (decoys skipped), the raw
 *     bytes land byte-verbatim, and exactly one claimable recon job is
 *     enqueued per statement.
 *  2. QUEUE HANDOFF — drain through the recon worker's real claim path.
 *  3. NO-CREDENTIAL-LEAK — a dashboard that RENDERS the username (as real
 *     dashboards do) and a statement carrying it in a contact column:
 *     after the redaction gate, no persisted surface — ingest rows, job
 *     rows, artifacts, traversal errors, summary — contains the username,
 *     the password, or the ciphertexts.
 *
 * Plus provenance semantics (success verifies, failure records, neither
 * ever flips connection status) and the vision fallback's fail-closed
 * contract (unset seam → recorded failure; a working engine → recovery).
 */
import { describe, expect, it } from "vitest";

import { encryptCredential } from "@/modules/vault/crypto";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { SqliteStore } from "@/lib/server/sqliteStore";
import type { Store } from "@/lib/server/store";

import {
  composeFixtureCatalog,
  composeProfileFixtures,
  leadIdentifierCode,
} from "./astraFixtures";
import {
  ASTRA_ADAPTER_PROFILES,
  assertProfilesMatchVaultSources,
} from "../profiles";
import type { AstraAdapterProfile } from "../profiles";
import type { FixtureCatalog } from "../session";
import { MissingFixtureError, openFixtureSession, openRecordingFixtureSession } from "../session";
import { runAstraSweep, traverseConnection, harvestStatementLinks } from "../worker";
import type { AstraWorkerDeps } from "../worker";

const HOLDER = "holder-astra-1";
const USERNAME = "casey.carter.77@example.com";
const PASSWORD = "Tr0mbone-Heavy-77";
const CREDENTIALS = { username: USERNAME, password: PASSWORD };
/** Fixed ISO timestamp — the traversal clock, pinned for determinism. */
const NOW = (): string => "2026-09-30T12:00:00.000Z";

function makeStore(): Store {
  return new InMemoryStore();
}

/** Seed one ACTIVE connection with really-encrypted vault credentials. */
async function seedConnection(
  store: Store,
  profile: AstraAdapterProfile,
): Promise<string> {
  const { connection } = await store.createDistributorConnection({
    holder_id: HOLDER,
    distributor: profile.distributor,
    username_encrypted: encryptCredential(USERNAME),
    password_encrypted: encryptCredential(PASSWORD),
  });
  return connection.id;
}

/** The holder's one connection (tests seed exactly one per store). */
async function lastConnection(store: Store) {
  const rows = await store.listDistributorConnections(HOLDER);
  return rows[0]!;
}

/** Fixture deps whose catalog covers exactly the given profiles. */
function fixtureDeps(
  store: Store,
  profiles: readonly AstraAdapterProfile[],
): AstraWorkerDeps {
  const catalog = composeFixtureCatalog(profiles, CREDENTIALS);
  return {
    store,
    openSession: async () => openFixtureSession(catalog),
    now: NOW,
  };
}

/** A catalog whose dashboard has NO statement links — the empty case. */
function emptyDashboardCatalog(profile: AstraAdapterProfile): FixtureCatalog {
  const composed = composeProfileFixtures(profile, CREDENTIALS);
  return {
    pages: [
      composed.login,
      { url: composed.dashboard.url, html: '<html><body><a href="/inbox/messages">Inbox</a></body></html>' },
    ],
    downloads: new Map(),
  };
}

/** A catalog whose login page drifted: the username input renamed. */
function driftedCatalog(profile: AstraAdapterProfile): FixtureCatalog {
  const composed = composeProfileFixtures(profile, CREDENTIALS);
  const drifted = {
    url: composed.login.url,
    html: composed.login.html.replace(/id="[^"]*"/, 'id="legacy-user"'),
  };
  return { pages: [drifted, composed.dashboard], downloads: composed.statementContent ? new Map([[composed.statementUrl, composed.statementContent]]) : new Map() };
}

// --- 1. Per-distributor adapter tests ---------------------------------------

describe.each(ASTRA_ADAPTER_PROFILES.map((profile) => ({ profile })))(
  "adapter: $profile.distributor",
  ({ profile }) => {
    it("traverses the recorded dashboard and hands off exactly one claimable job", async () => {
      const store = makeStore();
      await seedConnection(store, profile);

      const record = await traverseConnection(await lastConnection(store), fixtureDeps(store, [profile]));

      expect(record.outcome).toBe("extracted");
      expect(record.statements).toHaveLength(1);
      expect(record.statements[0]!.fileName).toMatch(/\.(csv|tsv)$/);
      expect(record.ingestIds).toHaveLength(1);
      expect(record.jobIds).toHaveLength(1);
      expect(record.error).toBeNull();

      // The raw bytes survived the lane byte-verbatim — the profile's own
      // vertical identifier code untouched (music carries the ISRC, film
      // the EIDR, gaming the SteamID64, and so on down the registry).
      const ingest = await store.getStatementIngest(record.ingestIds[0]!);
      expect(ingest!.content).toContain(leadIdentifierCode(profile.vertical));
      expect(ingest!.file_name).toBe(record.statements[0]!.fileName);

      // The job is claimable by the recon worker's OWN claim path.
      const claimed = await store.claimReconJob(new Date(), null);
      expect(claimed!.id).toBe(record.jobIds[0]);
      expect(claimed!.ingest_id).toBe(record.ingestIds[0]);
      expect(claimed!.requested_by).toBe(HOLDER);
    });

    it("drives the profile's own login selectors, in order", async () => {
      const store = makeStore();
      await seedConnection(store, profile);
      const catalog = composeFixtureCatalog([profile], CREDENTIALS);
      const { session, observations } = openRecordingFixtureSession(catalog);

      const record = await traverseConnection(await lastConnection(store), {
        store,
        openSession: async () => session,
        now: NOW,
      });

      expect(record.outcome).toBe("extracted");
      expect(observations.map((o) => `${o.action}:${o.selector}`)).toEqual([
        `fill:${profile.selectors.username}`,
        `fill:${profile.selectors.password}`,
        `click:${profile.selectors.submit}`,
      ]);
    });

    it("skips decoy links the harvest pattern must not match", async () => {
      const store = makeStore();
      await seedConnection(store, profile);

      const record = await traverseConnection(await lastConnection(store), fixtureDeps(store, [profile]));

      // The composer's dashboard carries /inbox/messages and
      // /settings/billing decoys — only the recorded statement downloaded.
      expect(record.statements).toHaveLength(1);
      expect(record.statements[0]!.fileName).toMatch(/\.(csv|tsv)$/);
    });
  },
);

// --- Registry parity ---------------------------------------------------------

describe("adapter registry parity", () => {
  it("the registry matches the vault vocabulary exactly (assertProfilesMatchVaultSources)", () => {
    expect(() => assertProfilesMatchVaultSources()).not.toThrow();
  });

  it("every profile's recorded fixture path satisfies its own harvest pattern", () => {
    for (const profile of ASTRA_ADAPTER_PROFILES) {
      expect(new RegExp(profile.statementHrefPattern).test(profile.fixtureStatementPath)).toBe(
        true,
      );
    }
  });

  it("harvestStatementLinks matches URL pathnames, never raw hrefs", () => {
    // Regression: parseAnchors returns fully-qualified URLs; the profile
    // patterns are path-relative. Matching raw hrefs would harvest NOTHING.
    const profile = ASTRA_ADAPTER_PROFILES[0]!;
    const links = harvestStatementLinks(profile, [
      { href: `https://astra.covnant.internal${profile.fixtureStatementPath}`, text: "statement" },
      { href: "https://astra.covnant.internal/inbox/messages", text: "decoy" },
    ]);
    expect(links).toHaveLength(1);
  });
});

// --- Sweep semantics ---------------------------------------------------------

describe("sweep and provenance", () => {
  it("the sweep summarizes mixed outcomes honestly", async () => {
    const store = makeStore();
    const [distrokid, tunecore, ascap] = ASTRA_ADAPTER_PROFILES.slice(0, 3);
    await seedConnection(store, distrokid!);
    await seedConnection(store, tunecore!);
    await seedConnection(store, ascap!);

    const deps: AstraWorkerDeps = {
      store,
      openSession: async (profile) => {
        if (profile.distributor === distrokid!.distributor) {
          return openFixtureSession(composeFixtureCatalog([distrokid!], CREDENTIALS));
        }
        if (profile.distributor === tunecore!.distributor) {
          // Reached the dashboard; no statement links — not a failure.
          return openFixtureSession(emptyDashboardCatalog(tunecore!));
        }
        // ascap's fixtures vanished entirely → the traversal fails.
        throw new MissingFixtureError("page", profile.loginUrl);
      },
      now: NOW,
    };

    const { summary, traversals } = await runAstraSweep(deps);

    expect(summary.traversed).toBe(3);
    expect(summary.extracted).toBe(1);
    expect(summary.noStatements).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.statementsCaptured).toBe(1);
    expect(summary.jobsEnqueued).toBe(1);
    expect(traversals).toHaveLength(3);
  });

  it("a successful traversal verifies the connection; a failed one records and never verifies", async () => {
    const store = makeStore();
    const profile = ASTRA_ADAPTER_PROFILES[0]!;
    await seedConnection(store, profile);

    const before = await lastConnection(store);
    expect(before!.last_verified_at).toBeNull();
    expect(before!.last_error).toBeNull();

    await traverseConnection(before!, fixtureDeps(store, [profile]));
    const verified = await lastConnection(store);
    expect(verified!.last_verified_at).not.toBeNull();
    expect(verified!.last_error).toBeNull();
    expect(verified!.status).toBe("connected");

    // Now break the fixtures — the failure records honestly and preserves
    // the verification, never flipping the holder's connection status.
    const broken: AstraWorkerDeps = {
      store,
      openSession: async () => {
        throw new MissingFixtureError("page", profile.loginUrl);
      },
      now: NOW,
    };
    const record = await traverseConnection(verified!, broken);
    expect(record.outcome).toBe("failed");
    expect(record.error).not.toBeNull();

    const afterFailure = await lastConnection(store);
    expect(afterFailure!.last_error).not.toBeNull();
    expect(afterFailure!.last_verified_at).toBe(verified!.last_verified_at);
    expect(afterFailure!.status).toBe("connected");
  });
});

// --- Vision fallback ---------------------------------------------------------

describe("RECON_VISION_* fallback", () => {
  it("fails CLOSED when the seam is unset — recorded reason, nothing enqueued", async () => {
    const store = makeStore();
    const profile = ASTRA_ADAPTER_PROFILES[0]!;
    await seedConnection(store, profile);

    const record = await traverseConnection(await lastConnection(store), {
      store,
      openSession: async () => openFixtureSession(driftedCatalog(profile)),
      now: NOW,
    });

    expect(record.outcome).toBe("failed");
    expect(record.error).toContain("selector_miss");
    expect(record.jobIds).toHaveLength(0);
    expect(await store.listStatementIngests()).toHaveLength(0);
  });

  it("recovers through a working vision engine — the located selector is driven", async () => {
    const store = makeStore();
    const profile = ASTRA_ADAPTER_PROFILES[0]!;
    await seedConnection(store, profile);

    const record = await traverseConnection(await lastConnection(store), {
      store,
      openSession: async () => openFixtureSession(driftedCatalog(profile)),
      visionClient: {
        locateControl: async (query) =>
          query.control === "username_input" ? { selector: "#legacy-user" } : null,
      },
      now: NOW,
    });

    expect(record.outcome).toBe("extracted");
    expect(record.jobIds).toHaveLength(1);
  });
});

// --- 3. The no-credential-leak gate ------------------------------------------

describe("no-credential-leak gate", () => {
  it("a dashboard that echoes the username leaks NOTHING to any persisted surface", async () => {
    const store = makeStore();
    const profile = ASTRA_ADAPTER_PROFILES[0]!;
    await seedConnection(store, profile);

    // The control: the fixture genuinely renders the username (and the
    // statement carries it in a contact column) — this test proves the
    // redaction gate, not a fixture that never had the secret.
    const echoCatalog = composeFixtureCatalog([profile], CREDENTIALS, true);
    const dashboard = echoCatalog.pages.find((p) => p.url === profile.dashboardUrl)!;
    expect(dashboard.html).toContain(USERNAME);

    const { summary, traversals } = await runAstraSweep({
      store,
      openSession: async () => openFixtureSession(echoCatalog),
      now: NOW,
    });

    const connection = await lastConnection(store);
    const secrets = [
      USERNAME,
      PASSWORD,
      connection!.username_encrypted,
      connection!.password_encrypted,
    ];

    // Every persisted surface, scrubbed:
    const surfaces: string[] = [];
    for (const ingest of await store.listStatementIngests()) {
      surfaces.push(ingest.content, ingest.file_name, ingest.error ?? "");
    }
    for (
      let claimed = await store.claimReconJob(new Date(), null);
      claimed;
      claimed = await store.claimReconJob(new Date(), null)
    ) {
      surfaces.push(claimed.error ?? "", JSON.stringify(claimed.result ?? {}));
    }
    for (const record of traversals) {
      for (const artifact of record.artifacts) {
        surfaces.push(artifact.content, artifact.label);
      }
      for (const statement of record.statements) {
        surfaces.push(statement.content, statement.fileName);
      }
      if (record.error !== null) {
        surfaces.push(record.error);
      }
    }
    surfaces.push(JSON.stringify(summary));

    for (const secret of secrets) {
      for (const surface of surfaces) {
        expect(surface).not.toContain(secret);
      }
    }

    // And the sweep still did its job — extraction happened through the gate.
    expect(summary.extracted).toBe(1);
    expect(summary.statementsCaptured).toBe(1);
  });
});

// --- Backend parity for the traversal store methods ---------------------------

describe("traversal store methods on SqliteStore", () => {
  it("the provenance semantics hold on the SQL backend too", async () => {
    const store = new SqliteStore(":memory:");
    const profile = ASTRA_ADAPTER_PROFILES[0]!;
    await seedConnection(store, profile);

    const record = await traverseConnection(await lastConnection(store), fixtureDeps(store, [profile]));
    expect(record.outcome).toBe("extracted");

    const verified = await lastConnection(store);
    expect(verified!.last_verified_at).not.toBeNull();
    expect(verified!.last_error).toBeNull();
    expect(verified!.status).toBe("connected");
  });
});
