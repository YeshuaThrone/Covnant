/**
 * Unit tests — founder canon v24 authenticateJWT + requireRole guard chain
 * (Next.js adaptation). The JWT paths exercise the REAL jsonwebtoken
 * sign/verify round-trip against JWT_SECRET; the fail-closed paths assert
 * the unset-secret reject-all behavior in production AND outside it (the
 * removed DEV-ONLY fallback, audit S1, must never verify).
 */

import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authenticateJWT,
  requireRole,
  type AuthenticatedUser,
  type UserRole,
} from '../identifierAuth';

const TEST_SECRET = 'test_jwt_secret_for_vitest';
const TEST_USER: AuthenticatedUser = {
  userId: '11111111-2222-4333-8444-555555555555',
  tenantId: 'tenant-alpha',
  roles: ['TENANT_ADMIN'],
};

const requestWith = (headers: Record<string, string>): Request =>
  new Request('http://localhost:3000/api/v1/identifiers/batch-ingest', {
    method: 'POST',
    headers,
    body: JSON.stringify({ tenantId: 'tenant-alpha', records: [] }),
  });

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', TEST_SECRET);
  vi.stubEnv('NODE_ENV', 'test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('authenticateJWT', () => {
  it('resolves the user from a valid Bearer token', () => {
    const token = jwt.sign(TEST_USER, TEST_SECRET, { expiresIn: '1h' });
    const result = authenticateJWT(
      requestWith({ authorization: `Bearer ${token}` }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user).toMatchObject({
        userId: TEST_USER.userId,
        tenantId: TEST_USER.tenantId,
        roles: ['TENANT_ADMIN'],
      });
    }
  });

  it('returns 401 with the founder body when the header is missing', async () => {
    const result = authenticateJWT(requestWith({}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      await expect(result.response.json()).resolves.toEqual({
        error: 'Missing or malformed Authorization header.',
      });
    }
  });

  it('returns 401 when the header is not a Bearer token', () => {
    const token = jwt.sign(TEST_USER, TEST_SECRET);
    const result = authenticateJWT(
      requestWith({ authorization: `Basic ${token}` }),
    );
    expect(result.ok).toBe(false);
  });

  it('returns 403 with the founder body on a garbage token', async () => {
    const result = authenticateJWT(
      requestWith({ authorization: 'Bearer not-a-jwt' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: 'Invalid or expired authentication token.',
      });
    }
  });

  it('returns 403 on a token signed with the wrong secret', () => {
    const token = jwt.sign(TEST_USER, 'some-other-secret');
    const result = authenticateJWT(
      requestWith({ authorization: `Bearer ${token}` }),
    );
    expect(result.ok).toBe(false);
  });

  it('returns 403 on an expired token (founder carries expired as 403)', () => {
    const token = jwt.sign(TEST_USER, TEST_SECRET, { expiresIn: '-10s' });
    const result = authenticateJWT(
      requestWith({ authorization: `Bearer ${token}` }),
    );
    expect(result.ok).toBe(false);
  });

  it('fails closed in production when JWT_SECRET is unset (reject-all)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', ''); // empty = unset for the fail-closed check
    const token = jwt.sign(TEST_USER, 'anything');
    const result = authenticateJWT(
      requestWith({ authorization: `Bearer ${token}` }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it('fails closed with JWT_SECRET unset in non-production (no dev fallback)', async () => {
    // NODE_ENV stays 'test' — the removed DEV-ONLY fallback (audit S1) must
    // reject outside production too.
    vi.stubEnv('JWT_SECRET', ''); // empty = unset for the fail-closed check
    const token = jwt.sign(TEST_USER, TEST_SECRET);
    const result = authenticateJWT(
      requestWith({ authorization: `Bearer ${token}` }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: 'Invalid or expired authentication token.',
      });
    }
  });

  it('accepts a valid token in production when JWT_SECRET is set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const token = jwt.sign(TEST_USER, TEST_SECRET, { expiresIn: '1h' });
    const result = authenticateJWT(
      requestWith({ authorization: `Bearer ${token}` }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('requireRole', () => {
  it('returns 401 with the founder body without user context', async () => {
    const result = requireRole(null, ['SUPER_ADMIN']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      await expect(result.response.json()).resolves.toEqual({
        error: 'Unauthorized request context.',
      });
    }
  });

  it('passes when the user holds any allowed role', () => {
    const result = requireRole(TEST_USER, ['SUPER_ADMIN', 'TENANT_ADMIN']);
    expect(result.ok).toBe(true);
  });

  it('returns 403 with requiredRoles and userRoles on a role miss', async () => {
    const viewer: AuthenticatedUser = { ...TEST_USER, roles: ['VIEWER'] };
    const result = requireRole(viewer, [
      'SUPER_ADMIN',
      'TENANT_ADMIN',
      'OPERATOR',
    ] satisfies UserRole[]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as {
        error: string;
        requiredRoles: string[];
        userRoles: string[];
      };
      expect(body.error).toContain('Insufficient role privileges');
      expect(body.requiredRoles).toEqual([
        'SUPER_ADMIN',
        'TENANT_ADMIN',
        'OPERATOR',
      ]);
      expect(body.userRoles).toEqual(['VIEWER']);
    }
  });
});
