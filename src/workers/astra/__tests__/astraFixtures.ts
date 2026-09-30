/**
 * CVT Astra extraction agent — test fixture composer.
 *
 * Builds the FixtureCatalog pieces for any adapter profile from the
 * profile's OWN recorded vocabulary: login controls rendered from the
 * profile's exact selectors (renderControlFor — recordings match profiles
 * by construction), a dashboard page carrying the profile's recorded
 * statement link (plus decoy links its pattern must NOT match), and the
 * statement's raw bytes keyed by the fully-qualified href. Delimited-text
 * content carries representative global identifier codes VERBATIM per
 * vertical — the composer never rewrites a code.
 *
 * `echoCredentials` models a dashboard that renders the logged-in username
 * (and, contrived, a statement contact column): the no-credential-leak
 * test composes with it ON and proves the redaction gate scrubs every
 * persisted surface anyway. Clean captures use the default (off) so the
 * per-distributor byte-verbatim assertions stay exact.
 */

import { ASTRA_BASE_URL } from '../profiles';
import type { AstraAdapterProfile } from '../profiles';
import { renderControlFor } from '../session';
import type { FixtureCatalog, RecordedFixture } from '../session';

/** Per-vertical representative identifier codes — captured verbatim. */
const VERTICAL_STATEMENT_ROWS: Readonly<Record<string, readonly string[]>> = {
  music: [
    'US-S1O-26-00001,T-034.524.680-1,190296734438,November,written,streaming,0.0041',
    'GB-S1O-26-00002,T-034.524.681-2,190296734445,November,written,streaming,0.0038',
  ],
  film: [
    '10.5240/1A2B-3C4D-5E6F-7G8H-9I0J-K,DE,700000,theatrical,12000,0.35',
    '10.5240/2B3C-4D5E-6F7G-8H9I-0J1K-2,FR,250000,svod,8000,0.42',
  ],
  podcast: ['episode-88123,2026-08-31,51000,downloads,cpm,0.018'],
  gaming: ['76561198000000001,USD,412.88,payout_batch,devex,0.30'],
  livestream: ['bits-88213,2026-08-14,1200,USD,solicited,0.70'],
  publishing: ['978-3-16-148410-0,ISBN-13,1240,net_units,royalty,1.25'],
  merchandise: ['PO-88231,SKU-CREW-TEE-XL,140,USD,wholesale,9.50'],
  ai_platforms: ['tok-2026-08-8842,1500000,input_tokens,USD,usage,0.03'],
  art_market: ['lot-221,LO-2026-0114,520000,USD,resale_royalty,0.04'],
  live_events: ['evt-99120,sec-101,row-4,240,USD,settlement,22.00'],
  brand_licensing: ['ml-8820,SKU-EU-2026Q3,980,EUR,sell_through,12.40'],
  nil_athletics: ['disc-2026-091,USD,25000,endorsement,disclosed,25000'],
  spatial: ['node/5102844123,osm-way/91882211,880,scans,rfid,0.0'],
  fitness: ['user-881,cycling,42,2026-08-31,minutes,usage,0.0'],
  culinary: ['order-77219,menu-item-42,3,USD,delivery,18.75'],
  salon_hospitality: ['appt-5512,membership-tier2,180,USD,billing,95.00'],
  developer_tools: ['gw-8821,2026-08-31,90211,requests,USD,usage,0.29'],
  hardware_patents: ['IMEI-490154203237518,EID-98000000000000001,feed-221,activations,1'],
  energy: ['GS1-GSRN-988100000000001,MWH,412.8,meter_read,USD,44.18'],
  sports_ticketing: ['evt-tm-2026-08-221,sec-114,88,USD,secondary,66.50'],
};

/** The vertical's identifier row set (music rows double as the default). */
export function statementRows(vertical: string): readonly string[] {
  return VERTICAL_STATEMENT_ROWS[vertical] ?? VERTICAL_STATEMENT_ROWS.music;
}

/** The vertical's lead identifier code, for byte-verbatim assertions. */
export function leadIdentifierCode(vertical: string): string {
  return statementRows(vertical)[0]!.split(',')[0]!;
}

/** The recorded statement's file name — the profile's own path leaf. */
export function fixtureFileName(profile: AstraAdapterProfile): string {
  return profile.fixtureStatementPath.split('/').pop() ?? profile.fixtureStatementPath;
}

/** The statement's fully-qualified href — the fixture download key. */
export function fixtureStatementUrl(profile: AstraAdapterProfile): string {
  return `${ASTRA_BASE_URL}${profile.fixtureStatementPath}`;
}

/**
 * Compose the profile's delimited statement bytes. With echoCredentials,
 * a contact column renders the username — the leak test's carrier.
 */
export function composeStatementContent(
  profile: AstraAdapterProfile,
  echoCredentials: boolean,
): string {
  const contact = echoCredentials ? 'contact' : 'partner';
  const rows = statementRows(profile.vertical).map((row) => `${row},${contact}`);
  return `report_id,code,value,unit,kind,rate,note,${contact}\n${rows.join('\n')}\n`;
}

/** One composed fixture page pair plus the statement's recorded bytes. */
export interface ComposedProfileFixtures {
  login: RecordedFixture;
  dashboard: RecordedFixture;
  statementUrl: string;
  statementContent: string;
  statementFileName: string;
}

/**
 * Compose the profile's fixture pages. The login page embeds controls for
 * the profile's EXACT selectors; the dashboard embeds the recorded
 * statement link plus decoys the harvest must skip, and (with
 * echoCredentials) renders the username the way real dashboards do.
 */
export function composeProfileFixtures(
  profile: AstraAdapterProfile,
  credentials: { username: string; password: string },
  echoCredentials: boolean = false,
): ComposedProfileFixtures {
  const loginHtml = [
    '<html><body><form>',
    renderControlFor(profile.selectors.username, {
      name: 'username',
      placeholder: 'username',
    }),
    renderControlFor(profile.selectors.password, {
      name: 'password',
      type: 'password',
    }),
    renderControlFor(profile.selectors.submit),
    '</form></body></html>',
  ].join('');

  const echo = echoCredentials
    ? `<span class="account-email">${credentials.username}</span>`
    : '<span class="account-email">account-owner</span>';
  const dashboardHtml = [
    '<html><body>',
    echo,
    `<a href="${profile.fixtureStatementPath}">August statement</a>`,
    '<a href="/inbox/messages">Inbox</a>',
    '<a href="/settings/billing">Billing settings</a>',
    '</body></html>',
  ].join('');

  return {
    login: { url: profile.loginUrl, html: loginHtml },
    dashboard: { url: profile.dashboardUrl, html: dashboardHtml },
    statementUrl: fixtureStatementUrl(profile),
    statementContent: composeStatementContent(profile, echoCredentials),
    statementFileName: fixtureFileName(profile),
  };
}

/** The full catalog for a set of profiles — what a fixture sweep drives. */
export function composeFixtureCatalog(
  profiles: readonly AstraAdapterProfile[],
  credentials: { username: string; password: string },
  echoCredentials: boolean = false,
): FixtureCatalog {
  const pages: RecordedFixture[] = [];
  const downloads = new Map<string, string>();
  for (const profile of profiles) {
    const composed = composeProfileFixtures(profile, credentials, echoCredentials);
    pages.push(composed.login, composed.dashboard);
    downloads.set(composed.statementUrl, composed.statementContent);
  }
  return { pages, downloads };
}
