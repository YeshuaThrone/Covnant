import { describe, it, expect } from 'vitest';
import { getDb } from '@/lib/db';

/**
 * src/lib/db contract: the module must import cleanly without DATABASE_URL
 * (CI has none) and getDb() must fail closed — null, never a crash or a
 * half-configured pool.
 */

describe('getDb', () => {
  it('returns null when DATABASE_URL is absent', () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(getDb()).toBeNull();
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
    }
  });

  it('returns null for an empty DATABASE_URL', () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = '';
    try {
      expect(getDb()).toBeNull();
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
      else delete process.env.DATABASE_URL;
    }
  });
});
