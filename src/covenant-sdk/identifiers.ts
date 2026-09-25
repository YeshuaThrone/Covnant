/**
 * The 20 Universal Global Identifiers for Covenant collection matching.
 */

import {
  UNIVERSAL_20_IDENTIFIER_KEYS,
  type Universal20IdentifierKey,
  type Universal20Identifiers,
} from "./types";

export {
  UNIVERSAL_20_IDENTIFIER_KEYS,
  type Universal20IdentifierKey,
  type Universal20Identifiers,
};

/** @deprecated Use UNIVERSAL_20_IDENTIFIER_KEYS — kept as an alias. */
export const UNIVERSAL_GLOBAL_IDENTIFIERS = UNIVERSAL_20_IDENTIFIER_KEYS;
export type UniversalGlobalIdentifier = Universal20IdentifierKey;

export const UNIVERSAL_GLOBAL_IDENTIFIER_COUNT =
  UNIVERSAL_20_IDENTIFIER_KEYS.length;

export function isUniversalGlobalIdentifier(
  value: string,
): value is Universal20IdentifierKey {
  return (UNIVERSAL_20_IDENTIFIER_KEYS as readonly string[]).includes(value);
}

export function boundIdentifierCount(
  identifiers: Universal20Identifiers,
): number {
  let count = 0;
  for (const key of UNIVERSAL_20_IDENTIFIER_KEYS) {
    if (boundIdentifierValue(identifiers, key) !== undefined) {
      count += 1;
    }
  }
  return count;
}

export function hasBoundIdentifier(
  identifiers: Universal20Identifiers,
  key: Universal20IdentifierKey,
): boolean {
  return boundIdentifierValue(identifiers, key) !== undefined;
}

export function boundIdentifierValue(
  identifiers: Universal20Identifiers | Partial<Universal20Identifiers>,
  key: Universal20IdentifierKey,
): string | undefined {
  const value = identifiers[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function identifiersShareBoundCode(
  left: Universal20Identifiers | Partial<Universal20Identifiers> | undefined,
  right: Universal20Identifiers | Partial<Universal20Identifiers> | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  return UNIVERSAL_20_IDENTIFIER_KEYS.some((key) => {
    const leftValue = boundIdentifierValue(left, key);
    const rightValue = boundIdentifierValue(right, key);
    return leftValue !== undefined && rightValue !== undefined && leftValue === rightValue;
  });
}
