/**
 * Client-safe mirror of the engine's CURRENCY_DECIMALS map.
 *
 * The vendored engine (src/engine/covenant-master-sdk.ts) carries inline
 * `'use server'` actions, so importing ANY runtime value from it inside a
 * client component drags the whole engine into the client bundle and breaks
 * the production build. Client components import this copy instead.
 * Keep in sync with the engine constant (engine is source of truth).
 */
export const CURRENCY_DECIMALS: Record<string, number> = {
  USD: 4, EUR: 4, GBP: 4, CAD: 4, AUD: 4, JPY: 2, MXN: 4, BRL: 4, INR: 4, CNY: 4,
  SAT: 8, ETH: 8, SOL: 8, MARS_CREDIT: 6,
};
