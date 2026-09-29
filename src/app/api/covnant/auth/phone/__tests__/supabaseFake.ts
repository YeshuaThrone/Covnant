/**
 * Route-test fake for the service-role Supabase client — the seam the two
 * phone OTP routes own I/O through. Dumb by design: every terminal returns
 * the test's canned state, every builder call is recorded, and the tests
 * assert on the calls (what was written, with which filters) rather than
 * re-implementing PostgREST semantics. An insert/update chain is awaited
 * directly (thenable); a select chain ends in maybeSingle().
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;

export interface UpdateCall {
  table: string;
  patch: Row;
  /** The .is(column, null) filters applied to the update, in order. */
  isFilters: Array<[string, unknown]>;
  eqFilters: Array<[string, unknown]>;
  /** The count option the route requested ('exact' on the single-use claim). */
  countOption?: string;
}

export interface FakeState {
  /** creator_profiles row returned by the email lookup (null = none). */
  profile: Row | null;
  /** phone_verifications latest row returned by the cooldown/candidate read. */
  latestRow: Row | null;
  /** Error injected into every terminal (route → sanitized 500). */
  error: { message: string } | null;
  /** The count returned by update terminals — 0 simulates a lost single-use claim. */
  updateCount: number | null;
}

export interface RecordedCalls {
  updates: UpdateCall[];
  inserts: Array<{ table: string; payload: Row }>;
}

export interface FakeHarness {
  state: FakeState;
  calls: RecordedCalls;
  admin: SupabaseClient;
}

export function createSupabaseFake(): FakeHarness {
  const state: FakeState = {
    profile: null,
    latestRow: null,
    error: null,
    updateCount: 1,
  };
  const calls: RecordedCalls = { updates: [], inserts: [] };

  function makeBuilder(table: string): Record<string, unknown> {
    const builder: {
      patch?: Row;
      countOption?: string;
      eqFilters: Array<[string, unknown]>;
      isFilters: Array<[string, unknown]>;
      [key: string]: unknown;
    } = { eqFilters: [], isFilters: [] };

    const updateTerminal = (): {
      data: null;
      error: { message: string } | null;
      count: number | null;
    } => {
      calls.updates.push({
        table,
        patch: builder.patch ?? {},
        eqFilters: builder.eqFilters,
        isFilters: builder.isFilters,
        countOption: builder.countOption,
      });
      return { data: null, error: state.error, count: state.updateCount };
    };

    const selectTerminal = (): { data: Row | null; error: { message: string } | null } => ({
      data: table === 'creator_profiles' ? state.profile : state.latestRow,
      error: state.error,
    });

    builder.select = () => builder;
    builder.update = (patch: Row, options?: { count?: string }) => {
      builder.patch = patch;
      builder.countOption = options?.count;
      return builder;
    };
    builder.eq = (column: string, value: unknown) => {
      builder.eqFilters.push([column, value]);
      return builder;
    };
    builder.is = (column: string, value: unknown) => {
      builder.isFilters.push([column, value]);
      return builder;
    };
    builder.gt = () => builder;
    builder.order = () => builder;
    builder.limit = () => builder;
    builder.maybeSingle = () => Promise.resolve(selectTerminal());
    builder.insert = (payload: Row) => {
      calls.inserts.push({ table, payload });
      return builder;
    };
    builder.then = (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve(updateTerminal()).then(
        onFulfilled as ((value: unknown) => unknown) | undefined,
        onRejected,
      );
    return builder;
  }

  const admin = {
    from: (table: string) => makeBuilder(table),
  } as unknown as SupabaseClient;

  return { state, calls, admin };
}

/** Pulls the 6-digit code out of the captured SMS body (test helper). */
export function codeFromMessage(message: string): string {
  const match = message.match(/(\d{6})/);
  if (!match) throw new Error(`Captured SMS body carries no 6-digit code: ${message}`);
  return match[1];
}
