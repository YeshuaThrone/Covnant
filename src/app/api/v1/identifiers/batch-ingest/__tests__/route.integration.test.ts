/**
 * Real-PostgreSQL ingestion integration suite — the founder's v22 suite,
 * canon v25/v23 extensions, run against a live PostgreSQL with the
 * validate_global_identifier trigger active (migration 0012 + 0015).
 *
 * Requires TEST_DATABASE_URL. Skips cleanly when absent (unit gates still
 * run everywhere); CI's identifier-engine job provisions postgres:16-alpine
 * + redis:7-alpine per canon v16 and sets the variable.
 *
 * The v22 fallback bootstrap DDL below is HARMONIZED to the canonical
 * composite uniqueness (canon v23 Ruling 2) — it is a NO-OP once migration
 * 0012 is applied, and exists only for a bare database.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GLOBAL_IDENTIFIER_PATTERNS } from '@/lib/identifiers/globalIdentifiers';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

if (TEST_DATABASE_URL) {
  // Bind the route's lazy pool to the scratch database before first use.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
}

/** The founder's v22 fallback bootstrap DDL, harmonized to canon v23 Ruling 2. */
const FALLBACK_BOOTSTRAP_DDL = `
-- Bare-database bootstrap fallback ONLY (no-op once 0012 is applied).
CREATE TABLE IF NOT EXISTS universal_identity_map (
    map_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL,
    vertical_category VARCHAR(64) NOT NULL,
    primary_code_type VARCHAR(64) NOT NULL,
    primary_code_value VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_code_per_type UNIQUE (primary_code_type, primary_code_value)
);
CREATE TABLE IF NOT EXISTS global_identifier_cross_ref (
    ref_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    map_id UUID REFERENCES universal_identity_map(map_id) ON DELETE CASCADE,
    linked_code_type VARCHAR(64) NOT NULL,
    linked_code_value VARCHAR(255) NOT NULL,
    verification_source VARCHAR(128) NOT NULL,
    verified_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_cross_reference UNIQUE (map_id, linked_code_type, linked_code_value)
);
-- Bare-database envelope for the post-commit event seam (canon v13): the
-- exact column surface emitIngestionEvent writes. NO-OP once 0011 is
-- applied — in full deployments the canonical 0011 table stands.
CREATE TABLE IF NOT EXISTS royalty_recon_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function applyMigration(pool: Pool, file: string): Promise<void> {
  const sql = await readFile(
    path.join(process.cwd(), 'supabase', 'migrations', file),
    'utf8',
  );
  await pool.query(sql);
}

describeIntegration('batch-ingest against real PostgreSQL (canon v22 suite)', () => {
  let pool: Pool;
  let app: http.Server;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });

    // Supabase-auth shim (test-only, mirrors .github/workflows/ci.yml):
    // migration 0012 grants to the Supabase service_role, which vanilla
    // Postgres lacks. Conditional — a no-op where the role already exists.
    await pool.query(`
      do $$ begin
        if not exists (select from pg_roles where rolname = 'service_role') then
          create role service_role nologin;
        end if;
      end $$;
    `);

    // Canonical schema first: 0012 (identity + cross-ref + trigger) then the
    // additive 0015 (74-branch trigger). The founder's fallback DDL runs
    // last as a no-op sanity net for bare databases.
    await applyMigration(pool, '0012_universal_identity.sql');
    await applyMigration(pool, '0015_spatial_web3_identifiers.sql');
    await pool.query(FALLBACK_BOOTSTRAP_DDL);

    const { POST } = await import('../route');
    app = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      // Node headers can be string[] — take the first value for the Web API.
      const tenantHeader = req.headers['x-tenant-id'];
      const tenantId = Array.isArray(tenantHeader)
        ? (tenantHeader[0] ?? '')
        : (tenantHeader ?? '');
      const webRequest = new Request(`http://localhost${req.url ?? '/'}`, {
        method: req.method,
        headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const response = await POST(webRequest);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(await response.text());
    });
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(
        'DROP TABLE IF EXISTS global_identifier_cross_ref; DROP TABLE IF EXISTS universal_identity_map;',
      );
      await pool.end();
    }
    if (app) await new Promise<void>((resolve) => app.close(() => resolve()));
  });

  it('accepts the v22 200 case end-to-end and persists the OPTA cross-reference', async () => {
    const res = await request(app)
      .post('/api/v1/identifiers/batch-ingest')
      .set('content-type', 'application/json')
      .send({
        tenantId: 'tenant-integration-alpha',
        records: [
          {
            entityId: 'a1b2c3d4-e5f6-4a1b-8c9d-0123456789ab',
            verticalCategory: 'PRO_SPORTS',
            primaryCodeType: 'FIFA_CONNECT_ID',
            primaryCodeValue: '190ABC999999',
            crossReferences: [
              {
                linkedCodeType: 'OPTA_PERSON_ID',
                linkedCodeValue: 'p999999',
                verificationSource: 'Stats Perform',
              },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'SUCCESS',
      processedRecords: 1,
      tenantId: 'tenant-integration-alpha',
    });

    const { rows } = await pool.query(
      `SELECT m.primary_code_value, x.linked_code_value
         FROM universal_identity_map m
         JOIN global_identifier_cross_ref x ON x.map_id = m.map_id
        WHERE m.primary_code_type = 'FIFA_CONNECT_ID'`,
    );
    expect(rows[0]?.primary_code_value).toBe('190ABC999999');
    expect(rows[0]?.linked_code_value).toBe('p999999');
  });

  it('rejects empty batch payloads with 400 (canon v22 refinement 3)', async () => {
    const res = await request(app)
      .post('/api/v1/identifiers/batch-ingest')
      .set('content-type', 'application/json')
      .send({ tenantId: 'tenant-malformed', records: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid payload structure or empty records list.');
  });

  it('rejects the whole batch with 422 and ingests nothing (all-or-nothing)', async () => {
    const res = await request(app)
      .post('/api/v1/identifiers/batch-ingest')
      .set('content-type', 'application/json')
      .send({
        tenantId: 'tenant-integration-alpha',
        records: [
          {
            entityId: 'a1b2c3d4-e5f6-4a1b-8c9d-0123456789ab',
            verticalCategory: 'PRO_SPORTS',
            primaryCodeType: 'FIFA_CONNECT_ID',
            primaryCodeValue: 'BADDATA',
          },
        ],
      });
    expect(res.status).toBe(422);
    expect(res.body.status).toBe('REJECTED');
    const { rows } = await pool.query(
      "SELECT 1 FROM universal_identity_map WHERE primary_code_value = 'BADDATA'",
    );
    expect(rows).toHaveLength(0);
  });

  it('trigger branch set equals the LIVE TS registry (dynamic count — no hardcoded 71/75)', async () => {
    const { rows } = await pool.query(
      "SELECT prosrc FROM pg_proc WHERE proname = 'validate_global_identifier'",
    );
    const triggerBody = String(rows[0]?.prosrc ?? '');
    const whenTypes = new Set(
      [...triggerBody.matchAll(/WHEN '([A-Z0-9_]+)'/g)].map((m) => m[1]),
    );
    expect(whenTypes).toEqual(new Set(Object.keys(GLOBAL_IDENTIFIER_PATTERNS)));
    expect(whenTypes.size).toBe(
      (triggerBody.match(/WHEN '/g) ?? []).length,
    );
  });

  describe('canon v25 DB battery — four new types through the real trigger', () => {
    const insert = async (type: string, value: string, expectOk: boolean) => {
      const entityId = randomUUID();
      try {
        await pool.query(
          `INSERT INTO universal_identity_map (entity_id, vertical_category, primary_code_type, primary_code_value)
           VALUES ($1, 'PRO_SPORTS', $2, $3)`,
          [entityId, type, value],
        );
        if (!expectOk) {
          throw new Error(`Expected ${type}="${value}" to be REJECTED by the trigger`);
        }
      } catch (err) {
        if (!expectOk) {
          expect(String(err)).toMatch(/Validation failed for|Unknown or unpermitted/);
        } else {
          throw err;
        }
      }
    };

    it("accepts the founder H3 example '8928308280fffff'", () =>
      insert('H3_INDEX', '8928308280fffff', true));
    it('rejects a leading-7 H3 value', () =>
      insert('H3_INDEX', '7928308280fffff', false));
    it('rejects a 14-char H3 value', () =>
      insert('H3_INDEX', '8928308280ffff', false));
    it('rejects an H3 value with a trailing g', () =>
      insert('H3_INDEX', '8928308280ffffg', false));
    it('accepts a single-segment DID', () =>
      insert('DID_URI', 'did:key:z6MkhaXgBZDvotFkS3b1S8m1P2L4oRiZwTt1jGJ1', true));
    it('accepts a 40-hex ETH address', () =>
      insert('ETH_ADDRESS', '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', true));
    it('accepts a lowercase W3C VC uuid at the DB', () =>
      insert('W3C_VC_ID', 'urn:uuid:123e4567-e89b-12d3-a456-426614174000', true));
    it('REJECTS an UPPERCASE W3C VC uuid at the DB — the flagged TS/SQL drift, carried verbatim', () =>
      insert('W3C_VC_ID', 'urn:uuid:123E4567-E89B-12D3-A456-426614174000', false));

    it('fail-closed ELSE: an unregistered type is rejected by name', async () => {
      await expect(
        pool.query(
          `INSERT INTO universal_identity_map (entity_id, vertical_category, primary_code_type, primary_code_value)
           VALUES ($1, 'PRO_SPORTS', 'NOT_A_TYPE', 'whatever')`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/Unknown or unpermitted primary_code_type: NOT_A_TYPE/);
    });
  });

  describe('composite uniqueness (canon v23 Ruling 2, migration 0012 stands)', () => {
    it('accepts the same code value under two different types', async () => {
      const entityId = randomUUID();
      await expect(
        pool.query(
          `INSERT INTO universal_identity_map (entity_id, vertical_category, primary_code_type, primary_code_value)
           VALUES ($1, 'RETAIL', 'GTIN14', '09506000134352')`,
          [entityId],
        ),
      ).resolves.toBeDefined();
      await expect(
        pool.query(
          `INSERT INTO universal_identity_map (entity_id, vertical_category, primary_code_type, primary_code_value)
           VALUES ($1, 'SPATIAL', 'GIAI', '09506000134352')`,
          [randomUUID()],
        ),
      ).resolves.toBeDefined();
    });

    it('still rejects a duplicate within one type', async () => {
      await expect(
        pool.query(
          `INSERT INTO universal_identity_map (entity_id, vertical_category, primary_code_type, primary_code_value)
           VALUES ($1, 'RETAIL', 'GTIN14', '09506000134352')`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/unique_code_per_type/);
    });
  });

  describe('canon v13 delta — event emission, rollback, idempotency', () => {
    it('emits the post-commit event through the royalty_recon_jobs seam (the diagram is law)', async () => {
      const res = await request(app)
        .post('/api/v1/identifiers/batch-ingest')
        .set('content-type', 'application/json')
        .send({
          tenantId: 'tenant-event-alpha',
          records: [
            {
              entityId: 'a1b2c3d4-e5f6-4a1b-8c9d-0123456789ab',
              verticalCategory: 'PRO_SPORTS',
              primaryCodeType: 'FIFA_CONNECT_ID',
              primaryCodeValue: '190DEF777777',
              crossReferences: [
                {
                  linkedCodeType: 'OPTA_PERSON_ID',
                  linkedCodeValue: 'p888888',
                  verificationSource: 'Stats Perform',
                },
              ],
            },
          ],
        });
      expect(res.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT result FROM royalty_recon_jobs
          WHERE source = 'identifier_ingest'
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      );
      const event = rows[0]?.result as Record<string, unknown>;
      expect(event.event).toBe('identifier.batch_ingested');
      expect(event.tenantId).toBe('tenant-event-alpha');
      expect(event.processedRecords).toBe(1);
    });

    it('returns 500 DATABASE_ERROR and rolls the whole batch back on a mid-batch DB failure', async () => {
      // Induce a hard failure that passes the in-memory gate: hide a column
      // the Phase-2 upsert needs. Restored in finally — the suite stays
      // green for later cases either way.
      await pool.query(
        'ALTER TABLE universal_identity_map RENAME COLUMN vertical_category TO vertical_category_backup',
      );
      try {
        const res = await request(app)
          .post('/api/v1/identifiers/batch-ingest')
          .set('content-type', 'application/json')
          .send({
            tenantId: 'tenant-rollback-alpha',
            records: [
              {
                entityId: 'a1b2c3d4-e5f6-4a1b-8c9d-0123456789ab',
                verticalCategory: 'PRO_SPORTS',
                primaryCodeType: 'FIFA_CONNECT_ID',
                primaryCodeValue: '190GGG333333',
                crossReferences: [
                  {
                    linkedCodeType: 'OPTA_PERSON_ID',
                    linkedCodeValue: 'p777777',
                    verificationSource: 'Stats Perform',
                  },
                ],
              },
            ],
          });
        expect(res.status).toBe(500);
        expect(res.body.status).toBe('DATABASE_ERROR');
      } finally {
        await pool.query(
          'ALTER TABLE universal_identity_map RENAME COLUMN vertical_category_backup TO vertical_category',
        );
      }

      const { rows } = await pool.query(
        "SELECT 1 FROM universal_identity_map WHERE primary_code_value = '190GGG333333'",
      );
      expect(rows).toHaveLength(0);
    });

    it('is idempotent: re-ingesting the same batch creates no duplicate rows (ON CONFLICT upsert)', async () => {
      const payload = {
        tenantId: 'tenant-idem-alpha',
        records: [
          {
            entityId: 'a1b2c3d4-e5f6-4a1b-8c9d-0123456789ab',
            verticalCategory: 'PRO_SPORTS',
            primaryCodeType: 'FIFA_CONNECT_ID',
            primaryCodeValue: '190IDEM00001',
            crossReferences: [
              {
                linkedCodeType: 'OPTA_PERSON_ID',
                linkedCodeValue: 'p000001',
                verificationSource: 'Stats Perform',
              },
            ],
          },
        ],
      };

      const first = await request(app)
        .post('/api/v1/identifiers/batch-ingest')
        .set('content-type', 'application/json')
        .send(payload);
      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/api/v1/identifiers/batch-ingest')
        .set('content-type', 'application/json')
        .send(payload);
      expect(second.status).toBe(200);
      expect(second.body.processedRecords).toBe(1);

      const map = await pool.query(
        `SELECT map_id FROM universal_identity_map
          WHERE primary_code_type = 'FIFA_CONNECT_ID'
            AND primary_code_value = '190IDEM00001'`,
      );
      expect(map.rows).toHaveLength(1);

      const xref = await pool.query(
        `SELECT 1 FROM global_identifier_cross_ref x
          JOIN universal_identity_map m ON m.map_id = x.map_id
         WHERE m.primary_code_value = '190IDEM00001'
           AND x.linked_code_value = 'p000001'`,
      );
      expect(xref.rows).toHaveLength(1);
    });
  });
});
