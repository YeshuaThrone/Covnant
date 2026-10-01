-- ============================================================================
-- Migration 0015 — Extended Geospatial & Decentralized Web3 Identifier Types
-- (founder canon v25; deployment runbook canon v26)
-- ============================================================================
-- ADDITIVE migration at the next-free number (0011-0014 are taken). It
-- CREATE OR REPLACE FUNCTION-validates the universal identity registry with
-- the FULL branch set: the 70 branches migration 0012 carries verbatim, plus
-- the four v25 types below. Nothing is dropped or altered — the v23-audited
-- 0012 DDL (composite unique_code_per_type included) stands untouched.
--
-- FOUNDER COUNT NOTE (carried, not editorialized): the founder's registry
-- math "70 + OPTA (v23) = 71; + these four = 75" double-counts
-- OPTA_PERSON_ID — the v15 seven (already inside 0012's 70 branches) include
-- it with this exact pattern. The DISTINCT registry after this migration is
-- 74 types / 74 trigger branches. Suites assert the live count dynamically.
--
-- W3C_VC_ID DRIFT (flagged founder question, carried verbatim): the
-- TypeScript W3C_VC_ID pattern carries the /i flag (uppercase hex accepted)
-- while this SQL branch is case-sensitive (uppercase rejected). The DB is
-- the stricter gate. Both surfaces are character-exact until the founder
-- rules on case-insensitive SQL (!~* or [0-9a-fA-F] classes).
--
-- The v25 trigger shape below was PG-verified (PGlite audit): CREATE OR
-- REPLACE succeeds, the trigger fires, the fail-closed ELSE raises
-- 'Unknown or unpermitted primary_code_type', and the W3C branch rejects.

-- Trigger Function: Enforce Format Regular Expressions at Database Level
CREATE OR REPLACE FUNCTION validate_global_identifier()
RETURNS TRIGGER AS $$
DECLARE
    regex_pattern TEXT;
BEGIN
    CASE NEW.primary_code_type
        -- Fine Art & Antiquities
        WHEN 'AAT_ID' THEN regex_pattern := '^AAT-\d{8}$';
        WHEN 'ARK' THEN regex_pattern := '^ark:/\d{5}/[a-z0-9]+$';
        WHEN 'ALR_ID' THEN regex_pattern := '^ALR-[A-Z0-9]{8,12}$';
        WHEN 'CRSA_CODE' THEN regex_pattern := '^CRSA-[A-Z]{3}-\d{6}$';
        WHEN 'DARIA_ID' THEN regex_pattern := '^DARIA-[A-F0-9]{16}$';
        WHEN 'GND_ID' THEN regex_pattern := '^1[012]?\d{7}[0-X]$';
        WHEN 'LIDO_CODE' THEN regex_pattern := '^LIDO-[A-Z0-9_-]{8,32}$';
        WHEN 'OBJECT_ID' THEN regex_pattern := '^OBJID-[A-Z]{3}-\d{8}$';
        WHEN 'ULAN_ID' THEN regex_pattern := '^ULAN-\d{8,10}$';
        WHEN 'CIDOC_CRM_ID' THEN regex_pattern := '^CRM-[E-F]\d{1,3}$';
        WHEN 'CDWA_ID' THEN regex_pattern := '^CDWA-\d{8,12}$';
        WHEN 'CITES_CERT_ID' THEN regex_pattern := '^[A-Z]{2}/\d{6}/[A-Z0-9]{4,8}$';
        WHEN 'CONA_ID' THEN regex_pattern := '^CONA-\d{8,10}$';
        WHEN 'SPECTRUM_ID' THEN regex_pattern := '^SPEC-[A-Z0-9]{6,16}$';
        -- Sports & Performance Telemetry
        WHEN 'ATP_WTA_CODE' THEN regex_pattern := '^[A-Z]{3}\d{3}$';
        WHEN 'FIFA_CONNECT_ID' THEN regex_pattern := '^[19]\d{2}[A-Z0-9]{8,10}$';
        WHEN 'FIBA_ID' THEN regex_pattern := '^FIBA-\d{6,8}$';
        WHEN 'GLAN' THEN regex_pattern := '^GLAN-[A-Z0-9]{12}$';
        WHEN 'IRB_RUGBY_ID' THEN regex_pattern := '^IRB-\d{7,9}$';
        WHEN 'NCAA_ID' THEN regex_pattern := '^\d{9}$';
        WHEN 'NIL_ID' THEN regex_pattern := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
        WHEN 'PAID' THEN regex_pattern := '^(NFLPA|NBAPA|MLBPA|NHLPA|MLSPA)-\d{6}$';
        WHEN 'UCI_CODE' THEN regex_pattern := '^100\d{8}$';
        WHEN 'WADA_ADAMS_ID' THEN regex_pattern := '^ADM-\d{8}$';
        WHEN 'WDSF_ID' THEN regex_pattern := '^WDSF-\d{6,8}$';
        WHEN 'FIDE_ID' THEN regex_pattern := '^\d{6,9}$';
        WHEN 'ESIC_ID' THEN regex_pattern := '^ESIC-[A-Z0-9]{8,12}$';
        WHEN 'PUUID' THEN regex_pattern := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
        -- Spatial, Fitness, Culinary & Formulations
        WHEN 'CAS_REGISTRY' THEN regex_pattern := '^\d{2,7}-\d{2}-\d$';
        WHEN 'CPT_CODE' THEN regex_pattern := '^\d{4}[0-9A-Z]$';
        WHEN 'FDC_ID' THEN regex_pattern := '^\d{6,8}$';
        WHEN 'FIT_ID' THEN regex_pattern := '^FIT-[A-Z0-9]{10}$';
        WHEN 'GIAI' THEN regex_pattern := '^\d{6,12}[A-Z0-9]{1,18}$';
        WHEN 'GLN' THEN regex_pattern := '^\d{13}$';
        WHEN 'GRAI' THEN regex_pattern := '^0\d{12}[A-Z0-9]{1,16}$';
        WHEN 'HL7_FHIR_ID' THEN regex_pattern := '^[A-Za-z0-9\-\.]{1,64}$';
        WHEN 'INCI_ID' THEN regex_pattern := '^INCI-[A-Z0-9-]{6,20}$';
        WHEN 'IEEE_11073_ID' THEN regex_pattern := '^[0-9A-Fa-f]{16}$';
        WHEN 'LOINC_CODE' THEN regex_pattern := '^\d{3,5}-\d$';
        WHEN 'NPI' THEN regex_pattern := '^\d{10}$';
        WHEN 'PLU_CODE' THEN regex_pattern := '^(3\d{3}|4\d{3}|8\d{4}|9\d{4})$';
        WHEN 'UPRN' THEN regex_pattern := '^\d{12}$';
        WHEN 'GTIN14' THEN regex_pattern := '^\d{14}$';
        WHEN 'GS1_DIGITAL_LINK' THEN regex_pattern := '^https?:\/\/id\.gs1\.org\/\d{2}\/.+$';
        WHEN 'E_AMBROSIA_ID' THEN regex_pattern := '^PGI-[A-Z]{2}-\d{6,8}$';
        -- Software, Patents, Energy & Corporate Entities
        WHEN 'API_ENDPOINT_UUID' THEN regex_pattern := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
        WHEN 'BIC_SWIFT' THEN regex_pattern := '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$';
        WHEN 'CPC_PATENT' THEN regex_pattern := '^[A-H]\d{2}[A-Z]\d{1,4}\/\d{2,6}$';
        WHEN 'CVE_ID' THEN regex_pattern := '^CVE-\d{4}-\d{4,7}$';
        WHEN 'DOCDB_PATENT' THEN regex_pattern := '^[A-Z]{2}\d{1,12}[A-Z]\d?$';
        WHEN 'DUNS_NUMBER' THEN regex_pattern := '^\d{9}$';
        WHEN 'EIC_CODE' THEN regex_pattern := '^\d{2}[A-Z0-9\-]{14}$';
        WHEN 'EID' THEN regex_pattern := '^89\d{30}$';
        WHEN 'IMEI' THEN regex_pattern := '^\d{15}$';
        WHEN 'LEI' THEN regex_pattern := '^[A-Z0-9]{18}\d{2}$';
        WHEN 'MAC_ADDRESS' THEN regex_pattern := '^([0-9A-FA-F]{2}[:-]){5}([0-9A-FA-F]{2})$';
        WHEN 'PURL' THEN regex_pattern := '^pkg:[a-z0-9-]+\/[a-z0-9_.@-]+\/?[a-z0-9_.-]+@.+$';  -- namespace class gains the at-sign (flagged correction, addendum 31): scoped npm purls
        WHEN 'REC_SERIAL' THEN regex_pattern := '^REC-[A-Z]{2}-\d{8}-\d{6}$';
        WHEN 'SCADA_UUID' THEN regex_pattern := '^SCADA-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
        WHEN 'SPDX_ID' THEN regex_pattern := '^SPDXRef-[A-Za-z0-9.-]+$';
        WHEN 'SWID_TAG' THEN regex_pattern := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
        WHEN 'GSRN' THEN regex_pattern := '^\d{18}$';
        WHEN 'THREEGPP_SPEC' THEN regex_pattern := '^3GPP-TS-\d{2}\.\d{3}$';
        -- Extended sports telemetry (canon v15, addendum 33)
        WHEN 'SECOND_SPECTRUM_ID' THEN regex_pattern := '^SS-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
        WHEN 'OPTA_PERSON_ID' THEN regex_pattern := '^p\d{4,8}$';
        WHEN 'GENIUS_SPORTS_ID' THEN regex_pattern := '^GS-ENT-\d{6,10}$';
        WHEN 'CATAPULT_SESSION_UUID' THEN regex_pattern := '^CAT-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
        WHEN 'KINEXON_ID' THEN regex_pattern := '^KX-TAG-[A-F0-9]{8,12}$';
        WHEN 'ICC_PLAYER_ID' THEN regex_pattern := '^ICC-\d{5,8}$';
        WHEN 'WORLD_ATHLETICS_ID' THEN regex_pattern := '^WA-\d{7,10}$';
        -- New Web3 & Spatial Types (canon v25)
        WHEN 'H3_INDEX' THEN regex_pattern := '^[89a-fA-F][0-9a-fA-F]{14}$';
        WHEN 'DID_URI' THEN regex_pattern := '^did:[a-z0-9]+:[a-zA-Z0-9._%-]+$';
        WHEN 'ETH_ADDRESS' THEN regex_pattern := '^0x[a-fA-F0-9]{40}$';
        WHEN 'W3C_VC_ID' THEN regex_pattern := '^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

    ELSE
        RAISE EXCEPTION 'Unknown or unpermitted primary_code_type: %', NEW.primary_code_type;
    END CASE;

    IF NEW.primary_code_value !~ regex_pattern THEN
        RAISE EXCEPTION 'Validation failed for %: value "%" does not match required regex pattern.',
            NEW.primary_code_type, NEW.primary_code_value;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger Attachment
DROP TRIGGER IF EXISTS trg_validate_global_identifier ON universal_identity_map;
CREATE TRIGGER trg_validate_global_identifier
BEFORE INSERT OR UPDATE ON universal_identity_map
FOR EACH ROW EXECUTE FUNCTION validate_global_identifier();

-- House hardening (repo migration conventions): RLS on, service_role grant —
-- idempotent restatements of the 0012 posture, carried so the migration can
-- be applied to a database where 0012 already ran without ordering concerns.
ALTER TABLE universal_identity_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_identifier_cross_ref ENABLE ROW LEVEL SECURITY;
GRANT ALL ON universal_identity_map TO service_role;
GRANT ALL ON global_identifier_cross_ref TO service_role;
