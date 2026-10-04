/**
 * The external registry API ping (PR 53, the founder universal-identifier
 * directive).
 *
 * The UNCLAIMED_IDENTIFIER_HOLD's claim verification runs against an
 * EXTERNAL registry: a held identifier is "verified" only when the
 * registry itself answers that the identity is real and attests the
 * cross-links the release flow reconciles. This module is the
 * integration seam — the CLIENT contract, the verdict shape, and the
 * v1 cross-code chain maps the detector deferred here — plus the
 * fail-closed consumption discipline the release flow applies.
 *
 * NO vendor is invented: production wires a concrete client when the
 * founder names the registry endpoint (an HTTP adapter implementing
 * `RegistryPingClient`). The client OWNS its transport — including its
 * timeout — because the flow's only obligation is the consumption rule:
 * ANY rejection (error, timeout, malformed payload) or unverified
 * verdict is treated as UNVERIFIED, and unverified never releases
 * money. The engine never catches a ping into a release.
 */

/** One held identifier's ping request: the escrow's scope pair, plus the
 * family's mandatory chain links as verification context when the
 * caller knows the family (see IDENTIFIER_CHAIN_MAPS). */
export interface RegistryPingRequest {
  primaryCodeType: string;
  primaryCodeValue: string;
  /** The family's mandatory-link order (registry-side vocabulary), or
   * null when the family is not one of the v1 chains. */
  mandatoryChainLinks: readonly string[] | null;
}

/** A registry-attested cross-link: the linked code the registry
 * verifies for the primary identity. Presence-validated on arrival —
 * the registry's type vocabulary is its own, never re-validated here. */
export interface RegistryPingCrossLink {
  linkedCodeType: string;
  linkedCodeValue: string;
}

/** The registry's verdict. `verified: false` (or any transport failure)
 * is fail-closed: the flow writes NO evidence and releases NOTHING. */
export interface RegistryPingVerdict {
  verified: boolean;
  /** The registry's own reference for the verification event, stamped
   * into the recorded cross-links' verification_source for audit. */
  registryRef: string | null;
  /** The cross-links the registry attests for the primary identity. */
  crossLinks: RegistryPingCrossLink[];
  /** The registry's human-readable detail (absent on transport
   * failure — the flow synthesizes its own fail-closed detail). */
  detail: string;
}

/**
 * The integration seam. Production wires the HTTP client when the
 * registry endpoint is named; tests stub it. A missing or failing
 * client is fail-closed BY DESIGN — the hold stays locked.
 */
export interface RegistryPingClient {
  pingIdentity(request: RegistryPingRequest): Promise<RegistryPingVerdict>;
}

/**
 * The v1 cross-code chain maps (the detector's deferred families,
 * verbatim): the mandatory-link order each family's registry
 * verification is expected to attest.
 *
 * - MUSIC: recordings to works to parties to identities to licensees.
 * - SPORTS: the NIL identity chain to the athlete's institutional and
 *   collective links.
 * - FILM: the audiovisual work chain to the advertising and collection
 *   identifiers.
 *
 * These maps are REQUEST CONTEXT for the ping (which links to ask the
 * registry about) — detection and release gates never read them: the
 * release gate reads the recorded EVIDENCE (the verified cross-link
 * rows), not the maps.
 */
export const IDENTIFIER_CHAIN_MAPS = {
  music: ["ISRC", "ISWC", "IPI", "ISNI", "MWLI"],
  sports: ["NIL", "GLAN", "PAID", "NCAA", "GLN"],
  film: ["EIDR", "ISAN", "Ad-ID", "CAMA"],
} as const;

export type IdentifierChainName = keyof typeof IDENTIFIER_CHAIN_MAPS;

/** The v1 chain's mandatory-link order, or null for an unknown family. */
export function chainLinksFor(
  chain: string | null | undefined,
): readonly string[] | null {
  if (chain === null || chain === undefined) {
    return null;
  }
  const links = (IDENTIFIER_CHAIN_MAPS as Record<string, readonly string[]>)[
    chain
  ];
  return links ?? null;
}
