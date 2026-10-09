import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../route";
import { getDb } from "@/lib/db";
import { REGISTER_RATE_LIMIT, checkSharedRateLimit, resetRateLimits } from "@/lib/server/rateLimit";

/**
 * POST /api/covnant/auth/signup contract tests (instant sign-up, the
 * signup-merge union contract).
 *
 * Against the authoritative live schema: the creator payload is validated
 * (the nine named codes), the Supabase auth core is mocked at the client
 * boundary, and the registry is checked BEFORE signUp (ordering invariant):
 * a legacy holder (registry hit, no auth) claims with a status-only 200 and
 * NO second UCT; an existing account gets 409 duplicate_email; a fresh
 * email runs the full 201 flow. The holder is registered in a designated
 * cbt_assets registry row (cbt_code 'CBT-SIGNUP-REGISTRY') with the EXACT
 * PR #26 holder entry shape plus the normalized email identity, then
 * provisioned through the shared core with the pinned Increase
 * POST /account_numbers call mocked — no network, no database, no real
 * secrets. PENDING responses must never carry account/routing numbers, and
 * any failure after the auth signup must compensate (delete profile row +
 * auth user).
 */

const supabaseMock = vi.hoisted(() => ({
  readSupabaseEnv: vi.fn(),
  signUp: vi.fn(),
  deleteUser: vi.fn(),
  profileInsertSingle: vi.fn(),
  profileDeleteEq: vi.fn(),
}));

vi.mock("@/lib/server/supabase", () => ({
  readSupabaseEnv: supabaseMock.readSupabaseEnv,
  createAuthClient: () => ({ auth: { signUp: supabaseMock.signUp } }),
  createAdminClient: () => ({
    auth: {
      admin: {
        deleteUser: supabaseMock.deleteUser,
      },
    },
    from: () => ({
      insert: () => ({
        select: () => ({ single: supabaseMock.profileInsertSingle }),
      }),
      delete: () => ({ eq: supabaseMock.profileDeleteEq }),
    }),
  }),
}));

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));

const mockGetDb = vi.mocked(getDb);

const EMAIL = "creator@example.com";
const REGISTRY_ASSET_ID = "b2c3d4e5-0000-4000-8000-000000000002";
const AUTH_USER = { id: "auth_user_1", email: EMAIL, email_confirmed_at: null };
const SUPABASE_ENV = {
  url: "https://test-project.supabase.co",
  anonKey: "test-anon-key",
  serviceRoleKey: "test-service-role-key",
};

/** The duplicate signal Supabase sends instead of an error (anti-enumeration). */
const DUPLICATE_USER = { ...AUTH_USER, identities: [] };

function createUserOk(user: Record<string, unknown> | null) {
  return { data: { user }, error: null };
}

/** A valid full creator payload — every test overrides the one bad field. */
function fullPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    stage_name: "Nova Reign",
    legal_name: "Jordan A. Reyes",
    email: EMAIL,
    phone: "+15125550123",
    core_industry: "Music — Recording",
    title: "Recording Artist",
    password: "correct-horse-battery",
    udr_terms_accepted: true,
    ...overrides,
  };
}

function creatorProfileRow(): Record<string, unknown> {
  return {
    id: AUTH_USER.id,
    stage_name: "Nova Reign",
    legal_name: "Jordan A. Reyes",
    email: EMAIL,
    phone: "+15125550123",
    phone_verified_at: null,
    core_industry: "Music — Recording",
    title: "Recording Artist",
    udr_terms_accepted_at: "2026-09-09T00:00:00.000Z",
  };
}

function signupHolderEntry(): Record<string, unknown> {
  return {
    rightsHolderId: "rh_signup_existing",
    name: EMAIL,
    role: "COMPOSER",
    email: EMAIL,
    payoutRouting: {},
  };
}

function provisionedHolderEntry(): Record<string, unknown> {
  return {
    ...signupHolderEntry(),
    payoutRouting: {
      covenantVirtualAccount: {
        accountNumberId: "account_number_existing",
        accountNumber: "987654321",
        routingNumber: "101050001",
        provisionedAt: "2026-01-01T00:00:00Z",
      },
    },
  };
}

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

