/**
 * Shared test helpers for the recon worker suites — fixture loading from the
 * checked-in fixtures directory (the profile contracts are pinned by these
 * files) and store construction for the worker loop tests.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** Loads one checked-in fixture's text by file name. */
export function loadFixture(name: string): string {
  return readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}
