import { createHash } from "node:crypto";
import {
  ASSET_CATEGORIES,
  isSplitPartyRole,
  type AssetCategory,
  type SplitParty,
  type Universal20Identifiers,
  type UniversalWorkManifest,
} from "./types";
import { UNIVERSAL_20_IDENTIFIER_KEYS } from "./identifiers";

export type ParseWorkOk = { ok: true; manifest: UniversalWorkManifest };
export type ParseWorkErr = {
  ok: false;
  code: "invalid_manifest" | "work_exists";
  message: string;
};
export type ParseWorkResult = ParseWorkOk | ParseWorkErr;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseIdentifiers(value: unknown): Universal20Identifiers {
  const record = asRecord(value) ?? {};
  const identifiers: Universal20Identifiers = {};
  for (const key of UNIVERSAL_20_IDENTIFIER_KEYS) {
    const item = record[key];
    if (typeof item === "string" && item.trim() !== "") {
      identifiers[key] = item.trim();
    }
  }
  return identifiers;
}

function parseSplits(value: unknown): SplitParty[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const splits: SplitParty[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (!row) {
      return undefined;
    }
    const partyId = asString(row.partyId);
    const name = asString(row.name) ?? asString(row.partyName);
    const roleRaw = asString(row.role);
    const payoutWalletOrBank =
      asString(row.payoutWalletOrBank) ?? asString(row.payoutWalletOrAccount);
    if (!partyId || !name || !roleRaw || !isSplitPartyRole(roleRaw) || !payoutWalletOrBank) {
      return undefined;
    }
    const shareBps = row.shareBps;
    const sharePercentage = row.sharePercentage;
    splits.push({
      partyId,
      name,
      role: roleRaw,
      payoutWalletOrBank,
      ipi: asString(row.ipi) ?? asString(row.ipiNumber),
      isni: asString(row.isni),
      ...(typeof shareBps === "number" ? { shareBps } : {}),
      ...(typeof sharePercentage === "number" ? { sharePercentage } : {}),
    });
  }
  return splits;
}

function isAssetCategory(value: string): value is AssetCategory {
  return (ASSET_CATEGORIES as readonly string[]).includes(value);
}

function slugTitle(title: string): string {
  const slug = title.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug === "" ? "work" : slug.slice(0, 40);
}

export function allocateWorkId(title: string, occupied: ReadonlySet<string>): string {
  const base = `work_${slugTitle(title)}`;
  if (!occupied.has(base)) {
    return base;
  }
  let n = 2;
  while (occupied.has(`${base}_${n}`)) {
    n += 1;
  }
  return `${base}_${n}`;
}

function metadataHashFor(title: string, identifiers: Universal20Identifiers): string {
  return createHash("sha256")
    .update(JSON.stringify({ title, identifiers }))
    .digest("hex")
    .slice(0, 24);
}

/**
 * Parse a work-registration body. Accepts HTTP and MCP shapes, including
 * partyName / payoutWalletOrAccount aliases. workId is generated when omitted.
 */
export function parseWorkRegistration(
  value: unknown,
  occupiedWorkIds: ReadonlySet<string> = new Set(),
): ParseWorkResult {
  const row = asRecord(value);
  if (!row) {
    return {
      ok: false,
      code: "invalid_manifest",
      message: "Must provide title and array of split parties.",
    };
  }
  const title = asString(row.title);
  const splits = parseSplits(row.splits);
  if (!title || !splits || splits.length === 0) {
    return {
      ok: false,
      code: "invalid_manifest",
      message: "Must provide title and array of split parties.",
    };
  }
  const categoryRaw = asString(row.category) ?? "AUDIO";
  if (!isAssetCategory(categoryRaw)) {
    return {
      ok: false,
      code: "invalid_manifest",
      message: "category must be a known AssetCategory.",
    };
  }
  const territories = Array.isArray(row.registeredTerritories)
    ? row.registeredTerritories.filter((item): item is string => typeof item === "string")
    : ["WW"];
  const requestedId = asString(row.workId);
  if (requestedId && occupiedWorkIds.has(requestedId)) {
    return {
      ok: false,
      code: "work_exists",
      message: `workId ${requestedId} is already registered.`,
    };
  }
  const workId = requestedId ?? allocateWorkId(title, occupiedWorkIds);
  const identifiers = parseIdentifiers(row.identifiers);
  return {
    ok: true,
    manifest: {
      workId,
      title,
      category: categoryRaw,
      identifiers,
      splits,
      mulCertificateId: asString(row.mulCertificateId) ?? `mul_${workId}`,
      metadataHash: asString(row.metadataHash) ?? metadataHashFor(title, identifiers),
      primaryMediaUrl: asString(row.primaryMediaUrl),
      registeredTerritories: territories.length > 0 ? territories : ["WW"],
    },
  };
}
