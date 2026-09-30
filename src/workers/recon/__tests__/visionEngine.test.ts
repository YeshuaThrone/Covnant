/**
 * Vision engine seam tests — fail-closed configuration reading, PDF/image
 * sniffing, strict response validation, and transport-failure handling. The
 * worker never links a vendor SDK; the seam is one HTTP POST validated
 * against the worker's normalized-row contract.
 */
import { describe, expect, it } from "vitest";

import {
  looksLikePdfOrImage,
  readVisionEngineConfig,
  runVisionEngine,
} from "../visionEngine";

const CONFIG = { url: "https://vision.example/parse", apiKey: "k-test", model: "vision-1" };

describe("readVisionEngineConfig", () => {
  it("returns null when the seam is unconfigured (fail-closed default)", () => {
    expect(readVisionEngineConfig({ NODE_ENV: "test" })).toBeNull();
  });

  it("requires all three env names", () => {
    expect(
      readVisionEngineConfig({
        NODE_ENV: "test",
        RECON_VISION_URL: "https://x",
        RECON_VISION_API_KEY: "k",
      }),
    ).toBeNull();
    expect(
      readVisionEngineConfig({
        NODE_ENV: "test",
        RECON_VISION_URL: "https://x",
        RECON_VISION_MODEL: "m",
      }),
    ).toBeNull();
    expect(
      readVisionEngineConfig({
        NODE_ENV: "test",
        RECON_VISION_API_KEY: "k",
        RECON_VISION_MODEL: "m",
      }),
    ).toBeNull();
  });

  it("rejects whitespace-only values and accepts a full configuration", () => {
    expect(
      readVisionEngineConfig({
        NODE_ENV: "test",
        RECON_VISION_URL: "  ",
        RECON_VISION_API_KEY: "k",
        RECON_VISION_MODEL: "m",
      }),
    ).toBeNull();
    expect(
      readVisionEngineConfig({
        NODE_ENV: "test",
        RECON_VISION_URL: " https://x ",
        RECON_VISION_API_KEY: "k",
        RECON_VISION_MODEL: "m",
      }),
    ).toEqual({ url: "https://x", apiKey: "k", model: "m" });
  });
});

describe("looksLikePdfOrImage", () => {
  it("sniffs the PDF signature", () => {
    expect(looksLikePdfOrImage("%PDF-1.7 ...")).toBe(true);
  });

  it("sniffs binary image bytes decoded through a text column", () => {
    expect(looksLikePdfOrImage("\uFFFDPNG-restored-bytes")).toBe(true);
    expect(looksLikePdfOrImage("....\uFFFDJFIF-restored-bytes")).toBe(true);
    expect(looksLikePdfOrImage("\uFFFD\uFFFD-random-binary")).toBe(true);
  });

  it("treats delimited text as not-image content", () => {
    expect(looksLikePdfOrImage("Sale Date,Store,Artist\n")).toBe(false);
  });
});

describe("runVisionEngine", () => {
  const PDF_CONTENT = "%PDF-1.7 statement bytes";

  it("posts the model, file name, and content to the configured endpoint", async () => {
    let seenInit: RequestInit | null = null;
    const outcome = await runVisionEngine(PDF_CONTENT, "stmt.pdf", CONFIG, async (url, init) => {
      expect(url).toBe(CONFIG.url);
      seenInit = init;
      return [];
    });
    expect(outcome.ok).toBe(true);
    const init = seenInit as unknown as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      model: "vision-1",
      file_name: "stmt.pdf",
      content: PDF_CONTENT,
    });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer k-test");
  });

  it("returns a named failure when the transport throws", async () => {
    const outcome = await runVisionEngine(PDF_CONTENT, "stmt.pdf", CONFIG, async () => {
      throw new Error("connection refused");
    });
    expect(outcome).toEqual({ ok: false, reason: "vision engine failed: connection refused" });
  });

  it("rejects a non-array response", async () => {
    const outcome = await runVisionEngine(PDF_CONTENT, "s.pdf", CONFIG, async () => ({
      rows: [],
    }));
    expect(outcome).toEqual({
      ok: false,
      reason: "vision engine failed: response is not an array",
    });
  });

  it("accepts a valid normalized row and maps it to a quarantined line", async () => {
    const outcome = await runVisionEngine(PDF_CONTENT, "s.pdf", CONFIG, async () => [
      {
        line_number: 3,
        gross_micros: "47904000000",
        currency: "USD",
        period: "2026-08",
        work_title: "Midnight Reel",
        territory: "US",
        platform: "Amazon Prime",
        eidr: "10.5240/000A-000B-000C-000D-000E-F",
        isrc: "",
      },
    ]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.model).toBe("vision-1");
      const [line] = outcome.lines;
      expect(line.grossMicros).toBe(47_904_000_000n);
      expect(line.rightsType).toBe("unknown");
      expect(line.statementSourceType).toBeNull(); // engines cannot classify kinds
      expect(line.identifiers.EIDR).toBe("10.5240/000A-000B-000C-000D-000E-F");
      expect(line.identifiers.ISRC).toBeUndefined();
    }
  });

  it("rejects rows with non-integer money, bad currency, or claimed statement kinds", async () => {
    const cases: readonly unknown[] = [
      [{ gross_micros: "4.99", currency: "USD" }],
      [{ gross_micros: "47904000000", currency: "usd" }],
      [{ gross_micros: "47904000000", currency: "USD", statement_source_type: "vod" }],
      [{ currency: "USD" }],
      // A row without a usable line number cannot get a stable event_id —
      // reject it rather than collapsing rows into one identity.
      [{ gross_micros: "100", currency: "USD" }],
      [{ gross_micros: "100", currency: "USD", line_number: 1.5 }],
    ];
    for (const rows of cases) {
      const outcome = await runVisionEngine(PDF_CONTENT, "s.pdf", CONFIG, async () => rows);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/^vision engine failed: invalid engine row/);
    }
  });

  it("rejects a response with duplicate row numbers — never silently drop a row", async () => {
    const outcome = await runVisionEngine(PDF_CONTENT, "s.pdf", CONFIG, async () => [
      { line_number: 1, gross_micros: "100", currency: "USD" },
      { line_number: 1, gross_micros: "200", currency: "USD" },
    ]);
    expect(outcome).toEqual({
      ok: false,
      reason: "vision engine failed: duplicate engine row number: 1",
    });
  });
});