/**
 * A stateful db fake modeling the registry row: find-or-create via
 * pg_advisory_xact_lock + cbt_code FOR UPDATE + INSERT, holder append via
 * the jsonb concat, and the shared core's jsonb lookups/rewrites. The
 * top-level query surface models the ordering peek (read-only, no FOR
 * UPDATE) and records every statement for the ordering assertions.
 */
function fakeDb(
  options: {
    registry?: { id: string; rights_holders: unknown[] };
    dropAppendedHolder?: boolean;
    /** 1-indexed db.transaction call to reject (transient DB failure). */
    rejectTransactionCall?: number;
  } = {},
) {
  let registry = options.registry
    ? {
        ...options.registry,
        rights_holders: [...options.registry.rights_holders],
      }
    : null;
  const txQueries: QueryCall[] = [];
  const txQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    txQueries.push({ sql, params });
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes("jsonb_agg")) {
      const holderId = params?.[1];
      const updated = JSON.parse(String(params?.[2]));
      if (registry) {
        registry.rights_holders = registry.rights_holders.map((holder) =>
          (holder as { rightsHolderId?: unknown }).rightsHolderId === holderId
            ? updated
            : holder,
        );
      }
      return { rows: [] };
    }
    if (sql.includes("jsonb_array_elements")) {
      const holderId = params?.[1];
      const holder =
        registry?.rights_holders.find(
          (candidate) =>
            (candidate as { rightsHolderId?: unknown }).rightsHolderId ===
            holderId,
        ) ?? null;
      return holder ? { rows: [{ holder }] } : { rows: [] };
    }
    if (sql.includes("cbt_code = $1")) {
      return registry
        ? {
            rows: [
              { id: registry.id, rights_holders: registry.rights_holders },
            ],
          }
        : { rows: [] };
    }
    if (sql.includes("INSERT INTO cbt_assets")) {
      registry = { id: REGISTRY_ASSET_ID, rights_holders: [] };
      return { rows: [{ id: registry.id, rights_holders: [] }] };
    }
    if (sql.includes("|| $2::jsonb")) {
      if (registry && !options.dropAppendedHolder) {
        registry.rights_holders.push(JSON.parse(String(params?.[1])));
      }
      return { rows: [] };
    }
    return { rows: [] };
  });
  const tx = { query: txQuery };
  // The shared (Postgres-backed) rate limiter's three statements (bug-hunt
  // C9): the route's limiter call runs against this fake in store-backed
  // mode, so the fake honors the same fixed-window upsert the real store
  // does — DDL idempotent, ONE upsert RETURNING the post-write count, and
  // the sweep DELETE. BIGINT comes back as a string, as pg hands it over.
  const rateBuckets = new Map<string, { window_start_ms: number; hit_count: number }>();
  const dbQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("CREATE TABLE IF NOT EXISTS rate_limit_buckets")) {
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO rate_limit_buckets")) {
      const [key, nowMs, windowMs] = params as [string, number, number];
      const existing = rateBuckets.get(key);
      const row =
        existing === undefined || existing.window_start_ms + (windowMs ?? 0) <= (nowMs ?? 0)
          ? { window_start_ms: nowMs ?? 0, hit_count: 1 }
          : { window_start_ms: existing.window_start_ms, hit_count: existing.hit_count + 1 };
      rateBuckets.set(key, row);
      return {
        rows: [
          { hit_count: row.hit_count, window_start_ms: String(row.window_start_ms) },
        ],
      };
    }
    if (sql.includes("DELETE FROM rate_limit_buckets")) {
      return { rows: [] };
    }
    if (sql.includes("cbt_code = $1") && !sql.includes("FOR UPDATE")) {
      return registry
        ? {
            rows: [
              { id: registry.id, rights_holders: registry.rights_holders },
            ],
          }
        : { rows: [] };
    }
    return { rows: [] };
  });
  let transactionCalls = 0;
  const db = {
    query: dbQuery,
    transaction: vi.fn(
      async <T>(
        work: (tx: { query: typeof txQuery }) => Promise<T>,
      ): Promise<T> => {
        transactionCalls += 1;
        if (options.rejectTransactionCall === transactionCalls) {
          throw new Error("connection terminated unexpectedly");
        }
        return work(tx);
      },
    ),
  };
  return { db, dbQuery, txQueries, getRegistry: () => registry };
}

