/**
 * CVT Astra extraction agent — adapter profile registry (PR 6).
 *
 * One profile per traversable dashboard: the deterministic selector table
 * (login form + submit) and the statement-link href pattern that tells the
 * harvest which dashboard links are statement/log/contract downloads.
 * Every profile pairs 1:1 with a recorded fixture set in the worker's test
 * suite — the drift-guard test fails any profile without recorded
 * statements, so the vault's vocabulary (DISTRIBUTOR_CREDENTIAL_SOURCES)
 * and this registry can never fork: a source joins the vault only WITH a
 * profile, and a profile only WITH fixtures.
 *
 * The selectors are deterministic-first per the brief. They were authored
 * from each dashboard's documented sign-in structure and are re-validated
 * on every real traversal; when a dashboard's live layout drifts (selector
 * miss), the traversal falls back to the RECON_VISION_* seam — fail-closed
 * when it is unset. The recorded fixtures pin the ENGINE's behavior; the
 * first live traversals pin the selectors.
 *
 * Registry shape: pure data, no logic — the traversal engine
 * (src/workers/astra/worker.ts) is the single code path every source runs
 * through. Adding a dashboard = one entry here + one recorded fixture.
 */

import { DISTRIBUTOR_CREDENTIAL_SOURCES } from '@/modules/vault/records';
import type { AstraVertical, DistributorConnectionSource } from '@/modules/vault/records';

export interface AstraAdapterProfile {
  distributor: DistributorConnectionSource;
  vertical: AstraVertical;
  loginUrl: string;
  /** The post-login landing page the statement list lives on. */
  dashboardUrl: string;
  /** Deterministic login selectors — filled with vault credentials in memory. */
  selectors: {
    username: string;
    password: string;
    submit: string;
  };
  /**
   * Regex source (compiled by the engine) matching statement/log/contract
   * download hrefs on the dashboard page — the deterministic harvest.
   */
  statementHrefPattern: string;
  /**
   * The recorded statement path the profile's fixtures pin — the composer
   * and the per-distributor tests build the fixture catalog around it. The
   * drift guard asserts it matches statementHrefPattern (a recording that
   * its own pattern would skip is a broken recording).
   */
  fixtureStatementPath: string;
}

/** Every profile URL hangs off this origin — recorded fixtures key off it. */
export const ASTRA_BASE_URL = 'https://astra.covnant.internal';

/**
 * The registry — DISTRIBUTOR_CREDENTIAL_SOURCES exactly, in the same
 * order, grouped by vertical (twenty of them). The drift-guard test pins
 * the two lists to each other.
 */
