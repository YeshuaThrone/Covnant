import { describe, expect, it } from 'vitest';
import {
  UCT_PATTERN,
  buildUct,
  isValidUct,
  normalizeEngine,
  normalizeJurisdiction,
  uctChecksum,
  uctIssuanceYear,
  uctSerial,
} from '../uct';

/**
 * UCT (Universal Creator Tag) unit tests — the S4 acceptance criterion:
 * the checksum validates for every generated code and a tampered serial is
 * rejected by validation. Pure functions; no DB, no IO.
 */

const YEAR = uctIssuanceYear();

describe('UCT format', () => {
  it('builds codes that match the pinned UCT shape', () => {
    const uct = buildUct('US', 2026, '9F3A7C21');
    expect(uct).toMatch(/^UCT-[A-Z]{2}-\d{4}-[0-9A-F]{8}-[0-9A-Z]{2}$/);
    expect(UCT_PATTERN.test(uct)).toBe(true);
  });

  it('is deterministic for the same issuance facts (checksum is a pure function of the prefix)', () => {
    const first = buildUct('US', 2026, '9F3A7C21');
    const second = buildUct('US', 2026, '9F3A7C21');
    expect(first).toBe(second);
    expect(uctChecksum('UCT-US-2026-9F3A7C21')).toBe(first.slice(-2));
  });

  it('draws 8 uppercase-hex crypto-random serials (32 bits), distinct across draws', () => {
    const serials = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const serial = uctSerial();
      expect(serial).toMatch(/^[0-9A-F]{8}$/);
      serials.add(serial);
    }
    expect(serials.size).toBe(50);
  });
});

describe('S4 — checksum integrity validation', () => {
  it('validates every generated code across many random serials and jurisdictions', () => {
    for (let i = 0; i < 200; i += 1) {
      const uct = buildUct('US', YEAR, uctSerial());
      expect(isValidUct(uct)).toBe(true);
    }
    for (const jurisdiction of ['US', 'GB', 'DE']) {
      expect(isValidUct(buildUct(jurisdiction, YEAR, '9F3A7C21'))).toBe(true);
    }
  });

  it('rejects a tampered serial even though the shape still matches', () => {
    const uct = buildUct('US', 2026, '9F3A7C21');
    const prefix = uct.slice(0, -3); // 'UCT-US-2026-9F3A7C21'
    const tamperedSerial = `${prefix.slice(0, -1)}${prefix.slice(-1) === '0' ? '1' : '0'}-${uct.slice(-2)}`;
    expect(tamperedSerial).not.toBe(uct);
    expect(UCT_PATTERN.test(tamperedSerial)).toBe(true); // shape intact
    expect(isValidUct(tamperedSerial)).toBe(false); // integrity broken
  });

  it('rejects a tampered jurisdiction and a tampered year', () => {
    const uct = buildUct('US', 2026, '9F3A7C21');
    expect(isValidUct(uct.replace('UCT-US-', 'UCT-GB-'))).toBe(false);
    expect(isValidUct(uct.replace('-2026-', '-2025-'))).toBe(false);
  });

  it('rejects malformed and non-string values', () => {
    expect(isValidUct(null)).toBe(false);
    expect(isValidUct(42)).toBe(false);
    expect(isValidUct('')).toBe(false);
    expect(isValidUct('UCT-US-2026-9F3A7C2-K4')).toBe(false); // 7-hex serial
    expect(isValidUct('UCT-US-2026-9F3A7C211-K4')).toBe(false); // 9-hex serial
    expect(isValidUct('UCT-USA-2026-9F3A7C21-K4')).toBe(false); // 3-char jurisdiction
    expect(isValidUct('uct-us-2026-9f3a7c21-k4')).toBe(false); // lowercase
  });
});

describe('signup input normalization', () => {
  it('normalizes jurisdictions to 2-char uppercase ISO 3166 and rejects malformed ones', () => {
    expect(normalizeJurisdiction('us')).toBe('US');
    expect(normalizeJurisdiction('  GB  ')).toBe('GB');
    expect(normalizeJurisdiction('USA')).toBeNull();
    expect(normalizeJurisdiction('U')).toBeNull();
    expect(normalizeJurisdiction('U1')).toBeNull();
    expect(normalizeJurisdiction('')).toBeNull();
    expect(normalizeJurisdiction(42)).toBeNull();
    expect(normalizeJurisdiction(null)).toBeNull();
  });

  it('accepts exactly the four signup engines and rejects every other value', () => {
    expect(normalizeEngine('music_recording')).toBe('music_recording');
    expect(normalizeEngine('publishing')).toBe('publishing');
    expect(normalizeEngine('youtube_content_id')).toBe('youtube_content_id');
    expect(normalizeEngine('digital_assets')).toBe('digital_assets');
    expect(normalizeEngine('film_licensing')).toBeNull();
    expect(normalizeEngine('MUSIC_RECORDING')).toBeNull(); // enum is exact
    expect(normalizeEngine(42)).toBeNull();
    expect(normalizeEngine(undefined)).toBeNull();
  });
});