function stubIncreaseAccountNumber(
  responses: Array<Response | Error>,
): ReturnType<typeof vi.fn> {
  const fetchMock =
    vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >();
  for (const response of responses) {
    if (response instanceof Error) {
      fetchMock.mockRejectedValueOnce(response);
    } else {
      fetchMock.mockResolvedValueOnce(response);
    }
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function increaseAccountNumberResponse(
  overrides: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      id: "account_number_v18nkfqm6afpsrvy82b2",
      account_number: "987654321",
      routing_number: "101050001",
      created_at: "2026-09-07T00:00:00Z",
      status: "active",
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function signupRequest(body: unknown, identity?: string): Request {
  return new Request("http://localhost/api/covnant/auth/signup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(identity ? { "x-forwarded-for": identity } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  supabaseMock.readSupabaseEnv.mockReturnValue(SUPABASE_ENV);
  supabaseMock.signUp.mockResolvedValue(createUserOk(AUTH_USER));
  supabaseMock.profileInsertSingle.mockResolvedValue({
    data: creatorProfileRow(),
    error: null,
  });
  supabaseMock.deleteUser.mockResolvedValue({ error: null });
  supabaseMock.profileDeleteEq.mockResolvedValue({ error: null });
  resetRateLimits();
  vi.stubEnv("INCREASE_API_KEY", "test-increase-key");
  vi.stubEnv("INCREASE_SOURCE_ACCOUNT_ID", "account_in71c4amph0vgo2qllky");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetRateLimits();
});

function expectNoAccountNumbers(bodyJson: unknown): void {
  const text = JSON.stringify(bodyJson);
  expect(text).not.toContain("accountNumber");
  expect(text).not.toContain("routingNumber");
  expect(text).not.toContain("987654321");
  expect(text).not.toContain("101050001");
  expect(text).not.toContain("account_number_");
}

describe("POST /api/covnant/auth/signup", () => {
  describe("request validation — the nine named codes", () => {
    it.each([
      ["a missing stage name", { stage_name: undefined }, "missing_stage_name"],
      ["a blank legal name", { legal_name: "   " }, "missing_legal_name"],
      ["an invalid email", { email: "not-an-email" }, "invalid_email"],
      [
        "a phone that cannot be a real number",
        { phone: "830-358-2306 ext 5" },
        "invalid_phone",
      ],
      [
        "a missing core industry",
        { core_industry: "" },
        "missing_core_industry",
      ],
      ["a missing title", { title: undefined }, "missing_title"],
      ["an oversized password", { password: "short" }, "invalid_password"],
      [
        "unsigned UDR terms",
        { udr_terms_accepted: false },
        "udr_terms_required",
      ],
    ])(
      "rejects %s with 422 %s before any auth or registry write",
      async (_label, overrides, code) => {
        const { db, getRegistry } = fakeDb();
        mockGetDb.mockReturnValue(db as never);
        const res = await POST(signupRequest(fullPayload(overrides)));
        expect(res.status).toBe(422);
        const bodyJson = (await res.json()) as { ok: boolean; reason?: string };
        expect(bodyJson).toMatchObject({ ok: false, reason: code });
        expect(supabaseMock.signUp).not.toHaveBeenCalled(); // validation precedes auth
        expect(getRegistry()).toBeNull(); // zero state
      },
    );

    it("rejects a non-JSON body with 400", async () => {
      const { db } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(signupRequest("{not-json"));
      expect(res.status).toBe(400);
      const bodyJson = (await res.json()) as { ok: boolean; reason?: string };
      expect(bodyJson.reason).toBe("malformed_body");
    });

    it.each([
      ["null body", "null"],
      ["array body", '["someone@example.com"]'],
    ])(
      "rejects a %s with 400 malformed_body without echoing the input",
      async (_label, raw) => {
        const { db } = fakeDb();
        mockGetDb.mockReturnValue(db as never);
        const res = await POST(signupRequest(raw));
        expect(res.status).toBe(400);
        const bodyJson = (await res.json()) as { ok: boolean; reason?: string };
        expect(bodyJson).toMatchObject({ ok: false, reason: "malformed_body" });
        const text = JSON.stringify(bodyJson);
        expect(text).not.toContain("someone@example.com"); // input never echoed
      },
    );
  });

  describe("environment fail-closed", () => {
    it("returns 503 supabase_not_configured before any auth call or registry write", async () => {
      supabaseMock.readSupabaseEnv.mockReturnValueOnce(null);
      const { db, getRegistry } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(503);
      const bodyJson = (await res.json()) as { ok: boolean; reason?: string };
      expect(bodyJson).toMatchObject({
        ok: false,
        reason: "supabase_not_configured",
      });
      expect(supabaseMock.signUp).not.toHaveBeenCalled();
      expect(getRegistry()).toBeNull();
    });

    it("returns a fail-closed 503 when the database is unconfigured", async () => {
      mockGetDb.mockReturnValue(null);
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(503);
      const bodyJson = (await res.json()) as { ok: boolean; reason?: string };
      expect(bodyJson.ok).toBe(false);
      expect(supabaseMock.signUp).not.toHaveBeenCalled();
    });

    it("registers the creator and returns the 201 union with PENDING when INCREASE_API_KEY is unconfigured", async () => {
      vi.stubEnv("INCREASE_API_KEY", "");
      const { db, getRegistry } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([]);
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as {
        ok: boolean;
        created?: boolean;
        status?: string;
        reason?: string;
        alreadyRegistered?: boolean;
        session?: unknown;
        user?: unknown;
        profile?: unknown;
      };
      expect(bodyJson).toMatchObject({
        ok: true,
        created: true,
        status: "PENDING",
        reason: "INCREASE_NOT_CONFIGURED",
        alreadyRegistered: false,
      });
      // The union: session (null when email confirmation is on), user, profile.
      expect(bodyJson.session).toBeNull();
      expect(bodyJson.user).toMatchObject({ id: AUTH_USER.id, email: EMAIL });
      expect(bodyJson.profile).toMatchObject({
        email: EMAIL,
        stage_name: "Nova Reign",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getRegistry()?.rights_holders).toHaveLength(1);
      expectNoAccountNumbers(bodyJson);
    });

    it("registers the creator with PENDING when INCREASE_SOURCE_ACCOUNT_ID is unconfigured", async () => {
      vi.stubEnv("INCREASE_SOURCE_ACCOUNT_ID", "");
      const { db, getRegistry } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([]);
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as {
        status: string;
        reason?: string;
      };
      expect(bodyJson).toMatchObject({
        status: "PENDING",
        reason: "INCREASE_NOT_CONFIGURED",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getRegistry()?.rights_holders).toHaveLength(1);
    });
  });

  describe("happy path", () => {
    it("creates the account, registers the holder, provisions through Increase, and returns the 201 union", async () => {
      const { db, txQueries, getRegistry } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([
        increaseAccountNumberResponse(),
      ]);
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as {
        ok: boolean;
        created?: boolean;
        status?: string;
        alreadyRegistered?: boolean;
        rightsHolderId?: string;
        assetId?: string;
        uct?: string;
        session?: unknown;
        user?: unknown;
        profile?: unknown;
      };
      expect(bodyJson).toMatchObject({
        ok: true,
        created: true,
        status: "PROVISIONED",
        alreadyRegistered: false,
        assetId: REGISTRY_ASSET_ID,
      });
      expect(typeof bodyJson.rightsHolderId).toBe("string");
      expect(bodyJson.uct).toMatch(
        /^UCT-[A-Z]{2}-\d{4}-[0-9A-F]{8}-[0-9A-Z]{2}$/,
      );
      // The union rides the 201 only.
      expect(bodyJson.session).toBeNull();
      expect(bodyJson.user).toMatchObject({ id: AUTH_USER.id });
      expect(bodyJson.profile).toMatchObject({
        id: AUTH_USER.id,
        email: EMAIL,
      });
      expectNoAccountNumbers(bodyJson);

      // Pinned Increase Account Number creation contract (shared core).
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.increase.com/account_numbers");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-increase-key");
      expect(headers["Idempotency-Key"]).toBe(
        `covenant-royalty-tracking:${REGISTRY_ASSET_ID}:${bodyJson.rightsHolderId}`,
      );
      expect(JSON.parse(String(init.body))).toEqual({
        account_id: "account_in71c4amph0vgo2qllky",
        name: "Covnant royalty payout",
        inbound_ach: { debit_status: "blocked" },
      });

      // The EXACT PR #26 holder entry shape, with the email identity, plus
      // the persisted covenantVirtualAccount block.
      const holders = getRegistry()?.rights_holders ?? [];
      expect(holders).toHaveLength(1);
      const entry = holders[0] as {
        rightsHolderId: string;
        name: string;
        role: string;
        email: string;
        payoutRouting: { covenantVirtualAccount: Record<string, string> };
      };
      expect(entry).toMatchObject({
        rightsHolderId: bodyJson.rightsHolderId,
        name: EMAIL,
        role: "COMPOSER",
        email: EMAIL,
      });
      expect(entry.payoutRouting.covenantVirtualAccount).toEqual({
        accountNumberId: "account_number_v18nkfqm6afpsrvy82b2",
        accountNumber: "987654321",
        routingNumber: "101050001",
        provisionedAt: "2026-09-07T00:00:00Z",
      });

      // Zero money movement: no ledger queries anywhere in the flow.
      const allSql = txQueries.map((q) => q.sql).join("\n");
      expect(allSql).not.toContain("universal_royalty_ledger");
      expect(allSql).not.toContain("FROM rights_holders");
      expect(allSql).not.toContain("disbursements");
    });

    it("returns a sessionless 201 — signUp dispatches the confirmation email and mints no session", async () => {
      supabaseMock.signUp.mockResolvedValue(createUserOk(AUTH_USER));
      vi.stubEnv("INCREASE_API_KEY", "");
      const { db } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as {
        session?: unknown;
        user?: unknown;
      };
      expect(bodyJson.session).toBeNull();
      expect(bodyJson.user).toMatchObject({ id: AUTH_USER.id, email: EMAIL });
    });
  });

  describe("ordering invariant — registry before signUp", () => {
    it("peeks the registry (read-only) before calling signUp", async () => {
      const { db, dbQuery } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      await POST(signupRequest(fullPayload()));
      expect(dbQuery).toHaveBeenCalled();
      expect(supabaseMock.signUp).toHaveBeenCalled();
      expect(dbQuery.mock.invocationCallOrder[0]).toBeLessThan(
        supabaseMock.signUp.mock.invocationCallOrder[0],
      );
      // The peek takes no row lock — the FOR UPDATE discipline stays inside
      // the registry transaction.
      expect(String(dbQuery.mock.calls[0][0])).not.toContain("FOR UPDATE");
    });
  });

  describe("legacy claim — registry hit without an auth account", () => {
    it("creates the account + profile and returns the status-only 200 with NO second UCT mint", async () => {
      const registry = {
        id: REGISTRY_ASSET_ID,
        rights_holders: [signupHolderEntry()],
      };
      vi.stubEnv("INCREASE_API_KEY", "");
      const { db, getRegistry } = fakeDb({ registry });
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([]);
      const res = await POST(
        signupRequest(fullPayload({ email: `  ${EMAIL.toUpperCase()}  ` })),
      );
      expect(res.status).toBe(200);
      const bodyJson = (await res.json()) as Record<string, unknown>;
      expect(bodyJson).toMatchObject({
        ok: true,
        created: false,
        status: "PENDING",
        reason: "INCREASE_NOT_CONFIGURED",
        alreadyRegistered: true,
        rightsHolderId: "rh_signup_existing",
        assetId: REGISTRY_ASSET_ID,
      });
      // Status-only: no uct block and no credential material on a 200.
      for (const key of [
        "uct",
        "uctCreatedAt",
        "jurisdiction",
        "engine",
        "session",
        "user",
        "profile",
      ]) {
        expect(key in bodyJson).toBe(false);
      }
      // Account + profile created this call.
      expect(supabaseMock.signUp).toHaveBeenCalledTimes(1);
      expect(supabaseMock.profileInsertSingle).toHaveBeenCalledTimes(1);
      // NO second UCT: the registry is untouched — no mint, no rewrite.
      expect(getRegistry()?.rights_holders).toHaveLength(1);
      expect(
        "uct" in (getRegistry()?.rights_holders[0] as Record<string, unknown>),
      ).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(supabaseMock.deleteUser).not.toHaveBeenCalled();
      expectNoAccountNumbers(bodyJson);
    });

    it("completes pending provisioning when credentials arrive and the holder claims", async () => {
      const registry = {
        id: REGISTRY_ASSET_ID,
        rights_holders: [signupHolderEntry()],
      };
      const { db, getRegistry } = fakeDb({ registry });
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([
        increaseAccountNumberResponse(),
      ]);
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(200);
      const bodyJson = (await res.json()) as {
        status: string;
        alreadyRegistered: boolean;
      };
      expect(bodyJson).toMatchObject({
        status: "PROVISIONED",
        alreadyRegistered: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const holders = getRegistry()?.rights_holders ?? [];
      expect(holders).toHaveLength(1);
      const entry = holders[0] as {
        payoutRouting: { covenantVirtualAccount?: Record<string, string> };
      };
      expect(entry.payoutRouting.covenantVirtualAccount).toMatchObject({
        accountNumberId: "account_number_v18nkfqm6afpsrvy82b2",
      });
      expectNoAccountNumbers(bodyJson);
    });

    it("does not call Increase again when the claimed holder is already provisioned", async () => {
      const registry = {
        id: REGISTRY_ASSET_ID,
        rights_holders: [provisionedHolderEntry()],
      };
      const { db } = fakeDb({ registry });
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([]);
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(200);
      const bodyJson = (await res.json()) as {
        status: string;
        alreadyRegistered: boolean;
      };
      expect(bodyJson).toMatchObject({
        status: "PROVISIONED",
        alreadyRegistered: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expectNoAccountNumbers(bodyJson);
    });
  });

  describe("duplicate_email — registry hit where an auth account exists", () => {
    it("returns 409 duplicate_email on the identities-empty anti-enumeration signal", async () => {
      const registry = {
        id: REGISTRY_ASSET_ID,
        rights_holders: [signupHolderEntry()],
      };
      const { db, getRegistry } = fakeDb({ registry });
      mockGetDb.mockReturnValue(db as never);
      supabaseMock.signUp.mockResolvedValue(createUserOk(DUPLICATE_USER));
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(409);
      const bodyJson = (await res.json()) as { ok: boolean; reason?: string };
      expect(bodyJson).toMatchObject({ ok: false, reason: "duplicate_email" });
      // No compensation — the account already existed; nothing was created.
      expect(supabaseMock.deleteUser).not.toHaveBeenCalled();
      expect(supabaseMock.profileDeleteEq).not.toHaveBeenCalled();
      expect(supabaseMock.profileInsertSingle).not.toHaveBeenCalled();
      expect(getRegistry()?.rights_holders).toHaveLength(1);
      expectNoAccountNumbers(bodyJson);
    });

    it("returns 409 when signUp reports the duplicate in its error message", async () => {
      const registry = {
        id: REGISTRY_ASSET_ID,
        rights_holders: [signupHolderEntry()],
      };
      const { db } = fakeDb({ registry });
      mockGetDb.mockReturnValue(db as never);
      supabaseMock.signUp.mockResolvedValue({
        data: { user: null },
        error: { message: "User already registered" },
      });
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(409);
      const bodyJson = (await res.json()) as { ok: boolean; reason?: string };
      expect(bodyJson).toMatchObject({ ok: false, reason: "duplicate_email" });
      expect(supabaseMock.deleteUser).not.toHaveBeenCalled();
    });
  });

  describe("compensation — failures after the auth signup", () => {
    it("deletes the profile row and the auth user when the registry stage fails", async () => {
      const failingDb = {
        query: vi.fn(async () => ({ rows: [] })),
        transaction: vi.fn(async () => {
          throw new Error("boom secret storage detail");
        }),
      };
      mockGetDb.mockReturnValue(failingDb as never);
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(500);
      const bodyJson = (await res.json()) as {
        ok: boolean;
        error: string;
        reason?: string;
      };
      expect(bodyJson).toMatchObject({
        ok: false,
        error: "Signup registration failed.",
        reason: "registration_failed",
      });
      expect(supabaseMock.profileDeleteEq).toHaveBeenCalled();
      expect(supabaseMock.deleteUser).toHaveBeenCalledTimes(1);
      const text = JSON.stringify(bodyJson);
      expect(text).not.toContain("boom");
      expect(text).not.toContain("storage");
    });

    it("deletes the auth user when the profile insert fails (auth core compensation)", async () => {
      const { db, getRegistry } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      supabaseMock.profileInsertSingle.mockResolvedValue({
        data: null,
        error: {
          message:
            'duplicate key value violates unique constraint "creator_profiles_email_key"',
        },
      });
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(500);
      const bodyJson = (await res.json()) as {
        ok: boolean;
        error: string;
        reason?: string;
      };
      expect(bodyJson).toMatchObject({
        ok: false,
        error: "Failed to persist the creator profile.",
        reason: "profile_insert_failed",
      });
      expect(supabaseMock.deleteUser).toHaveBeenCalledTimes(1);
      expect(supabaseMock.profileDeleteEq).toHaveBeenCalled();
      const text = JSON.stringify(bodyJson);
      expect(text).not.toContain("unique constraint");
      expect(getRegistry()).toBeNull(); // registry stage never ran
    });

    it("compensates the auth signup when provisioning faults on the fresh path", async () => {
      const { db } = fakeDb({ dropAppendedHolder: true });
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([increaseAccountNumberResponse()]);
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(500);
      const bodyJson = (await res.json()) as {
        ok: boolean;
        error: string;
        reason?: string;
      };
      expect(bodyJson).toMatchObject({
        ok: false,
        error: "Signup could not complete provisioning.",
        reason: "provisioning_failed",
      });
      expect(supabaseMock.deleteUser).toHaveBeenCalledTimes(1);
      expect(supabaseMock.profileDeleteEq).toHaveBeenCalled();
      const text = JSON.stringify(bodyJson);
      expect(text).not.toContain("HOLDER_NOT_FOUND");
    });

    it("compensates the auth signup when the provisioning phase-1 transaction rejects", async () => {
      // Transaction call 1 is the registry find-or-create; call 2 is the
      // provisioning core's phase 1 — a transient DB failure there must
      // surface as a compensated, sanitized 500 (an outcome mapped through
      // the shared core's PERSISTENCE_FAILED), never an unhandled route
      // throw that skips the compensation walk.
      const { db } = fakeDb({ rejectTransactionCall: 2 });
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([
        increaseAccountNumberResponse(),
      ]);
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(500);
      const bodyJson = (await res.json()) as {
        ok: boolean;
        error: string;
        reason?: string;
      };
      expect(bodyJson).toMatchObject({
        ok: false,
        error: "Signup could not complete provisioning.",
        reason: "provisioning_failed",
      });
      // The compensation walk ran: profile row + auth user deleted.
      expect(supabaseMock.deleteUser).toHaveBeenCalledTimes(1);
      expect(supabaseMock.profileDeleteEq).toHaveBeenCalled();
      // Phase 1 fails before the Increase call — no leaked account number.
      expect(fetchMock).not.toHaveBeenCalled();
      // Sanitized: the raw transaction error never reaches the client.
      const text = JSON.stringify(bodyJson);
      expect(text).not.toContain("connection terminated");
    });

    it("retries clean after the compensated phase-1 failure — no duplicate_email wedge", async () => {
      // Before the fix the phase-1 rejection threw past the outcome
      // mapping: compensation never ran, the committed auth account
      // survived, and every retry of the same email 409'd duplicate_email
      // forever. After the fix the retry takes the claim path and
      // completes provisioning.
      const { db, getRegistry } = fakeDb({ rejectTransactionCall: 2 });
      mockGetDb.mockReturnValue(db as never);
      const fetchMock = stubIncreaseAccountNumber([
        increaseAccountNumberResponse(),
      ]);
      const first = await POST(signupRequest(fullPayload()));
      expect(first.status).toBe(500);
      expect(supabaseMock.deleteUser).toHaveBeenCalledTimes(1);

      const retry = await POST(signupRequest(fullPayload()));
      expect(retry.status).toBe(200); // NOT the 409 duplicate_email wedge
      const bodyJson = (await retry.json()) as {
        ok: boolean;
        created?: boolean;
        status?: string;
        reason?: string;
        alreadyRegistered?: boolean;
        assetId?: string;
      };
      expect(bodyJson).toMatchObject({
        ok: true,
        created: false,
        status: "PROVISIONED",
        alreadyRegistered: true,
        assetId: REGISTRY_ASSET_ID,
      });
      // Only the retry reached Increase (the failed attempt died in phase 1).
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The retry claimed the existing holder — no duplicate entry, and
      // provisioning persisted the virtual account on it.
      const holders = getRegistry()?.rights_holders ?? [];
      expect(holders).toHaveLength(1);
      const entry = holders[0] as {
        payoutRouting: { covenantVirtualAccount?: Record<string, string> };
      };
      expect(entry.payoutRouting.covenantVirtualAccount).toMatchObject({
        accountNumberId: "account_number_v18nkfqm6afpsrvy82b2",
      });
      expectNoAccountNumbers(bodyJson);
    });
  });

  describe("rate limiting (per-IP)", () => {
    it("returns 429 rate_limited after REGISTER_RATE_LIMIT requests from one address", async () => {
      vi.stubEnv("INCREASE_API_KEY", "");
      const { db, getRegistry } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      for (let i = 0; i < REGISTER_RATE_LIMIT.limit; i += 1) {
        const res = await POST(
          signupRequest(fullPayload({ email: `creator${i}@example.com` })),
        );
        expect(res.status).toBe(201);
      }
      const blocked = await POST(
        signupRequest(fullPayload({ email: "overflow@example.com" })),
      );
      expect(blocked.status).toBe(429);
      const bodyJson = (await blocked.json()) as {
        ok: boolean;
        reason?: string;
      };
      expect(bodyJson).toMatchObject({ ok: false, reason: "rate_limited" });
      // The 429 fired after validation but before auth — no account attempted.
      expect(supabaseMock.signUp).toHaveBeenCalledTimes(
        REGISTER_RATE_LIMIT.limit,
      );
      expect(getRegistry()?.rights_holders).toHaveLength(
        REGISTER_RATE_LIMIT.limit,
      );
    });

    it("enforces the SHARED budget across isolates — a cold isolate's in-memory map cannot resurrect it", async () => {
      vi.stubEnv("INCREASE_API_KEY", "");
      const { db } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      // Isolate A: the address's budget is spent straight through the
      // shared store; the in-memory limiter never sees a request.
      for (let i = 0; i < REGISTER_RATE_LIMIT.limit; i += 1) {
        expect(
          (
            await checkSharedRateLimit(
              "covnant-signup:203.0.113.9",
              REGISTER_RATE_LIMIT,
            )
          ).ok,
        ).toBe(true);
      }
      // Isolate B: a fresh isolate (cold in-memory map) serves the request.
      resetRateLimits();
      const blocked = await POST(
        signupRequest(
          fullPayload({ email: "cross-isolate@example.com" }),
          "203.0.113.9",
        ),
      );
      expect(blocked.status).toBe(429);
      const bodyJson = (await blocked.json()) as {
        ok: boolean;
        reason?: string;
      };
      expect(bodyJson).toMatchObject({ ok: false, reason: "rate_limited" });
      // The shared verdict fired before auth — no account attempted.
      expect(supabaseMock.signUp).not.toHaveBeenCalled();
    });
  });

  describe("Increase transient failure", () => {
    it("keeps the signup successful with PENDING when Increase is unreachable", async () => {
      const { db } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([
        new Error("connect ECONNREFUSED increase.example"),
      ]);
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as {
        ok: boolean;
        status: string;
        reason?: string;
      };
      expect(bodyJson).toMatchObject({
        ok: true,
        status: "PENDING",
        reason: "INCREASE_UNAVAILABLE",
      });
      expectNoAccountNumbers(bodyJson);
    });

    it("keeps the signup successful with PENDING when Increase rejects the call", async () => {
      const { db, getRegistry } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([
        new Response('{"error":"upstream down"}', { status: 500 }),
      ]);
      const res = await POST(signupRequest(fullPayload()));
      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as {
        status: string;
        reason?: string;
      };
      expect(bodyJson).toMatchObject({
        status: "PENDING",
        reason: "INCREASE_UNAVAILABLE",
      });
      const text = JSON.stringify(bodyJson);
      expect(text).not.toContain("upstream down");
      expect(getRegistry()?.rights_holders).toHaveLength(1);
      expectNoAccountNumbers(bodyJson);
    });
  });

  describe("schema hygiene", () => {
    it("issues no money-movement or banking-era schema queries", async () => {
      const { db, txQueries } = fakeDb();
      mockGetDb.mockReturnValue(db as never);
      stubIncreaseAccountNumber([increaseAccountNumberResponse()]);
      await POST(signupRequest(fullPayload()));
      const allSql = txQueries.map((q) => q.sql).join("\n");
      expect(allSql).not.toContain("universal_royalty_ledger");
      expect(allSql).not.toContain("FROM rights_holders");
      expect(allSql).not.toContain("disbursements");
      expect(allSql).not.toContain("gross_settled");
    });
  });
});
