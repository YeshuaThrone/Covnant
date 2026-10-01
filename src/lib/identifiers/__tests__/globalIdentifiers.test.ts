/**
 * TypeScript registry battery — canon v25 (H3/DID/ETH/W3C), v23 (OPTA 9/9),
 * v15 (constructed telemetry cases), v11 (anchor cases).
 *
 * The registry count is asserted dynamically (never a hardcoded literal):
 * the founder's "75 types" double-counts OPTA_PERSON_ID (already inside the
 * v15 seven), so the distinct registry lands at 74 — suites derive counts
 * from GLOBAL_IDENTIFIER_PATTERNS / GLOBAL_IDENTIFIER_TYPE_COUNT.
 */

import { describe, expect, it } from 'vitest';

import {
  GLOBAL_IDENTIFIER_PATTERNS,
  GLOBAL_IDENTIFIER_TYPE_COUNT,
  validateIdentifier,
  type GlobalIdentifierType,
} from '../globalIdentifiers';

const ok = (type: GlobalIdentifierType, value: string) =>
  expect(validateIdentifier(type, value), `${type}="${value}"`).toBe(true);
const bad = (type: GlobalIdentifierType, value: string) =>
  expect(validateIdentifier(type, value), `${type}="${value}"`).toBe(false);

describe('canon v25 — H3_INDEX', () => {
  it("accepts the founder's example", () => ok('H3_INDEX', '8928308280fffff'));
  it('rejects a leading 7 outside the resolution hex set', () =>
    bad('H3_INDEX', '7928308280fffff'));
  it('rejects a 14-char value', () => bad('H3_INDEX', '8928308280ffff'));
  it('rejects a trailing g char', () => bad('H3_INDEX', '8928308280ffffg'));
});

describe('canon v25 — DID_URI', () => {
  it('accepts a single-segment method-specific id', () =>
    ok('DID_URI', 'did:key:z6MkhaXgBZDvotFkS3b1S8m1P2L4oRiZwTt1jGJ1'));
  it('rejects multi-colon method-specific ids (carried verbatim)', () =>
    bad('DID_URI', 'did:web:org:path'));
  it('is case-sensitive on the method', () => bad('DID_URI', 'DID:key:z6Mk'));
});

describe('canon v25 — ETH_ADDRESS', () => {
  it('accepts a 40-hex address', () =>
    ok('ETH_ADDRESS', '0x71C7656EC7ab88b098defB751B7401B5f6d8976F'));
  it('rejects 39 hex chars', () =>
    bad('ETH_ADDRESS', '0x71C7656EC7ab88b098defB751B7401B5f6d8976'));
  it('rejects 41 hex chars', () =>
    bad('ETH_ADDRESS', '0x71C7656EC7ab88b098defB751B7401B5f6d8976F0'));
  it('rejects non-hex characters', () =>
    bad('ETH_ADDRESS', '0x71C7656EC7ab88b098defB751B7401B5f6d8976G'));
});

describe('canon v25 — W3C_VC_ID (TS surface carries the /i flag)', () => {
  it('accepts a lowercase uuid', () =>
    ok('W3C_VC_ID', 'urn:uuid:123e4567-e89b-12d3-a456-426614174000'));
  it('accepts an UPPERCASE uuid on the TS surface (the flagged drift)', () =>
    ok('W3C_VC_ID', 'urn:uuid:123E4567-E89B-12D3-A456-426614174000'));
  it('rejects a malformed uuid', () =>
    bad('W3C_VC_ID', 'urn:uuid:123e4567-e89b-12d3-a456-42661417400'));
});

describe('canon v23 — OPTA_PERSON_ID (9/9 audit battery)', () => {
  it('accepts p999999, p1234, p12345678', () => {
    ok('OPTA_PERSON_ID', 'p999999');
    ok('OPTA_PERSON_ID', 'p1234');
    ok('OPTA_PERSON_ID', 'p12345678');
  });
  it('rejects p123, p123456789, P999999, p-999999, p12a456', () => {
    bad('OPTA_PERSON_ID', 'p123');
    bad('OPTA_PERSON_ID', 'p123456789');
    bad('OPTA_PERSON_ID', 'P999999');
    bad('OPTA_PERSON_ID', 'p-999999');
    bad('OPTA_PERSON_ID', 'p12a456');
  });
});

describe('canon v15 — extended telemetry constructed cases', () => {
  it('accepts valid SECOND_SPECTRUM_ID / GENIUS_SPORTS_ID / CATAPULT / KINEXON / ICC / WORLD_ATHLETICS', () => {
    ok('SECOND_SPECTRUM_ID', 'SS-1b2c3d4e-5f6b-7c8d-9e0f-1a2b3c4d5e6f');
    ok('GENIUS_SPORTS_ID', 'GS-ENT-123456');
    ok('CATAPULT_SESSION_UUID', 'CAT-1b2c3d4e-5f6b-7c8d-9e0f-1a2b3c4d5e6f');
    ok('KINEXON_ID', 'KX-TAG-A1B2C3D4E5F6');
    ok('ICC_PLAYER_ID', 'ICC-123456');
    ok('WORLD_ATHLETICS_ID', 'WA-1234567');
  });
  it('rejects out-of-bounds telemetry codes', () => {
    bad('GENIUS_SPORTS_ID', 'GS-ENT-12345');
    bad('KINEXON_ID', 'KX-TAG-A1B2C3'); // 7 hex chars — below the 8-char floor
    bad('ICC_PLAYER_ID', 'ICC-1234');
    bad('WORLD_ATHLETICS_ID', 'WA-123456');
  });
});

describe('canon v11 — anchor cases', () => {
  it('AAT_ID anchors both ends', () => {
    ok('AAT_ID', 'AAT-12345678');
    bad('AAT_ID', 'AAT-1234567');
    bad('AAT_ID', 'AAT-123456789');
  });
  it('FIFA_CONNECT_ID accepts the v22 200-case sample', () =>
    ok('FIFA_CONNECT_ID', '190ABC999999'));
  it('GND_ID validates the check-char shape', () => {
    ok('GND_ID', '1019219186');
    bad('GND_ID', '2019219186');
  });
  it('LEI requires two trailing digits (repo 0012 canon)', () => {
    ok('LEI', '5493001KJTIIGC8Y1S12');
    bad('LEI', '5493001KJTIIGC8Y1SAB');
  });
  it('PURL accepts the scoped npm at-sign shape (addendum 31)', () => {
    ok('PURL', 'pkg:npm/@scope/name@1.0.0');
    ok('PURL', 'pkg:npm/lodash@4.17.21');
  });
  it('GS1_DIGITAL_LINK accepts a digital link', () =>
    ok('GS1_DIGITAL_LINK', 'https://id.gs1.org/01/09506000134352'));
  it('EID anchors the 32-digit shape', () => {
    ok('EID', '89012345678901234567890123456789');
    bad('EID', '79012345678901234567890123456789');
  });
});

describe('registry integrity', () => {
  it('derives the live count dynamically (74 distinct types — founder "75" double-counts OPTA)', () => {
    expect(GLOBAL_IDENTIFIER_TYPE_COUNT).toBeGreaterThanOrEqual(74);
    expect(Object.keys(GLOBAL_IDENTIFIER_PATTERNS).length).toBe(
      GLOBAL_IDENTIFIER_TYPE_COUNT,
    );
  });
  it('throws on an unknown type rather than returning false', () => {
    expect(() =>
      validateIdentifier('NOT_A_TYPE' as GlobalIdentifierType, 'whatever'),
    ).toThrow(/Unsupported global identifier type/);
  });
});