export const ASTRA_ADAPTER_PROFILES: readonly AstraAdapterProfile[] = [
  // --- music ----------------------------------------------------------------
  {
    distributor: 'distrokid',
    vertical: 'music',
    loginUrl: `${ASTRA_BASE_URL}/distrokid/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/distrokid/bank`,
    selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
    statementHrefPattern: '^/distrokid/reports/[^"]+\\.(csv|tsv)$',
    fixtureStatementPath: '/distrokid/reports/2026-08.csv',
  },
  {
    distributor: 'tunecore',
    vertical: 'music',
    loginUrl: `${ASTRA_BASE_URL}/tunecore/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/tunecore/reports`,
    selectors: { username: '#login-email', password: '#login-password', submit: '#login-button' },
    statementHrefPattern: '^/tunecore/accounting/[^"]+\\.(csv|tsv)$',
    fixtureStatementPath: '/tunecore/accounting/2026-08.csv',
  },
  {
    distributor: 'ascap',
    vertical: 'music',
    loginUrl: `${ASTRA_BASE_URL}/ascap/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/ascap/royalty-distributions`,
    selectors: { username: '#userid', password: '#pin', submit: 'button[type="submit"]' },
    statementHrefPattern: '^/ascap/distributions/[^"]+\\.csv$',
    fixtureStatementPath: '/ascap/distributions/2026-08.csv',
  },
  {
    distributor: 'bmi',
    vertical: 'music',
    loginUrl: `${ASTRA_BASE_URL}/bmi/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/bmi/royalty-statements`,
    selectors: {
      username: 'input[name="username"]',
      password: 'input[name="password"]',
      submit: '#login-btn',
    },
    statementHrefPattern: '^/bmi/statements/[^"]+\\.csv$',
    fixtureStatementPath: '/bmi/statements/2026-08.csv',
  },
  {
    distributor: 'mlc',
    vertical: 'music',
    loginUrl: `${ASTRA_BASE_URL}/mlc/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/mlc/member-portal`,
    selectors: { username: '#email', password: '#password', submit: '#signin' },
    statementHrefPattern: '^/mlc/monthly-distributions/[^"]+\\.csv$',
    fixtureStatementPath: '/mlc/monthly-distributions/2026-08.csv',
  },
  // --- film -----------------------------------------------------------------
  {
    distributor: 'netflix',
    vertical: 'film',
    loginUrl: `${ASTRA_BASE_URL}/netflix/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/netflix/report-library`,
    selectors: {
      username: '#appLoginEmail',
      password: '#appLoginPassword',
      submit: '.login-btn-primary',
    },
    statementHrefPattern: '^/netflix/report-library/[^"]+\\.csv$',
    fixtureStatementPath: '/netflix/report-library/2026-08.csv',
  },
  {
    distributor: 'prime_video',
    vertical: 'film',
    loginUrl: `${ASTRA_BASE_URL}/prime-video/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/prime-video/payments`,
    selectors: { username: '#ap_email', password: '#ap_password', submit: '#signInSubmit' },
    statementHrefPattern: '^/prime-video/payments/[^"]+\\.csv$',
    fixtureStatementPath: '/prime-video/payments/2026-08.csv',
  },
  {
    distributor: 'film_theatrical',
    vertical: 'film',
    loginUrl: `${ASTRA_BASE_URL}/film-theatrical/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/film-theatrical/box-office`,
    selectors: {
      username: 'input[name="user"]',
      password: 'input[name="pass"]',
      submit: '.btn-primary',
    },
    statementHrefPattern: '^/film-theatrical/settlements/[^"]+\\.csv$',
    fixtureStatementPath: '/film-theatrical/settlements/2026-08.csv',
  },
  {
    distributor: 'film_sales_agent',
    vertical: 'film',
    loginUrl: `${ASTRA_BASE_URL}/film-sales-agent/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/film-sales-agent/sales-accounts`,
    selectors: { username: '#account', password: '#secret', submit: '#enter' },
    statementHrefPattern: '^/film-sales-agent/territories/[^"]+\\.csv$',
    fixtureStatementPath: '/film-sales-agent/territories/2026-08.csv',
  },
  // --- podcast --------------------------------------------------------------
  {
    distributor: 'megaphone',
    vertical: 'podcast',
    loginUrl: `${ASTRA_BASE_URL}/megaphone/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/megaphone/revenue`,
    selectors: { username: '#email', password: '#password', submit: 'button[type="submit"]' },
    statementHrefPattern: '^/megaphone/revenue/[^"]+\\.csv$',
    fixtureStatementPath: '/megaphone/revenue/2026-08.csv',
  },
  {
    distributor: 'libsyn',
    vertical: 'podcast',
    loginUrl: `${ASTRA_BASE_URL}/libsyn/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/libsyn/billing`,
    selectors: { username: '#user_login', password: '#user_pass', submit: '#wp-submit' },
    statementHrefPattern: '^/libsyn/billing/[^"]+\\.csv$',
    fixtureStatementPath: '/libsyn/billing/2026-08.csv',
  },
  {
    distributor: 'spotify_podcasters',
    vertical: 'podcast',
    loginUrl: `${ASTRA_BASE_URL}/spotify-podcasters/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/spotify-podcasters/monetization`,
    selectors: {
      username: '#login-username',
      password: '#login-password',
      submit: '#login-button',
    },
    statementHrefPattern: '^/spotify-podcasters/payments/[^"]+\\.csv$',
    fixtureStatementPath: '/spotify-podcasters/payments/2026-08.csv',
  },
  {
    distributor: 'acast',
    vertical: 'podcast',
    loginUrl: `${ASTRA_BASE_URL}/acast/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/acast/shows`,
    selectors: {
      username: 'input[name="email"]',
      password: 'input[name="password"]',
      submit: 'button[type="submit"]',
    },
    statementHrefPattern: '^/acast/revenue-reports/[^"]+\\.csv$',
    fixtureStatementPath: '/acast/revenue-reports/2026-08.csv',
  },
  // --- gaming and AR/VR -------------------------------------------------------
  {
    distributor: 'epic_games',
    vertical: 'gaming',
    loginUrl: `${ASTRA_BASE_URL}/epic-games/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/epic-games/sales`,
    selectors: { username: '#epicUsername', password: '#epicPassword', submit: '#sign_in' },
    statementHrefPattern: '^/epic-games/sales-reports/[^"]+\\.csv$',
    fixtureStatementPath: '/epic-games/sales-reports/2026-08.csv',
  },
  {
    distributor: 'unity_asset_store',
    vertical: 'gaming',
    loginUrl: `${ASTRA_BASE_URL}/unity-asset-store/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/unity-asset-store/publisher-portal`,
    selectors: { username: '#username', password: '#password', submit: '.submit-btn' },
    statementHrefPattern: '^/unity-asset-store/payouts/[^"]+\\.csv$',
    fixtureStatementPath: '/unity-asset-store/payouts/2026-08.csv',
  },
  {
    distributor: 'roblox',
    vertical: 'gaming',
    loginUrl: `${ASTRA_BASE_URL}/roblox/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/roblox/creator-dashboard`,
    selectors: {
      username: 'input[name="username"]',
      password: 'input[name="password"]',
      submit: '.btn-primary-md',
    },
    statementHrefPattern: '^/roblox/devex/[^"]+\\.csv$',
    fixtureStatementPath: '/roblox/devex/2026-08.csv',
  },
  {
    distributor: 'steamworks',
    vertical: 'gaming',
    loginUrl: `${ASTRA_BASE_URL}/steamworks/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/steamworks/sales`,
    selectors: {
      username: 'input[name="accountname"]',
      password: 'input[name="password"]',
      submit: '#login_btn',
    },
    statementHrefPattern: '^/steamworks/reports/[^"]+\\.csv$',
    fixtureStatementPath: '/steamworks/reports/2026-08.csv',
  },
  {
    distributor: 'app_store_connect',
    vertical: 'gaming',
    loginUrl: `${ASTRA_BASE_URL}/app-store-connect/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/app-store-connect/payments`,
    selectors: {
      username: 'input[name="accountName"]',
      password: 'input[name="accountPassword"]',
      submit: '#sign-in',
    },
    statementHrefPattern: '^/app-store-connect/payments/[^"]+\\.csv$',
    fixtureStatementPath: '/app-store-connect/payments/2026-08.csv',
  },
  // --- livestream -------------------------------------------------------------
  {
    distributor: 'twitch',
    vertical: 'livestream',
    loginUrl: `${ASTRA_BASE_URL}/twitch/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/twitch/payouts`,
    selectors: {
      username: '#login-username',
      password: '#login-password',
      submit: 'button[type="submit"]',
    },
    statementHrefPattern: '^/twitch/payouts/[^"]+\\.csv$',
    fixtureStatementPath: '/twitch/payouts/2026-08.csv',
  },
  {
    distributor: 'youtube',
    vertical: 'livestream',
    loginUrl: `${ASTRA_BASE_URL}/youtube/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/youtube/earnings`,
    selectors: {
      username: '#identifierId',
      password: 'input[name="password"]',
      submit: '#button',
    },
    statementHrefPattern: '^/youtube/earnings/[^"]+\\.csv$',
    fixtureStatementPath: '/youtube/earnings/2026-08.csv',
  },
  {
    distributor: 'kick',
    vertical: 'livestream',
    loginUrl: `${ASTRA_BASE_URL}/kick/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/kick/creator-dashboard`,
    selectors: { username: '#email', password: '#password', submit: '#submit-button' },
    statementHrefPattern: '^/kick/earnings/[^"]+\\.csv$',
    fixtureStatementPath: '/kick/earnings/2026-08.csv',
  },
  {
    distributor: 'tiktok_live',
    vertical: 'livestream',
    loginUrl: `${ASTRA_BASE_URL}/tiktok-live/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/tiktok-live/rewards`,
    selectors: { username: '#login_email', password: '#login_password', submit: '#log-in-btn' },
    statementHrefPattern: '^/tiktok-live/gifts/[^"]+\\.csv$',
    fixtureStatementPath: '/tiktok-live/gifts/2026-08.csv',
  },
  {
    distributor: 'streamlabs',
    vertical: 'livestream',
    loginUrl: `${ASTRA_BASE_URL}/streamlabs/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/streamlabs/tip-history`,
    selectors: {
      username: 'input[name="username"]',
      password: 'input[name="password"]',
      submit: '#login-button',
    },
    statementHrefPattern: '^/streamlabs/tips/[^"]+\\.csv$',
    fixtureStatementPath: '/streamlabs/tips/2026-08.csv',
  },
  {
    distributor: 'streamelements',
    vertical: 'livestream',
    loginUrl: `${ASTRA_BASE_URL}/streamelements/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/streamelements/payouts`,
    selectors: { username: '#email-input', password: '#password-input', submit: '.btn-login' },
    statementHrefPattern: '^/streamelements/payouts/[^"]+\\.csv$',
    fixtureStatementPath: '/streamelements/payouts/2026-08.csv',
  },
  // --- publishing ---------------------------------------------------------------
  {
    distributor: 'amazon_kdp',
    vertical: 'publishing',
    loginUrl: `${ASTRA_BASE_URL}/amazon-kdp/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/amazon-kdp/reports`,
    selectors: { username: '#ap_email', password: '#ap_password', submit: '#signInSubmit' },
    statementHrefPattern: '^/amazon-kdp/reports/[^"]+\\.csv$',
    fixtureStatementPath: '/amazon-kdp/reports/2026-08.csv',
  },
  {
    distributor: 'ingramspark',
    vertical: 'publishing',
    loginUrl: `${ASTRA_BASE_URL}/ingramspark/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/ingramspark/compensation`,
    selectors: { username: '#username', password: '#password', submit: 'button[type="submit"]' },
    statementHrefPattern: '^/ingramspark/compensation/[^"]+\\.csv$',
    fixtureStatementPath: '/ingramspark/compensation/2026-08.csv',
  },
  {
    distributor: 'draft2digital',
    vertical: 'publishing',
    loginUrl: `${ASTRA_BASE_URL}/draft2digital/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/draft2digital/earnings`,
    selectors: { username: '#login_email', password: '#login_password', submit: '#login_submit' },
    statementHrefPattern: '^/draft2digital/earnings/[^"]+\\.csv$',
    fixtureStatementPath: '/draft2digital/earnings/2026-08.csv',
  },
  {
    distributor: 'apple_books',
    vertical: 'publishing',
    loginUrl: `${ASTRA_BASE_URL}/apple-books/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/apple-books/payments`,
    selectors: {
      username: 'input[name="accountName"]',
      password: 'input[name="accountPassword"]',
      submit: '#sign-in',
    },
    statementHrefPattern: '^/apple-books/payments/[^"]+\\.csv$',
    fixtureStatementPath: '/apple-books/payments/2026-08.csv',
  },
  {
    distributor: 'kobo',
    vertical: 'publishing',
    loginUrl: `${ASTRA_BASE_URL}/kobo/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/kobo/royalties`,
    selectors: { username: '#userId', password: '#password', submit: '#login' },
    statementHrefPattern: '^/kobo/royalty-payments/[^"]+\\.csv$',
    fixtureStatementPath: '/kobo/royalty-payments/2026-08.csv',
  },
  {
    distributor: 'substack',
    vertical: 'publishing',
    loginUrl: `${ASTRA_BASE_URL}/substack/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/substack/earnings`,
    selectors: {
      username: 'input[name="email"]',
      password: 'input[name="password"]',
      submit: '.button.primary',
    },
    statementHrefPattern: '^/substack/earnings/[^"]+\\.csv$',
    fixtureStatementPath: '/substack/earnings/2026-08.csv',
  },
  {
    distributor: 'zinio',
    vertical: 'publishing',
    loginUrl: `${ASTRA_BASE_URL}/zinio/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/zinio/publisher-reports`,
    selectors: { username: '#partner-id', password: '#partner-pass', submit: '#go' },
    statementHrefPattern: '^/zinio/sales-reports/[^"]+\\.csv$',
    fixtureStatementPath: '/zinio/sales-reports/2026-08.csv',
  },
  {
    distributor: 'webtoon',
    vertical: 'publishing',
    loginUrl: `${ASTRA_BASE_URL}/webtoon/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/webtoon/creator-studio`,
    selectors: { username: '#email', password: '#pwd', submit: '.login-btn' },
    statementHrefPattern: '^/webtoon/payouts/[^"]+\\.csv$',
    fixtureStatementPath: '/webtoon/payouts/2026-08.csv',
  },
  {
    distributor: 'tapas',
    vertical: 'publishing',
    loginUrl: `${ASTRA_BASE_URL}/tapas/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/tapas/creator-dashboard`,
    selectors: {
      username: 'input[name="user[email]"]',
      password: 'input[name="user[password]"]',
      submit: 'input[type="submit"]',
    },
    statementHrefPattern: '^/tapas/ink-payments/[^"]+\\.csv$',
    fixtureStatementPath: '/tapas/ink-payments/2026-08.csv',
  },
  {
    distributor: 'kakaopage',
    vertical: 'publishing',
    loginUrl: `${ASTRA_BASE_URL}/kakaopage/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/kakaopage/settlements`,
    selectors: {
      username: '#id_email_input',
      password: '#id_password_input',
      submit: '.btn-submit',
    },
    statementHrefPattern: '^/kakaopage/settlements/[^"]+\\.csv$',
    fixtureStatementPath: '/kakaopage/settlements/2026-08.csv',
  },
  {
    distributor: 'patreon',
    vertical: 'publishing',
    loginUrl: `${ASTRA_BASE_URL}/patreon/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/patreon/creator-hub`,
    selectors: { username: '#email', password: '#password', submit: '.login-button' },
    statementHrefPattern: '^/patreon/payouts/[^"]+\\.csv$',
    fixtureStatementPath: '/patreon/payouts/2026-08.csv',
  },
  // --- merchandise ---------------------------------------------------------------
  {
    distributor: 'shopify',
    vertical: 'merchandise',
    loginUrl: `${ASTRA_BASE_URL}/shopify/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/shopify/admin`,
    selectors: {
      username: '#account_login',
      password: '#account_password',
      submit: '.btn.btn-primary',
    },
    statementHrefPattern: '^/shopify/payouts/[^"]+\\.csv$',
    fixtureStatementPath: '/shopify/payouts/2026-08.csv',
  },
  {
    distributor: 'printful',
    vertical: 'merchandise',
    loginUrl: `${ASTRA_BASE_URL}/printful/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/printful/billing`,
    selectors: { username: '#email', password: '#password', submit: 'button[type="submit"]' },
    statementHrefPattern: '^/printful/payout-reports/[^"]+\\.csv$',
    fixtureStatementPath: '/printful/payout-reports/2026-08.csv',
  },
  {
    distributor: 'gelato',
    vertical: 'merchandise',
    loginUrl: `${ASTRA_BASE_URL}/gelato/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/gelato/earnings`,
    selectors: { username: '#loginEmail', password: '#loginPassword', submit: '#loginBtn' },
    statementHrefPattern: '^/gelato/earnings/[^"]+\\.csv$',
    fixtureStatementPath: '/gelato/earnings/2026-08.csv',
  },
  {
    distributor: 'square_pos',
    vertical: 'merchandise',
    loginUrl: `${ASTRA_BASE_URL}/square-pos/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/square-pos/deposits`,
    selectors: {
      username: 'input[name="email"]',
      password: 'input[name="password"]',
      submit: '.button-primary',
    },
    statementHrefPattern: '^/square-pos/deposits/[^"]+\\.csv$',
    fixtureStatementPath: '/square-pos/deposits/2026-08.csv',
  },
  // --- AI platforms ---------------------------------------------------------------
  {
    distributor: 'hugging_face',
    vertical: 'ai_platforms',
    loginUrl: `${ASTRA_BASE_URL}/hugging-face/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/hugging-face/billing`,
    selectors: { username: '#username', password: '#password', submit: '.btn-primary' },
    statementHrefPattern: '^/hugging-face/inference-usage/[^"]+\\.csv$',
    fixtureStatementPath: '/hugging-face/inference-usage/2026-08.csv',
  },
  {
    distributor: 'elevenlabs',
    vertical: 'ai_platforms',
    loginUrl: `${ASTRA_BASE_URL}/elevenlabs/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/elevenlabs/usage`,
    selectors: { username: '#email', password: '#password', submit: '#submit' },
    statementHrefPattern: '^/elevenlabs/voice-usage/[^"]+\\.csv$',
    fixtureStatementPath: '/elevenlabs/voice-usage/2026-08.csv',
  },
  {
    distributor: 'weights_biases',
    vertical: 'ai_platforms',
    loginUrl: `${ASTRA_BASE_URL}/weights-biases/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/weights-biases/usage`,
    selectors: {
      username: 'input[name="username"]',
      password: 'input[name="password"]',
      submit: 'button[type="submit"]',
    },
    statementHrefPattern: '^/weights-biases/telemetry-usage/[^"]+\\.csv$',
    fixtureStatementPath: '/weights-biases/telemetry-usage/2026-08.csv',
  },
  {
    distributor: 'openai',
    vertical: 'ai_platforms',
    loginUrl: `${ASTRA_BASE_URL}/openai/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/openai/billing`,
    selectors: { username: '#email-input', password: '#password-input', submit: '.submit-button' },
    statementHrefPattern: '^/openai/usage-logs/[^"]+\\.csv$',
    fixtureStatementPath: '/openai/usage-logs/2026-08.csv',
  },
  // --- art market -------------------------------------------------------------------
  {
    distributor: 'gallery_portal',
    vertical: 'art_market',
    loginUrl: `${ASTRA_BASE_URL}/gallery-portal/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/gallery-portal/invoices`,
    selectors: { username: '#gallery-id', password: '#gallery-pass', submit: '#login-submit' },
    statementHrefPattern: '^/gallery-portal/invoices/[^"]+\\.csv$',
    fixtureStatementPath: '/gallery-portal/invoices/2026-08.csv',
  },
  {
    distributor: 'auction_house',
    vertical: 'art_market',
    loginUrl: `${ASTRA_BASE_URL}/auction-house/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/auction-house/resale-reports`,
    selectors: { username: '#client-number', password: '#client-pin', submit: '.btn-signin' },
    statementHrefPattern: '^/auction-house/resale/[^"]+\\.csv$',
    fixtureStatementPath: '/auction-house/resale/2026-08.csv',
  },
  {
    distributor: 'print_shop',
    vertical: 'art_market',
    loginUrl: `${ASTRA_BASE_URL}/print-shop/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/print-shop/sales`,
    selectors: {
      username: 'input[name="login"]',
      password: 'input[name="key"]',
      submit: '#submit-login',
    },
    statementHrefPattern: '^/print-shop/sales/[^"]+\\.csv$',
    fixtureStatementPath: '/print-shop/sales/2026-08.csv',
  },
  {
    distributor: 'museum_licensing',
    vertical: 'art_market',
    loginUrl: `${ASTRA_BASE_URL}/museum-licensing/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/museum-licensing/rights-statements`,
    selectors: {
      username: '#institution-id',
      password: '#institution-secret',
      submit: '#access',
    },
    statementHrefPattern: '^/museum-licensing/statements/[^"]+\\.csv$',
    fixtureStatementPath: '/museum-licensing/statements/2026-08.csv',
  },
  // --- live events ---------------------------------------------------------------------
  {
    distributor: 'axs',
    vertical: 'live_events',
    loginUrl: `${ASTRA_BASE_URL}/axs/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/axs/settlements`,
    selectors: {
      username: 'input[name="email"]',
      password: 'input[name="password"]',
      submit: '#loginButton',
    },
    statementHrefPattern: '^/axs/settlements/[^"]+\\.csv$',
    fixtureStatementPath: '/axs/settlements/2026-08.csv',
  },
  {
    distributor: 'ticketmaster',
    vertical: 'live_events',
    loginUrl: `${ASTRA_BASE_URL}/ticketmaster/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/ticketmaster/account-center`,
    selectors: { username: '#username', password: '#password', submit: '.login-submit' },
    statementHrefPattern: '^/ticketmaster/settlements/[^"]+\\.csv$',
    fixtureStatementPath: '/ticketmaster/settlements/2026-08.csv',
  },
  {
    distributor: 'eventbrite',
    vertical: 'live_events',
    loginUrl: `${ASTRA_BASE_URL}/eventbrite/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/eventbrite/payouts`,
    selectors: {
      username: 'input[name="identifier"]',
      password: 'input[name="password"]',
      submit: 'button[type="submit"]',
    },
    statementHrefPattern: '^/eventbrite/payouts/[^"]+\\.csv$',
    fixtureStatementPath: '/eventbrite/payouts/2026-08.csv',
  },
  {
    distributor: 'venuepos',
    vertical: 'live_events',
    loginUrl: `${ASTRA_BASE_URL}/venuepos/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/venuepos/box-office`,
    selectors: { username: '#venue-login', password: '#venue-pass', submit: '.pos-submit' },
    statementHrefPattern: '^/venuepos/settlements/[^"]+\\.csv$',
    fixtureStatementPath: '/venuepos/settlements/2026-08.csv',
  },
  // --- brand licensing -------------------------------------------------------------------
  {
    distributor: 'licensee_portal',
    vertical: 'brand_licensing',
    loginUrl: `${ASTRA_BASE_URL}/licensee-portal/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/licensee-portal/sell-through`,
    selectors: {
      username: '#licensee-code',
      password: '#licensee-key',
      submit: '#portal-enter',
    },
    statementHrefPattern: '^/licensee-portal/sell-through/[^"]+\\.csv$',
    fixtureStatementPath: '/licensee-portal/sell-through/2026-08.csv',
  },
  // --- NIL athletics ----------------------------------------------------------------------
  {
    distributor: 'nil_collective',
    vertical: 'nil_athletics',
    loginUrl: `${ASTRA_BASE_URL}/nil-collective/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/nil-collective/deal-portal`,
    selectors: { username: '#athlete-email', password: '#athlete-pass', submit: '.btn-login' },
    statementHrefPattern: '^/nil-collective/disclosures/[^"]+\\.csv$',
    fixtureStatementPath: '/nil-collective/disclosures/2026-08.csv',
  },
  // --- spatial ------------------------------------------------------------------------------
  {
    distributor: 'rfid_telemetry',
    vertical: 'spatial',
    loginUrl: `${ASTRA_BASE_URL}/rfid-telemetry/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/rfid-telemetry/turnstile-feeds`,
    selectors: { username: '#operator-id', password: '#operator-pass', submit: '#connect' },
    statementHrefPattern: '^/rfid-telemetry/scans/[^"]+\\.csv$',
    fixtureStatementPath: '/rfid-telemetry/scans/2026-08.csv',
  },
  // --- fitness ---------------------------------------------------------------------------------
  {
    distributor: 'mindbody',
    vertical: 'fitness',
    loginUrl: `${ASTRA_BASE_URL}/mindbody/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/mindbody/check-ins`,
    selectors: {
      username: 'input[name="username"]',
      password: 'input[name="password"]',
      submit: '#btnLogin',
    },
    statementHrefPattern: '^/mindbody/billing/[^"]+\\.csv$',
    fixtureStatementPath: '/mindbody/billing/2026-08.csv',
  },
  {
    distributor: 'peloton',
    vertical: 'fitness',
    loginUrl: `${ASTRA_BASE_URL}/peloton/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/peloton/creator-metrics`,
    selectors: { username: '#email', password: '#password', submit: '.login-form__submit' },
    statementHrefPattern: '^/peloton/music-usage/[^"]+\\.csv$',
    fixtureStatementPath: '/peloton/music-usage/2026-08.csv',
  },
  {
    distributor: 'ifit',
    vertical: 'fitness',
    loginUrl: `${ASTRA_BASE_URL}/ifit/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/ifit/subscription-billing`,
    selectors: { username: '#login_email', password: '#login_password', submit: '#login_btn' },
    statementHrefPattern: '^/ifit/billing/[^"]+\\.csv$',
    fixtureStatementPath: '/ifit/billing/2026-08.csv',
  },
  // --- culinary ghost kitchens --------------------------------------------------------------------
  {
    distributor: 'doordash',
    vertical: 'culinary',
    loginUrl: `${ASTRA_BASE_URL}/doordash/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/doordash/order-feeds`,
    selectors: {
      username: '#login-email',
      password: '#login-password',
      submit: 'button[type="submit"]',
    },
    statementHrefPattern: '^/doordash/orders/[^"]+\\.csv$',
    fixtureStatementPath: '/doordash/orders/2026-08.csv',
  },
  {
    distributor: 'ubereats',
    vertical: 'culinary',
    loginUrl: `${ASTRA_BASE_URL}/ubereats/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/ubereats/payouts`,
    selectors: { username: '#userid', password: '#password', submit: '#login-submit' },
    statementHrefPattern: '^/ubereats/payouts/[^"]+\\.csv$',
    fixtureStatementPath: '/ubereats/payouts/2026-08.csv',
  },
  {
    distributor: 'grubhub',
    vertical: 'culinary',
    loginUrl: `${ASTRA_BASE_URL}/grubhub/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/grubhub/financials`,
    selectors: {
      username: 'input[name="email"]',
      password: 'input[name="password"]',
      submit: '#login-btn',
    },
    statementHrefPattern: '^/grubhub/order-feeds/[^"]+\\.csv$',
    fixtureStatementPath: '/grubhub/order-feeds/2026-08.csv',
  },
  {
    distributor: 'toast_pos',
    vertical: 'culinary',
    loginUrl: `${ASTRA_BASE_URL}/toast-pos/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/toast-pos/ticket-streams`,
    selectors: { username: '#toast-user', password: '#toast-pass', submit: '.toast-submit' },
    statementHrefPattern: '^/toast-pos/tickets/[^"]+\\.csv$',
    fixtureStatementPath: '/toast-pos/tickets/2026-08.csv',
  },
  // --- salon, med-spa, and hospitality ---------------------------------------------------------------
  {
    distributor: 'boulevard',
    vertical: 'salon_hospitality',
    loginUrl: `${ASTRA_BASE_URL}/boulevard/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/boulevard/billing`,
    selectors: { username: '#email', password: '#password', submit: 'button[type="submit"]' },
    statementHrefPattern: '^/boulevard/invoices/[^"]+\\.csv$',
    fixtureStatementPath: '/boulevard/invoices/2026-08.csv',
  },
  {
    distributor: 'zenoti',
    vertical: 'salon_hospitality',
    loginUrl: `${ASTRA_BASE_URL}/zenoti/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/zenoti/billing-logs`,
    selectors: {
      username: '#userName-input',
      password: '#password-input',
      submit: '.btn-primary',
    },
    statementHrefPattern: '^/zenoti/membership-billing/[^"]+\\.csv$',
    fixtureStatementPath: '/zenoti/membership-billing/2026-08.csv',
  },
  // --- developer tools ----------------------------------------------------------------------------------
  {
    distributor: 'kong',
    vertical: 'developer_tools',
    loginUrl: `${ASTRA_BASE_URL}/kong/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/kong/usage`,
    selectors: {
      username: 'input[name="email"]',
      password: 'input[name="password"]',
      submit: 'button[type="submit"]',
    },
    statementHrefPattern: '^/kong/gateway-usage/[^"]+\\.csv$',
    fixtureStatementPath: '/kong/gateway-usage/2026-08.csv',
  },
  {
    distributor: 'aws_api_gateway',
    vertical: 'developer_tools',
    loginUrl: `${ASTRA_BASE_URL}/aws-api-gateway/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/aws-api-gateway/usage-reports`,
    selectors: { username: '#iam-user', password: '#iam-pass', submit: '#signin_button' },
    statementHrefPattern: '^/aws-api-gateway/usage/[^"]+\\.csv$',
    fixtureStatementPath: '/aws-api-gateway/usage/2026-08.csv',
  },
  {
    distributor: 'cloudflare_workers',
    vertical: 'developer_tools',
    loginUrl: `${ASTRA_BASE_URL}/cloudflare-workers/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/cloudflare-workers/usage`,
    selectors: { username: '#cf-email', password: '#cf-password', submit: '.login-btn' },
    statementHrefPattern: '^/cloudflare-workers/usage/[^"]+\\.csv$',
    fixtureStatementPath: '/cloudflare-workers/usage/2026-08.csv',
  },
  // --- hardware patents --------------------------------------------------------------------------------------
  {
    distributor: 'hardware_activation',
    vertical: 'hardware_patents',
    loginUrl: `${ASTRA_BASE_URL}/hardware-activation/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/hardware-activation/activation-feeds`,
    selectors: { username: '#vendor-id', password: '#vendor-key', submit: '#auth-btn' },
    statementHrefPattern: '^/hardware-activation/feeds/[^"]+\\.csv$',
    fixtureStatementPath: '/hardware-activation/feeds/2026-08.csv',
  },
  // --- energy and resources ----------------------------------------------------------------------------------
  {
    distributor: 'scada_meters',
    vertical: 'energy',
    loginUrl: `${ASTRA_BASE_URL}/scada-meters/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/scada-meters/meter-logs`,
    selectors: {
      username: '#operator-login',
      password: '#operator-password',
      submit: '.scada-submit',
    },
    statementHrefPattern: '^/scada-meters/meter-logs/[^"]+\\.csv$',
    fixtureStatementPath: '/scada-meters/meter-logs/2026-08.csv',
  },
  // --- sports ticketing and athlete rights -----------------------------------------------------------------------
  {
    distributor: 'seatgeek',
    vertical: 'sports_ticketing',
    loginUrl: `${ASTRA_BASE_URL}/seatgeek/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/seatgeek/payouts`,
    selectors: {
      username: 'input[name="username"]',
      password: 'input[name="password"]',
      submit: 'button[type="submit"]',
    },
    statementHrefPattern: '^/seatgeek/payouts/[^"]+\\.csv$',
    fixtureStatementPath: '/seatgeek/payouts/2026-08.csv',
  },
  {
    distributor: 'stubhub',
    vertical: 'sports_ticketing',
    loginUrl: `${ASTRA_BASE_URL}/stubhub/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/stubhub/seller-payments`,
    selectors: { username: '#emailAddress', password: '#password', submit: '#signin-button' },
    statementHrefPattern: '^/stubhub/payments/[^"]+\\.csv$',
    fixtureStatementPath: '/stubhub/payments/2026-08.csv',
  },
  {
    distributor: 'vivid_seats',
    vertical: 'sports_ticketing',
    loginUrl: `${ASTRA_BASE_URL}/vivid-seats/login`,
    dashboardUrl: `${ASTRA_BASE_URL}/vivid-seats/seller-dashboard`,
    selectors: { username: '#login-email', password: '#login-password', submit: '#login-submit' },
    statementHrefPattern: '^/vivid-seats/payouts/[^"]+\\.csv$',
    fixtureStatementPath: '/vivid-seats/payouts/2026-08.csv',
  },
];

