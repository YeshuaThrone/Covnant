import { describe, expect, it } from 'vitest';
import {
  CREATOR_IDENTIFIER_KINDS,
  IDENTIFIER_KINDS,
  canonicalizeIdentifier,
  getIdentifierSpec,
  isIdentifierKind,
  type IdentifierKind,
} from './identifiers';

/**
 * Per-kind verification table: one canonical value, alternate accepted input
 * forms (separator/case tolerance is per-kind and documented in the module
 * header), and malformed inputs that must all be rejected with null. The
 * rejection lists deliberately include the shapes a lenient canonicalizer
 * would be tempted to accept — those rejections are the contract.
 */
interface KindCase {
  kind: IdentifierKind;
  canonical: string;
  alternates?: string[];
  rejections: string[];
}

const KIND_CASES: KindCase[] = [
  {
    kind: 'ISRC',
    canonical: 'USS1M2677777',
    alternates: ['US-S1M-26-77777', 'us-s1m-26-77777', ' USS1M2677777 '],
    rejections: [
      'US1M267777', // 11 chars
      'USS1M26777777', // 13 chars
      '1SS1M2677777', // country code must be letters
      'US-S1M-26-7777', // 11 chars after dash-stripping
      'USS1M267777X', // designation must be digits
      '',
    ],
  },
  {
    kind: 'ISWC',
    canonical: 'T-034524680-1',
    alternates: ['t-034524680-1', ' T-034524680-1 '],
    rejections: [
      'T-0123456789-9', // ten work digits — not the ISO 15707 form
      'T012345678', // compact form — ISWC is matched dashed only
      'T-01234567-9', // eight work digits
      'T-0123456789-12', // two check digits
      'X-012345678-9', // only the T prefix is defined
      '',
    ],
  },
  {
    kind: 'ISAN',
    canonical: 'B159D89F3D6F0A45',
    alternates: ['B159-D89F-3D6F-0A45', 'b159 d89f 3d6f 0a45', 'b159d89f3d6f0a45'],
    rejections: [
      'B159D89F3D6F0A4', // 15 chars
      'B159D89F3D6F0A450', // 17 chars
      'B159D89F3D6F0A4G', // G is not hex
      'B159-D89F-3D6F-0A4X', // X is not hex
      '',
    ],
  },
  {
    kind: 'EIDR',
    canonical: '10.5240/7791-8534-2C23-9030-8610-5',
    alternates: ['10.5240/7791-8534-2c23-9030-8610-5', ' 10.5240/7791-8534-2C23-9030-8610-5 '],
    rejections: [
      '10.5240/7791-8534-2C23-9030-8610', // missing check character
      '11.5240/7791-8534-2C23-9030-8610-5', // wrong root issuer
      '10.5240/7791-8534-2C23-9030-8610-55', // two check characters
      '10.5240/7791-8534-2C23-9030-8610-', // empty check
      '10.5240/7791_8534_2C23_9030_8610_5', // wrong separator
      'urn:eidr:10.5240:7791-8534-2C23-9030-8610-5', // URN form is not canonical
      '',
    ],
  },
  {
    kind: 'DOI',
    canonical: '10.5281/zenodo.1234567',
    alternates: ['10.5281/ZENODO.1234567', ' 10.5281/ZENODO.1234567 '],
    rejections: [
      '11.5281/zenodo.1234567', // must begin 10.
      '10.5281', // no suffix
      '10./zenodo.1234567', // no registrant digits
      '10.5281/has space', // whitespace in suffix
      'doi:10.5281/zenodo.1234567', // scheme prefix is not DOI syntax
      '',
    ],
  },
  {
    kind: 'UPC',
    canonical: '036000291452',
    alternates: [' 036000291452 '],
    rejections: [
      '03600029145', // 11 digits
      '0360002914521', // 13 digits
      '03600029145A', // letters
      '03600029145 2', // internal space
      '',
    ],
  },
  {
    kind: 'EAN',
    canonical: '4006381333931',
    alternates: [' 4006381333931 '],
    rejections: [
      '400638133393', // 12 digits (a UPC, not EAN)
      '40063813339311', // 14 digits
      '400638133393X', // letters
      '',
    ],
  },
  {
    kind: 'ISMN',
    canonical: '979-0-2600-1234-5',
    alternates: ['9790260012345', '979-0-2600-1234-5 ', '9-7-9-0-2-6-0-0-1-2-3-4-5'],
    rejections: [
      '978-0-2600-1234-5', // ISBN prefix, not ISMN
      '979-1-2600-1234-5', // only 979-0 is ISMN
      '979-0-2600-1234-56', // 14 digits
      '979-0-2600-1234', // 12 digits
      '',
    ],
  },
  {
    kind: 'GRID',
    canonical: 'A1-24TYZ-96XVQ4B123-8',
    alternates: ['A124TYZ96XVQ4B1238', 'a1-24tyz-96xvq4b123-8'],
    rejections: [
      'A1-24TYZ-96XVQ4B12-8', // 17 chars
      'A1-24TYZ-96XVQ4B1234-8', // 19 chars
      'A1_24TYZ_96XVQ4B123_8', // wrong separator
      '',
    ],
  },
  {
    kind: 'ISBN',
    canonical: '9780306406157',
    alternates: ['978-0-306-40615-7', '978 0 306 40615 7'],
    rejections: [
      '0306406152', // ISBN-10 — conversion is arithmetic repair, never done
      '97803064061570', // 14 digits
      '978030640615X', // X is not valid in ISBN-13
      '',
    ],
  },
  {
    kind: 'ISSN',
    canonical: '2049-3630',
    alternates: ['20493630', '2049 3630', ' 2049-3630 '],
    rejections: [
      '2049-36', // too short
      '204X-3630', // letters outside the check position
      '2049-36300', // 9 chars
      '',
    ],
  },
  {
    kind: 'GTIN',
    canonical: '00614141000158',
    alternates: [' 00614141000158 '],
    rejections: [
      '0061414100015', // 13 digits (an EAN, not GTIN-14)
      '006141410001581', // 15 digits
      '0061414100015A', // letters
      '',
    ],
  },
  {
    kind: 'MLC_WORK_ID',
    canonical: 'MLC-1234567',
    alternates: ['mlc-1234567', ' MLC-1234567 '],
    rejections: [
      'MLC 1234567', // whitespace
      '-LEADING', // must start alphanumeric
      `A${'B'.repeat(64)}`, // over the 64-char bound
      '',
    ],
  },
  {
    kind: 'HFA_SONG_ID',
    canonical: 'HFA-12345678',
    alternates: ['hfa-12345678', ' HFA-12345678 '],
    rejections: [
      'HFA 12345678', // whitespace
      `S${'O'.repeat(64)}NG`, // over the 64-char bound
      '',
    ],
  },
  {
    kind: 'TUNE_CODE',
    canonical: 'AB12CD34',
    alternates: ['ab12cd34', ' AB12CD34 '],
    rejections: [
      'AB12CD3', // 7 chars
      'AB12CD345', // 9 chars
      'AB12CD3!', // non-alphanumeric
      '',
    ],
  },
  {
    kind: 'ISNI',
    canonical: '0000-0002-1825-009X',
    alternates: ['000000021825009x', '0000 0002 1825 009X', ' 0000-0002-1825-009X '],
    rejections: [
      '0000-0002-1825-009', // 15 chars
      '0000-0002-1825-00977', // 17 chars
      '0000-0002-1825-009M', // invalid check character
      '',
    ],
  },
  {
    kind: 'IPI',
    canonical: '00123456789',
    alternates: ['123456789', ' 00123456789 '],
    rejections: [
      '1234567890', // 10 digits — ambiguous, not repaired
      '001234567890', // 12 digits
      '0012345678A', // letters
      '',
    ],
  },
  {
    kind: 'IPN',
    canonical: 'PERFORMER-01',
    alternates: ['performer-01', ' PERFORMER-01 '],
    rejections: [
      'PERFORMER 01', // whitespace
      '-LEADING', // must start alphanumeric
      `P${'E'.repeat(64)}R`, // over the 64-char bound
      '',
    ],
  },
  {
    kind: 'EPC_RFID',
    canonical: 'urn:epc:id:sgtin:0614141.107346.2017',
    alternates: [
      'URN:EPC:ID:SGTIN:0614141.107346.2017',
      ' urn:epc:id:sgtin:0614141.107346.2017 ',
    ],
    rejections: [
      'sgtin:0614141.107346.2017', // missing the urn:epc:id scheme
      'urn:epc:tag:sgtin-96:3074257BF7195E2400001A61', // tag/binary form
      'urn:epc:id:sgtin:0614141 107346 2017', // whitespace in body
      '',
    ],
  },
  {
    kind: 'NIL',
    canonical: 'NIL',
    alternates: ['nil', 'Nil', ' NIL '],
    rejections: ['NONE', 'NULL', ''],
  },
];

