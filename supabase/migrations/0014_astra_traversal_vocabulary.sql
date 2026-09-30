-- ---------------------------------------------------------------------------
-- Migration 0014 — Astra traversal vocabulary (PR 6).
--
-- Extends distributor_connections.distributor from 0013's four launch
-- sources to the full twenty-vertical set: one check entry per dashboard
-- the build brief names, so a rights holder can connect ANY dashboard the
-- Astra extraction agent traverses (music, film, podcast, gaming, AR/VR,
-- livestream, publishing, merchandise, AI platforms, art market, live
-- events, brand licensing, NIL athletics, spatial, fitness, culinary,
-- salon/hospitality, developer tools, hardware patents, energy, sports
-- ticketing). The slugs mirror DISTRIBUTOR_CREDENTIAL_SOURCES in
-- src/modules/vault/records.ts 1:1 — the zod connect validation and the
-- store layer read that constant; a drift-guard test pins the two lists
-- to each other. House lowercase slugs throughout.
--
-- Semantics carried over from 0013 unchanged: the credential columns stay
-- AES-256-GCM ciphertext only, the traversal provenance columns
-- (last_verified_at / last_error) are written by the agent lane (PR 6), a
-- traversal failure never flips status, and ONE ACTIVE row per (holder,
-- distributor) stays the partial unique index's invariant.
--
-- House pattern (0006/0011/0013): idempotent — CI applies it twice; the
-- guarded DO block drops 0013's auto-named check before adding the named
-- wide one, and re-runs cleanly.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'distributor_connections_distributor_check_v14'
  ) THEN
    -- Drop 0013's inline (auto-named) four-source check if it is present.
    ALTER TABLE public.distributor_connections
      DROP CONSTRAINT IF EXISTS distributor_connections_distributor_check;
    ALTER TABLE public.distributor_connections
      ADD CONSTRAINT distributor_connections_distributor_check_v14
      CHECK (distributor IN (
        -- music
        'distrokid', 'tunecore', 'ascap', 'bmi', 'mlc',
        -- film
        'netflix', 'prime_video', 'film_theatrical', 'film_sales_agent',
        -- podcast
        'megaphone', 'libsyn', 'spotify_podcasters', 'acast',
        -- gaming and AR/VR
        'epic_games', 'unity_asset_store', 'roblox', 'steamworks', 'app_store_connect',
        -- livestream
        'twitch', 'youtube', 'kick', 'tiktok_live', 'streamlabs', 'streamelements',
        -- publishing
        'amazon_kdp', 'ingramspark', 'draft2digital', 'apple_books', 'kobo',
        'substack', 'zinio', 'webtoon', 'tapas', 'kakaopage', 'patreon',
        -- merchandise
        'shopify', 'printful', 'gelato', 'square_pos',
        -- AI platforms
        'hugging_face', 'elevenlabs', 'weights_biases', 'openai',
        -- art market
        'gallery_portal', 'auction_house', 'print_shop', 'museum_licensing',
        -- live events
        'axs', 'ticketmaster', 'eventbrite', 'venuepos',
        -- brand licensing
        'licensee_portal',
        -- NIL athletics
        'nil_collective',
        -- spatial
        'rfid_telemetry',
        -- fitness
        'mindbody', 'peloton', 'ifit',
        -- culinary ghost kitchens
        'doordash', 'ubereats', 'grubhub', 'toast_pos',
        -- salon, med-spa, and hospitality
        'boulevard', 'zenoti',
        -- developer tools
        'kong', 'aws_api_gateway', 'cloudflare_workers',
        -- hardware patents
        'hardware_activation',
        -- energy and resources
        'scada_meters',
        -- sports ticketing and athlete rights
        'seatgeek', 'stubhub', 'vivid_seats'
      ));
  END IF;
END $$;

comment on column public.distributor_connections.distributor is
  'The dashboard the credentials unlock — the full twenty-vertical traversal vocabulary of migration 0014 (house lowercase; every entry pairs with an Astra adapter profile and recorded fixtures).';
