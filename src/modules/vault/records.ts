/**
 * The UCT credential vault — record vocabulary for distributor_connections
 * (migration 0013, PR 5). snake_case fields match the database columns 1:1
 * (the Store seam convention — records are the rows). Types are re-exported
 * through the Store seam (src/lib/server/store.ts); the connect/status/
 * disconnect routes consume them and never touch store files.
 *
 * The secrecy contract, in one place: a DistributorConnectionRecord carries
 * ciphertext (`username_encrypted` / `password_encrypted`) because records
 * are rows — but a record is NEVER a response. The only row-to-response
 * path is `toConnectionStatus`, which projects the credential-free public
 * shape; the routes may serialize THAT and nothing else.
 */

/**
 * The twenty industry verticals the Astra agent traverses — the platform's
 * "more than twenty industry verticals" breadth, one entry per vertical.
 * Every vault source belongs to exactly one; the traversal records carry
 * the vertical for audit grouping and the registry drift-guard pins total
 * coverage (every vertical has at least one traversable dashboard).
 */
export const ASTRA_VERTICALS = [
  'music',
  'film',
  'podcast',
  'gaming',
  'livestream',
  'publishing',
  'merchandise',
  'ai_platforms',
  'art_market',
  'live_events',
  'brand_licensing',
  'nil_athletics',
  'spatial',
  'fitness',
  'culinary',
  'salon_hospitality',
  'developer_tools',
  'hardware_patents',
  'energy',
  'sports_ticketing',
] as const;

export type AstraVertical = (typeof ASTRA_VERTICALS)[number];

/**
 * The distributor dashboards the Astra agent traverses (migration 0014's
 * check constraint — extended from 0013's four launch sources to the full
 * twenty-vertical set, one entry per dashboard the build brief names).
 * House lowercase slugs; a source joins only WITH a traversal adapter
 * profile (src/workers/astra/profiles.ts) and its recorded fixtures — the
 * registry drift-guard test enforces the pairing, so the vault never holds
 * credentials for a dashboard the agent cannot traverse.
 */
export const DISTRIBUTOR_CREDENTIAL_SOURCES = [
  // music
  'distrokid',
  'tunecore',
  'ascap',
  'bmi',
  'mlc',
  // film
  'netflix',
  'prime_video',
  'film_theatrical',
  'film_sales_agent',
  // podcast
  'megaphone',
  'libsyn',
  'spotify_podcasters',
  'acast',
  // gaming and AR/VR
  'epic_games',
  'unity_asset_store',
  'roblox',
  'steamworks',
  'app_store_connect',
  // livestream
  'twitch',
  'youtube',
  'kick',
  'tiktok_live',
  'streamlabs',
  'streamelements',
  // publishing
  'amazon_kdp',
  'ingramspark',
  'draft2digital',
  'apple_books',
  'kobo',
  'substack',
  'zinio',
  'webtoon',
  'tapas',
  'kakaopage',
  'patreon',
  // merchandise
  'shopify',
  'printful',
  'gelato',
  'square_pos',
  // AI platforms
  'hugging_face',
  'elevenlabs',
  'weights_biases',
  'openai',
  // art market
  'gallery_portal',
  'auction_house',
  'print_shop',
  'museum_licensing',
  // live events
  'axs',
  'ticketmaster',
  'eventbrite',
  'venuepos',
  // brand licensing
  'licensee_portal',
  // NIL athletics
  'nil_collective',
  // spatial
  'rfid_telemetry',
  // fitness
  'mindbody',
  'peloton',
  'ifit',
  // culinary ghost kitchens
  'doordash',
  'ubereats',
  'grubhub',
  'toast_pos',
  // salon, med-spa, and hospitality
  'boulevard',
  'zenoti',
  // developer tools
  'kong',
  'aws_api_gateway',
  'cloudflare_workers',
  // hardware patents
  'hardware_activation',
  // energy and resources
  'scada_meters',
  // sports ticketing and athlete rights
  'seatgeek',
  'stubhub',
  'vivid_seats',
] as const;

export type DistributorConnectionSource = (typeof DISTRIBUTOR_CREDENTIAL_SOURCES)[number];

/** Connection lifecycle (migration 0013 check constraint). */
export type DistributorConnectionState = 'connected' | 'disconnected';

/**
 * Input for Store.createDistributorConnection — the connect route's one
 * store call. The ciphertexts are ALREADY applied (the route encrypts
 * app-side before the store boundary, the Plaid token precedent); the
 * store persists them verbatim and never sees plaintext.
 */
export interface DistributorConnectionInput {
  /** The verified session's payee key — the row's scope and its only owner. */
  holder_id: string;
  distributor: DistributorConnectionSource;
  username_encrypted: string;
  password_encrypted: string;
}

/**
 * One durable vault row. `username_encrypted` / `password_encrypted` are
 * AES-256-GCM ciphertext (`enc:v1:...`, src/modules/vault/crypto.ts) —
 * for rows and the Astra agent only, never for responses.
 */
export interface DistributorConnectionRecord {
  id: string;
  holder_id: string;
  distributor: DistributorConnectionSource;
  status: DistributorConnectionState;
  username_encrypted: string;
  password_encrypted: string;
  /** Astra traversal provenance (PR 6); null = never traversed. */
  last_verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The Astra traversal's provenance write (PR 6): a successful traversal
 * verifies the dashboard (sets last_verified_at, clears last_error), a
 * failed one records the honest reason (sets last_error) and never touches
 * last_verified_at — only successful traversals verify. A traversal failure
 * NEVER changes connection status; disconnect is the holder's explicit act
 * (migration 0013's column comments).
 */
export type DistributorTraversalOutcome = { verifiedAt: string } | { error: string };

/**
 * One connection's decrypted credentials — the Astra agent's in-memory
 * working set (PR 6). Exists for exactly one traversal: decrypted from the
 * row's ciphertexts at traversal start, handed ONLY to the session's fill
 * seam, never persisted, never logged, never serialized. The ciphertext
 * fields ride along so the redaction gate can scrub a leaked ciphertext
 * (a ciphertext plus the service-role key would be a decrypt oracle).
 */
export interface DecryptedDistributorCredentials {
  distributor: DistributorConnectionSource;
  username: string;
  password: string;
  encryptedUsername: string;
  encryptedPassword: string;
}

/**
 * The create call's outcome — the store KNOWS whether it rotated an
 * existing active row or inserted a fresh one, and surfaces that as data
 * instead of making callers infer it from timestamp equality (two calls in
 * the same millisecond would be indistinguishable).
 */
export interface DistributorConnectionUpsert {
  connection: DistributorConnectionRecord;
  /** true = an existing ACTIVE row's ciphertexts were rotated in place. */
  rotated: boolean;
}

/**
 * The credential-free projection every response serializes. A new field
 * joins this shape only after proving it is neither a credential nor
 * credential material (ciphertext included — the response surface leaks
 * nothing an offline brute-force could start from).
 */
export interface ConnectionPublicStatus {
  id: string;
  distributor: DistributorConnectionSource;
  status: DistributorConnectionState;
  created_at: string;
  updated_at: string;
}

/** The ONLY row-to-response path — projects away both ciphertexts. */
export function toConnectionStatus(record: DistributorConnectionRecord): ConnectionPublicStatus {
  return {
    id: record.id,
    distributor: record.distributor,
    status: record.status,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}
