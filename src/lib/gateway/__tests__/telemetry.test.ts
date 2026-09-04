import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabaseFromEnv } from '@/lib/supabase';
import {
  grantMemoryAdmin,
  insertCreatorTelemetry,
  isMemoryAdmin,
  listCreatorTelemetry,
  resetGatewayMemoryState,
  toCreatorTelemetryDbRow,
} from '../telemetry';
import type { CreatorTelemetryInput } from '../telemetry';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Creator telemetry store tests. The injected-fake client stands in for the
 * service-role Supabase client (the route verifies the caller's JWT before
 * persisting), and the memory-index assertions cover the repo's established
 * in-memory fallback used whenever no Supabase credentials are configured.
 */

vi.mock('@/lib/supabase', () => ({ supabaseFromEnv: vi.fn() }));

const fromEnvMock = supabaseFromEnv as ReturnType<typeof vi.fn>;

const baseRecord: CreatorTelemetryInput = {
  authUserId: 'auth-user-1',
  legalName: 'Yeshua Throne',
  artistName: 'Throne',
  regularEmail: 'creator@covnant.test',
  businessEmail: 'biz@covnant.test',
  phone: '+12125550134',
  phoneVerified: true,
  verifiedAt: '2026-09-04T00:00:00.000Z',
};

describe('toCreatorTelemetryDbRow', () => {
  it('maps the camelCase payload onto the creator_telemetry columns', () => {
    expect(toCreatorTelemetryDbRow(baseRecord)).toEqual({
      auth_user_id: 'auth-user-1',
      legal_name: 'Yeshua Throne',
      artist_name: 'Throne',
      regular_email: 'creator@covnant.test',
      business_email: 'biz@covnant.test',
      phone: '+12125550134',
      phone_verified: true,
      verified_at: '2026-09-04T00:00:00.000Z',
    });
  });

  it('maps an absent businessEmail to a null column', () => {
    expect(toCreatorTelemetryDbRow({ ...baseRecord, businessEmail: undefined })).toMatchObject({
      business_email: null,
    });
  });
});

function makeFakeDb() {
  const insertCalls: Array<{ table: string; rows: unknown }> = [];
  const db = {
    from(table: string) {
      return {
        insert(rows: unknown) {
          insertCalls.push({ table, rows });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  return { db: db as unknown as SupabaseClient, insertCalls };
}

describe('insertCreatorTelemetry', () => {
  beforeEach(() => {
    resetGatewayMemoryState();
    fromEnvMock.mockReset();
  });

  it('inserts the snake_case row via the injected client', async () => {
    const { db, insertCalls } = makeFakeDb();

    await insertCreatorTelemetry(baseRecord, db);

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].table).toBe('creator_telemetry');
    expect(insertCalls[0].rows).toEqual([
      {
        auth_user_id: 'auth-user-1',
        legal_name: 'Yeshua Throne',
        artist_name: 'Throne',
        regular_email: 'creator@covnant.test',
        business_email: 'biz@covnant.test',
        phone: '+12125550134',
        phone_verified: true,
        verified_at: '2026-09-04T00:00:00.000Z',
      },
    ]);
  });

  it('mirrors into the newest-first memory index alongside the client insert', async () => {
    const { db } = makeFakeDb();

    await insertCreatorTelemetry(baseRecord, db);
    await insertCreatorTelemetry({ ...baseRecord, authUserId: 'auth-user-2' }, db);

    const rows = await listCreatorTelemetry(undefined);
    expect(rows).toHaveLength(2);
    expect(rows[0].authUserId).toBe('auth-user-2');
    expect(rows[1].authUserId).toBe('auth-user-1');
  });

  it('persists to the memory index only when no client is configured', async () => {
    fromEnvMock.mockReturnValue(undefined);
    const row = await insertCreatorTelemetry(baseRecord, undefined);

    expect(row.id).toBeTruthy();
    expect(await listCreatorTelemetry(undefined)).toHaveLength(1);
  });
});

describe('memory admin registry', () => {
  beforeEach(() => resetGatewayMemoryState());

  it('grants and recognizes admin fixtures only', () => {
    expect(isMemoryAdmin('ceo-user')).toBe(false);
    grantMemoryAdmin('ceo-user');
    expect(isMemoryAdmin('ceo-user')).toBe(true);
    expect(isMemoryAdmin('someone-else')).toBe(false);
  });
});