/** Deterministic seeded RNG — property tests without a new dependency. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function pickFrom(rng: Rng, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet.charAt(Math.floor(rng() * alphabet.length));
  }
  return out;
}

const DIGITS = '0123456789';
const HEX = '0123456789ABCDEF';
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DOI_SUFFIX_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789.-';

/**
 * Per-kind builders of VALID canonical values, used by the fixed-point
 * property: whatever a builder returns must be accepted unchanged, and
 * re-canonicalizing the output must be a no-op.
 */
const CANONICAL_BUILDERS: Record<IdentifierKind, (rng: Rng) => string> = {
  ISRC: (rng) =>
    `${pickFrom(rng, LETTERS, 2)}${pickFrom(rng, ALNUM, 3)}${pickFrom(rng, DIGITS, 7)}`,
  ISWC: (rng) => `T-${pickFrom(rng, DIGITS, 9)}-${pickFrom(rng, DIGITS, 1)}`,
  ISAN: (rng) => pickFrom(rng, HEX, 16),
  EIDR: (rng) =>
    `10.5240/${pickFrom(rng, ALNUM, 4)}-${pickFrom(rng, ALNUM, 4)}-${pickFrom(
      rng,
      ALNUM,
      4,
    )}-${pickFrom(rng, ALNUM, 4)}-${pickFrom(rng, ALNUM, 4)}-${pickFrom(rng, ALNUM, 1)}`,
  DOI: (rng) =>
    `10.${pickFrom(rng, DIGITS, 4 + Math.floor(rng() * 6))}/${pickFrom(
      rng,
      DOI_SUFFIX_CHARS,
      1 + Math.floor(rng() * 12),
    )}`,
  UPC: (rng) => pickFrom(rng, DIGITS, 12),
  EAN: (rng) => pickFrom(rng, DIGITS, 13),
  ISMN: (rng) =>
    `979-0-${pickFrom(rng, DIGITS, 4)}-${pickFrom(rng, DIGITS, 4)}-${pickFrom(rng, DIGITS, 1)}`,
  GRID: (rng) =>
    `${pickFrom(rng, ALNUM, 2)}-${pickFrom(rng, ALNUM, 5)}-${pickFrom(
      rng,
      ALNUM,
      10,
    )}-${pickFrom(rng, ALNUM, 1)}`,
  ISBN: (rng) => pickFrom(rng, DIGITS, 13),
  ISSN: (rng) =>
    `${pickFrom(rng, DIGITS, 4)}-${pickFrom(rng, DIGITS, 3)}${pickFrom(rng, '0123456789X', 1)}`,
  GTIN: (rng) => pickFrom(rng, DIGITS, 14),
  MLC_WORK_ID: (rng) =>
    `${pickFrom(rng, ALNUM, 3)}-${pickFrom(rng, ALNUM, 1 + Math.floor(rng() * 10))}`,
  HFA_SONG_ID: (rng) =>
    `${pickFrom(rng, ALNUM, 3)}-${pickFrom(rng, ALNUM, 1 + Math.floor(rng() * 10))}`,
  TUNE_CODE: (rng) => pickFrom(rng, ALNUM, 8),
  ISNI: (rng) =>
    `${pickFrom(rng, DIGITS, 4)}-${pickFrom(rng, DIGITS, 4)}-${pickFrom(
      rng,
      DIGITS,
      4,
    )}-${pickFrom(rng, DIGITS, 3)}${pickFrom(rng, '0123456789X', 1)}`,
  IPI: (rng) => `00${pickFrom(rng, DIGITS, 9)}`,
  IPN: (rng) => `${pickFrom(rng, ALNUM, 4)}-${pickFrom(rng, ALNUM, 1 + Math.floor(rng() * 10))}`,
  EPC_RFID: (rng) =>
    `urn:epc:id:sgtin:${pickFrom(rng, DIGITS, 6)}.${pickFrom(rng, DIGITS, 7)}.${pickFrom(
      rng,
      DIGITS,
      4,
    )}`,
  NIL: () => 'NIL',
};

