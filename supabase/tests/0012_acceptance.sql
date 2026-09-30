-- Founder v12 — PostgreSQL Ingestion Validation Suite (2026-09-30)
-- Transactional acceptance test for migration 0012 (universal_identity_map + trg_validate_global_identifier).
-- Acceptance rule: all 13 valid rows INSERT, all 3 malformed rows RAISE the trigger exception, ROLLBACK leaves nothing.
-- vertical_category vocabulary as used by the founder's own test data:
--   FINE_ART, PRO_SPORTS, SPATIAL, HEALTH_FITNESS, CULINARY, HARDWARE, CORPORATE, ENERGY
-- Carried verbatim from the founder directive.

-- Comprehensive PostgreSQL Validation & Ingestion Test Suite
BEGIN;

-- 1. Test Valid Ingestion (Should all succeed)
INSERT INTO universal_identity_map (entity_id, vertical_category, primary_code_type, primary_code_value)
VALUES
    (gen_random_uuid(), 'FINE_ART', 'AAT_ID', 'AAT-30000000'),
    (gen_random_uuid(), 'FINE_ART', 'ARK', 'ark:/12148/btv1b8449691v'),
    (gen_random_uuid(), 'FINE_ART', 'DARIA_ID', 'DARIA-0123456789ABCDEF'),
    (gen_random_uuid(), 'PRO_SPORTS', 'FIFA_CONNECT_ID', '190ABC123456'),
    (gen_random_uuid(), 'PRO_SPORTS', 'GLAN', 'GLAN-A1B2C3D4E5F6'),
    (gen_random_uuid(), 'PRO_SPORTS', 'PAID', 'NFLPA-123456'),
    (gen_random_uuid(), 'SPATIAL', 'GLN', '0614141000005'),
    (gen_random_uuid(), 'HEALTH_FITNESS', 'NPI', '1234567890'),
    (gen_random_uuid(), 'CULINARY', 'PLU_CODE', '4011'),
    (gen_random_uuid(), 'HARDWARE', 'IMEI', '356938035643803'),
    (gen_random_uuid(), 'HARDWARE', 'MAC_ADDRESS', '00:1A:2B:3C:4D:5E'),
    (gen_random_uuid(), 'CORPORATE', 'LEI', '5493001KJTIIGC8Y1S12'),
    (gen_random_uuid(), 'ENERGY', 'EIC_CODE', '10X1001A1001A10X');

-- 2. Verify Ingestion Records
SELECT map_id, vertical_category, primary_code_type, primary_code_value, created_at
FROM universal_identity_map;

-- 3. Test Invalid Syntax Rejection (Must raise exception)
DO $$
BEGIN
    BEGIN
        INSERT INTO universal_identity_map (entity_id, vertical_category, primary_code_type, primary_code_value)
        VALUES (gen_random_uuid(), 'FINE_ART', 'AAT_ID', 'INVALID_AAT_CODE');
        RAISE EXCEPTION 'Test Failed: Database allowed invalid AAT_ID syntax';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'SUCCESS: Rejection triggered as expected for invalid AAT_ID (%)', SQLERRM;
    END;

    BEGIN
        INSERT INTO universal_identity_map (entity_id, vertical_category, primary_code_type, primary_code_value)
        VALUES (gen_random_uuid(), 'PRO_SPORTS', 'PAID', 'INVALID_UNION_CODE-123');
        RAISE EXCEPTION 'Test Failed: Database allowed invalid PAID syntax';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'SUCCESS: Rejection triggered as expected for invalid PAID (%)', SQLERRM;
    END;

    BEGIN
        INSERT INTO universal_identity_map (entity_id, vertical_category, primary_code_type, primary_code_value)
        VALUES (gen_random_uuid(), 'HARDWARE', 'IMEI', '12345');
        RAISE EXCEPTION 'Test Failed: Database allowed short IMEI syntax';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'SUCCESS: Rejection triggered as expected for invalid IMEI (%)', SQLERRM;
    END;
END $$;

ROLLBACK;

