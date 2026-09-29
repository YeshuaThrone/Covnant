import { describe, expect, it } from "vitest";

import { parseIdentity } from "../validation";

/**
 * Don KYC phone normalization gates — the money module accepts any
 * real-world phone capture through the SAME shared normalizer as signup
 * (src/lib/phone.ts) and stores canonical E.164. Behavior-preserving on
 * everything else: the existing E.164 rule still runs on the normalized
 * value, so only genuinely unnormalizable input is rejected.
 */

const NOW = new Date("2026-01-15T00:00:00.000Z");

function identityWithPhone(phone: unknown) {
  return {
    legal_name: "QA Checker",
    date_of_birth: "1990-01-01",
    email: "qa-phone@example.com",
    phone,
  };
}

describe("parseIdentity phone normalization", () => {
  it("accepts any real-world US capture and stores canonical E.164", () => {
    for (const captured of [
      "830-358-2306",
      "8303582306",
      "(830) 358-2306",
      "830.358.2306",
      "+1 830 358 2306",
      "1-830-358-2306",
    ]) {
      const result = parseIdentity(identityWithPhone(captured), NOW);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.phone).toBe("+18303582306");
      }
    }
  });

  it("passes already-canonical international numbers through unchanged", () => {
    const result = parseIdentity(identityWithPhone("+447700900123"), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phone).toBe("+447700900123");
    }
  });

  it("keeps an absent phone null (the field stays optional)", () => {
    for (const phone of [undefined, null, ""]) {
      const result = parseIdentity(identityWithPhone(phone), NOW);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.phone).toBeNull();
      }
    }
  });

  it("still rejects non-strings and unnormalizable input fail-closed", () => {
    for (const phone of [
      5125550123,
      "123",
      "not-a-phone",
      "830-358-2306 ext 5",
      "+123",
      "+01234567",
    ]) {
      const result = parseIdentity(identityWithPhone(phone), NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("invalid_phone");
      }
    }
  });
});