describe('identifier registry inventory', () => {
  it('carries exactly the 20 kinds named by the mission, with no duplicates', () => {
    expect(IDENTIFIER_KINDS).toHaveLength(20);
    expect(new Set(IDENTIFIER_KINDS).size).toBe(20);
  });

  it('keeps the registry literal and the kinds list in agreement', () => {
    for (const kind of IDENTIFIER_KINDS) {
      const spec = getIdentifierSpec(kind);
      expect(spec.kind).toBe(kind);
      expect(typeof spec.canonicalize).toBe('function');
    }
  });

  it('marks exactly ISNI, IPI, and IPN as creator kinds', () => {
    expect([...CREATOR_IDENTIFIER_KINDS].sort()).toEqual(['IPI', 'IPN', 'ISNI']);
  });

  it('treats kind keys as case-sensitive', () => {
    expect(isIdentifierKind('ISRC')).toBe(true);
    expect(isIdentifierKind('isrc')).toBe(false);
    expect(isIdentifierKind('FOO')).toBe(false);
  });
});

describe('per-kind canonicalizers — acceptance, alternates, rejections', () => {
  for (const { kind, canonical, alternates, rejections } of KIND_CASES) {
    describe(kind, () => {
      it('accepts the canonical form as a fixed point', () => {
        expect(canonicalizeIdentifier(kind, canonical)).toBe(canonical);
      });

      it('normalizes every documented alternate input to the same canonical value', () => {
        for (const alternate of alternates ?? []) {
          expect(canonicalizeIdentifier(kind, alternate)).toBe(canonical);
        }
      });

      it('rejects every malformed look-alike with null — never repairs', () => {
        for (const bad of rejections) {
          expect(canonicalizeIdentifier(kind, bad)).toBeNull();
        }
      });
    });
  }
});

describe('canonicalizer properties (seeded, deterministic)', () => {
  it('accepts 50 generated canonical values per kind, each a fixed point', () => {
    const rng = mulberry32(20260914);
    for (const kind of IDENTIFIER_KINDS) {
      for (let i = 0; i < 50; i += 1) {
        const value = CANONICAL_BUILDERS[kind](rng);
        const canonical = canonicalizeIdentifier(kind, value);
        expect(canonical, `${kind} rejected its own generated value ${value}`).not.toBeNull();
        expect(
          canonicalizeIdentifier(kind, canonical as string),
          `${kind} canonical form ${canonical} is not a fixed point`,
        ).toBe(canonical);
      }
    }
  });

  it('rejects empty and whitespace-only input for every kind — total function', () => {
    for (const kind of IDENTIFIER_KINDS) {
      expect(canonicalizeIdentifier(kind, '')).toBeNull();
      expect(canonicalizeIdentifier(kind, '   ')).toBeNull();
    }
  });
});
