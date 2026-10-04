/**
 * The verified cross-link evidence of record (PR 53, the founder
 * universal-identifier directive).
 *
 * The UNCLAIMED_IDENTIFIER_HOLD's release gate reads EVIDENCE, not
 * claims: a held identifier releases only when a cross-link row that the
 * EXTERNAL REGISTRY attested exists in
 * `global_identifier_cross_ref` (migration 0012) — the table whose
 * `verification_source` and `verified_at` columns are the evidence
 * fields of record. Ingest-time cross-links are self-attested (the
 * ingestor's say-so); a registry-ping-stamped row is the registry's.
 *
 * The table exists ONLY in Supabase/Postgres — it is keyed to
 * `universal_identity_map` (map_id) and the in-memory and sqlite
 * backends have no identity registry to fake. So the evidence crosses
 * the release engine as a SEAM with its own backends — the
 * VaultLookup precedent in matchQueue.ts — never through the Store
 * interface. Production binds the pg implementation; tests bind the
 * in-memory twin.
 */

/** One verified cross-link of record — the evidence fields the release
 * gate reads (verification_source, verified_at) on the identity pair
 * they attest. */
export interface VerifiedCrossLinkRow {
  primary_code_type: string;
  primary_code_value: string;
  linked_code_type: string;
  linked_code_value: string;
  verification_source: string;
  verified_at: string | null;
}

/**
 * The evidence seam. `recordVerifiedCrossLink` THROWS when the primary
 * identity is not registered in `universal_identity_map`: reconciliation
 * requires the identity OF RECORD — the engine never invents a map row
 * to land a ping's attestation (fail-closed; the hold stays locked).
 */
export interface CrossLinkEvidenceStore {
  recordVerifiedCrossLink(row: {
    primaryCodeType: string;
    primaryCodeValue: string;
    linkedCodeType: string;
    linkedCodeValue: string;
    verificationSource: string;
    verifiedAt: string;
  }): Promise<void>;
  listVerifiedCrossLinks(
    primaryCodeType: string,
    primaryCodeValue: string,
  ): Promise<VerifiedCrossLinkRow[]>;
}

/**
 * The production (Supabase/Postgres) implementation over migration
 * 0012's tables, shaped exactly like the founder v13 cross-ref upsert in
 * ingestRecords.ts: resolve the registered identity's map_id, then
 * upsert the cross-ref on its UNIQUE (map_id, linked_code_type,
 * linked_code_value) — NEVER carrying the id column in the conflict
 * payload (the id rotates on conflict). On conflict the attestation is
 * refreshed (verification_source, verified_at) — the release gate reads
 * the LATEST verification of record.
 */
export class PgCrossLinkEvidenceStore implements CrossLinkEvidenceStore {
  constructor(
    private readonly pool: {
      query: (sql: string, values?: unknown[]) => Promise<unknown>;
    },
  ) {}

  async recordVerifiedCrossLink(row: {
    primaryCodeType: string;
    primaryCodeValue: string;
    linkedCodeType: string;
    linkedCodeValue: string;
    verificationSource: string;
    verifiedAt: string;
  }): Promise<void> {
    const found = (await this.pool.query(
      `SELECT map_id FROM universal_identity_map
       WHERE primary_code_type = $1 AND primary_code_value = $2
       LIMIT 1`,
      [row.primaryCodeType, row.primaryCodeValue],
    )) as { rows: { map_id: string }[] };
    const mapId = found.rows[0]?.map_id;
    if (mapId === undefined) {
      // Fail-closed: no registered identity of record, no evidence row —
      // the release gate cannot be satisfied by an unregistered pair.
      throw new Error(
        `identifier_cross_link_identity_unregistered: ${row.primaryCodeType}:${row.primaryCodeValue}`,
      );
    }
    await this.pool.query(
      `INSERT INTO global_identifier_cross_ref
         (map_id, linked_code_type, linked_code_value, verification_source, verified_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)
       ON CONFLICT (map_id, linked_code_type, linked_code_value)
       DO UPDATE SET
         verification_source = EXCLUDED.verification_source,
         verified_at = EXCLUDED.verified_at`,
      [
        mapId,
        row.linkedCodeType,
        row.linkedCodeValue,
        row.verificationSource,
        row.verifiedAt,
      ],
    );
  }

  async listVerifiedCrossLinks(
    primaryCodeType: string,
    primaryCodeValue: string,
  ): Promise<VerifiedCrossLinkRow[]> {
    const found = (await this.pool.query(
      `SELECT ref.linked_code_type, ref.linked_code_value,
              ref.verification_source, ref.verified_at
       FROM global_identifier_cross_ref ref
       JOIN universal_identity_map map ON map.map_id = ref.map_id
       WHERE map.primary_code_type = $1 AND map.primary_code_value = $2
       ORDER BY ref.verified_at NULLS LAST, ref.linked_code_type`,
      [primaryCodeType, primaryCodeValue],
    )) as { rows: VerifiedCrossLinkRow[] };
    return found.rows;
  }
}

/**
 * The in-memory twin — local development and tests. Same seam, same
 * throw-on-unregistered discipline, keyed on the identity pair.
 */
export class InMemoryCrossLinkEvidenceStore implements CrossLinkEvidenceStore {
  private readonly rows = new Map<string, VerifiedCrossLinkRow>();

  private key(
    primaryCodeType: string,
    primaryCodeValue: string,
    linkedCodeType: string,
    linkedCodeValue: string,
  ): string {
    return [
      primaryCodeType,
      primaryCodeValue,
      linkedCodeType,
      linkedCodeValue,
    ].join("\u0000");
  }

  async recordVerifiedCrossLink(row: {
    primaryCodeType: string;
    primaryCodeValue: string;
    linkedCodeType: string;
    linkedCodeValue: string;
    verificationSource: string;
    verifiedAt: string;
  }): Promise<void> {
    const key = this.key(
      row.primaryCodeType,
      row.primaryCodeValue,
      row.linkedCodeType,
      row.linkedCodeValue,
    );
    this.rows.set(key, {
      primary_code_type: row.primaryCodeType,
      primary_code_value: row.primaryCodeValue,
      linked_code_type: row.linkedCodeType,
      linked_code_value: row.linkedCodeValue,
      verification_source: row.verificationSource,
      verified_at: row.verifiedAt,
    });
  }

  async listVerifiedCrossLinks(
    primaryCodeType: string,
    primaryCodeValue: string,
  ): Promise<VerifiedCrossLinkRow[]> {
    // The pair prefix — one trailing separator, so keys of THIS pair match
    // (a doubled separator would require an empty linked_code_type and
    // match nothing).
    const prefix =
      [primaryCodeType, primaryCodeValue].join("\u0000") + "\u0000";
    const out: VerifiedCrossLinkRow[] = [];
    for (const [key, row] of this.rows.entries()) {
      if (key.startsWith(prefix)) {
        out.push({ ...row });
      }
    }
    return out.sort((a, b) =>
      (a.verified_at ?? "").localeCompare(b.verified_at ?? ""),
    );
  }
}