/** The registry keyed by distributor — the engine's one lookup. */
const PROFILES_BY_DISTRIBUTOR: ReadonlyMap<DistributorConnectionSource, AstraAdapterProfile> =
  new Map(ASTRA_ADAPTER_PROFILES.map((profile) => [profile.distributor, profile]));

/** The profile for a vault source, or undefined when none is registered. */
export function profileFor(
  distributor: DistributorConnectionSource,
): AstraAdapterProfile | undefined {
  return PROFILES_BY_DISTRIBUTOR.get(distributor);
}

/**
 * Registry drift guard — called by the test suite and by main.ts at boot:
 * every vault source MUST have a profile (the vault never holds
 * credentials for a dashboard the agent cannot traverse) and every
 * registered profile MUST name a vault source (an unconnectable adapter
 * is dead weight that would silently never traverse).
 */
export function assertProfilesMatchVaultSources(): void {
  const registered = ASTRA_ADAPTER_PROFILES.map((profile) => profile.distributor);
  const missing = DISTRIBUTOR_CREDENTIAL_SOURCES.filter(
    (source) => !registered.includes(source),
  );
  const unknown = registered.filter(
    (source) => !DISTRIBUTOR_CREDENTIAL_SOURCES.includes(source),
  );
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `Astra adapter registry drifted from the vault vocabulary: ` +
        `unregistered vault sources [${missing.length > 0 ? missing.join(',') : 'none'}], ` +
        `unknown registered sources [${unknown.length > 0 ? unknown.join(',') : 'none'}]`,
    );
  }
  // A recording its own harvest pattern would skip is a broken recording —
  // the fixtures and the deterministic harvest must agree per profile.
  const brokenRecordings = ASTRA_ADAPTER_PROFILES.filter(
    (profile) => !new RegExp(profile.statementHrefPattern).test(profile.fixtureStatementPath),
  );
  if (brokenRecordings.length > 0) {
    throw new Error(
      `Astra fixtureStatementPath does not match its statementHrefPattern: ` +
        `[${brokenRecordings.map((profile) => profile.distributor).join(',')}]`,
    );
  }
}
