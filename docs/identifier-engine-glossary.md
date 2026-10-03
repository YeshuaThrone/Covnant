# Identifier Engine — Semantic Glossary & Provisional Registry

> Documentation canon: v17 (pro sports breakdown), v18 (spatial, supply
> chain and culinary formulation map), v19 (software supply chain, telecom
> and energy grid example values). These are semantic docs — they change NO
> patterns, NO types, NO SQL.

## Provisional types — NO patterns invented (canon v17/v18)

Five types are NAMED by founder documentation canon but carry NO registered
pattern. **Do NOT invent patterns for them.** The registry and suite extend
only when the founder supplies each pattern (canon numbering: registry
extends to 80/80 when all five arrive).

| Type | Named in | Canon domain |
|---|---|---|
| `ZEBRA_RFID_ID` | v17 | Real-time UUIDs on shoulder pad chips, stadium cameras, and match balls streaming 29-point body tracking at 60 Hz (with SECOND_SPECTRUM_ID). |
| `HAWKEYE_TRACKING_ID` | v17 | Ultra-wideband indoor sensor tracking — tennis ball bounce, basketball court tracking (with KINEXON_ID). |
| `SPORTRADAR_ID` | v17 | Data aggregator / sportsbook feed linking live play-by-play to player stats (with OPTA_PERSON_ID, GENIUS_SPORTS_ID). |
| `SSCC` | v18 §1 | The GS1 shipping container code — global commerce and GS1 digital infrastructure. |
| `URN:NBN` | v18 §2 | The National Bibliography Number URN namespace — spatial, real estate and geographic assets section. |

Suite target: the live registry's distinct count (74 — see "Registry
count" below), dynamic assertion, never a hardcoded number.

## Registry count

The founder canon's "75 types" counts `OPTA_PERSON_ID` twice: once in the
v15 seven (types 64–70) and again as v23's "type 71". The DISTINCT registry
carries **74** entries — every canon type exactly once, including the v23
OPTA pattern `^p\d{4,8}$` (anchored, lowercase p only) and the four v25
geospatial/Web3 types. Suites assert the count DYNAMICALLY:
`Object.keys(GLOBAL_IDENTIFIER_PATTERNS).length` must equal
`GLOBAL_IDENTIFIER_TYPE_COUNT` and the trigger branch set must equal the
live TS registry (the integration parity test, no hardcoded 71/75).

## Pro sports family (v17 semantic breakdown)

- `FIFA_CONNECT_ID` — maps every registered football player, coach, and
  referee worldwide; 12 characters.
- `UCI_CODE`, `FIBA_ID`, `IRB_RUGBY_ID`, `ICC_PLAYER_ID` — federation codes
  for international eligibility, transfer windows, and Olympic clearance.
- `PAID` — union registration codes (examples `NFLPA-123456`,
  `NBAPA-654321` — both match the v11 pattern
  `^(NFLPA|NBAPA|MLBPA|NHLPA|MLSPA)-\d{6}$`, no conflict) governing
  collective bargaining, group licensing, and commercial revenue
  distribution.
- `SECOND_SPECTRUM_ID` — real-time UUIDs on shoulder pad chips, stadium
  cameras, and match balls streaming 29-point body tracking at 60 Hz.
- `KINEXON_ID` — ultra-wideband indoor sensor tracking.
- `OPTA_PERSON_ID` (`p123456`), `GENIUS_SPORTS_ID` — data aggregators and
  sportsbook feeds linking live play-by-play to player stats.
- `ESIC_ID` — flags match-fixing and suspicious betting behavior.
- `CATAPULT_SESSION_UUID` — logs player accelerations, decelerations, heart
  rate, and metabolic load.
- `WADA_ADAMS_ID` — athlete biological passports and testing logs.
- `PUUID` — the Riot Games player UUID for League of Legends and Valorant
  telemetry.
- `FIDE_ID` — classical and online chess ratings.

## Spatial, supply chain and culinary formulation map (v18)

**§1 Global commerce and GS1 digital infrastructure** — `GTIN14` the
zero-padded 14-digit standard governing retail product identification
across global supply networks; `GLN` the Global Location Number identifying
physical facilities, warehouses, and corporate docks; `GS1_DIGITAL_LINK`
the modern URI standard turning product packaging QR codes into dynamic
multi-target web routes for consumer safety, supply chain events, and
regulatory passports; `SSCC` the shipping container code (provisional).

**§2 Spatial, real estate and geographic assets** — `UPRN` the Unique
Property Reference Number; `URN:NBN` (provisional); `GIAI` and `GRAI`
global individual and returnable asset identifiers.

**§3 Chemical, medical and scientific formulations** — `CAS_REGISTRY`,
`CPT_CODE`, `LOINC_CODE`, `NPI`.

**§4 Culinary, agricultural and food traceability** — `FDC_ID` USDA
FoodData Central; `PLU_CODE` price look-up produce; `E_AMBROSIA_ID` EU
geographical indications PGI and PDO culinary origin.

## Software supply chain, telecom & energy grid — canonical example values (v19)

All 13 already registered; every value pattern-clean; zero pattern changes.

**Software supply chain, open source and security**
- `PURL`: `pkg:npm/@angular/animation@12.3.1` — byte-identical to the v12
  acceptance case; passes the v12 at-sign-widened namespace class (the v12
  widening is re-confirmed as the normative engine pattern in both
  TypeScript and the database trigger).
- `SPDX_ID`: `SPDXRef-Package-123`
- `CVE_ID`: `CVE-2026-12345`
- `SWID_TAG`: `123e4567-e89b-12d3-a456-426614174000`
- `API_ENDPOINT_UUID`: `9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d`

**Hardware, telecommunications and mobile identity**
- `IMEI`: `356938035643803`
- `EID`: `89000000000000000000000000000000` (89-prefixed, 32 digits)
- `MAC_ADDRESS`: `00:1A:2B:3C:4D:5E`
- `GSRN`: `123456789012345678` (18 digits)
- `THREEGPP_SPEC`: `3GPP-TS-38.331` (carries the `3GPP-TS-` prefix)

**Energy grids, smart cities and industrial SCADA**
- `EIC_CODE`: `10X1001A1001A10X` (16-character digit-letter ENTSO-E form)
- `SCADA_UUID`: `SCADA-123e4567-e89b-12d3-a456-426614174000`
- `REC_SERIAL`: `REC-US-12345678-000100`
