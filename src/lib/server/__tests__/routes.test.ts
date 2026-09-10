import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as calculatePost } from "@/app/api/v1/splits/calculate/route";
import { POST as reversePost } from "@/app/api/v1/splits/reverse/route";
import { POST as recoupmentPost } from "@/app/api/v1/splits/recoupment/route";
import { POST as disputeLockPost } from "@/app/api/v1/vaults/dispute/lock/route";
import { POST as payoutPost } from "@/app/api/v1/vaults/payout/route";
import { GET as vaultsGet, POST as vaultReleasePost } from "@/app/api/v1/vaults/route";
import { POST as dspWebhookPost } from "@/app/api/v1/webhooks/dsp/route";
import { POST as baasWebhookPost } from "@/app/api/v1/webhooks/baas/route";
import { POST as withholdingPost, GET as withholdingGet } from "@/app/api/v1/compliance/withholding/route";
import { POST as achPost } from "@/app/api/v1/baas/ach/route";
import { POST as rtpPost } from "@/app/api/v1/baas/rtp/route";
import { POST as kycPost } from "@/app/api/v1/auth/plaid-kyc/route";
import { POST as exchangePost } from "@/app/api/v1/auth/plaid-exchange/route";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import { setStore } from "@/lib/server/store";
import {
  seedBaasTransfer,
  seedPayoutHold,
  seedVault,
} from "@/modules/don/__tests__/fixtures";
import { COMPANY_VARIANCE_PAYEE_ID } from "@/modules/don/constants";
import type { CreatorTaxProfile } from "@/modules/don/records";

/**
 * Route battery: every Don endpoint through its Next.js handler with the
 * InMemoryStore swapped in via setStore() (spec criteria 1-9 at the HTTP
 * boundary: envelopes, status codes, rate limiting, sandbox rails).
 */

const NOW = new Date("2026-09-10T12:00:00.000Z");

function post(path: string, body: unknown, ip = "10.0.0.1"): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
  });
}

function get(path: string, ip = "10.0.0.1"): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { "x-forwarded-for": ip },
  });
}

async function seed(store: InMemoryStore): Promise<void> {
  await seedVault(store, "creator_1", 5_000, 0, 0, "Creator One");
  await seedVault(store, COMPANY_VARIANCE_PAYEE_ID, 0, 0, 0, "Don Engine Variance");
  const profile: CreatorTaxProfile = {
    creator_id: "creator_1",
    tin_verified: 1,
    w9_on_file: 1,
    updated_at: NOW.toISOString(),
  };
  await store.upsertCreatorTaxProfile(profile);
}

const royaltyPayload = {
  source: "spotify",
  period: "2026-08",
  currency: "USD",
  settle: false,
  rail: "ach" as const,
  line_items: [
    {
      work_id: "work_1",
      work_title: "One Work",
      amount_cents: 10_000,
      splits: [
        { payee_id: "creator_1", payee_name: "Creator One", role: "creator" as const, share_bps: 9500 },
        { payee_id: "platform", payee_name: "Don Engine Variance", role: "other" as const, share_bps: 500 },
      ],
    },
  ],
};

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
  setStore(store);
});

afterEach(() => {
  delete process.env.BAAS_MODE;
  setStore(null);
});

describe("POST /api/v1/splits/calculate", () => {
  it("returns 201 with the split run and routes the bps shares", async () => {
    await seed(store);
    const response = await calculatePost(post("/api/v1/splits/calculate", royaltyPayload));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.zero_balance).toBe(true);
    const creator = await store.getVault("creator_1");
    expect(creator?.pending_balance).toBe(9_500);
  });

  it("422s shares that do not sum to 10000 bps", async () => {
    await seed(store);
    const response = await calculatePost(post("/api/v1/splits/calculate", {
      ...royaltyPayload,
      line_items: [
        {
          work_id: "work_1",
          work_title: "One Work",
          amount_cents: 10_000,
          splits: [
            { payee_id: "creator_1", payee_name: "Creator One", role: "creator", share_bps: 9500 },
          ],
        },
      ],
    }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.code).toBe("splits_do_not_balance");
  });

  it("400s malformed JSON", async () => {
    await seed(store);
    const request = new NextRequest("http://localhost/api/v1/splits/calculate", {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.2" },
    });
    const response = await calculatePost(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe("malformed_body");
  });

  it("429s past DON_API_RATE_LIMIT for the same identity", async () => {
    await seed(store);
    let last = 0;
    for (let index = 0; index < 31; index += 1) {
      const response = await calculatePost(
        post("/api/v1/splits/calculate", royaltyPayload, "10.9.9.9"),
      );
      last = response.status;
    }
    expect(last).toBe(429);
  });
});

describe("POST /api/v1/webhooks/dsp", () => {
  it("ingests a royalty report and replays idempotently", async () => {
    await seed(store);
    const payload = {
      event: "royalty.report",
      event_id: "evt_dsp_route_1",
      ...royaltyPayload,
    };
    const first = await dspWebhookPost(post("/api/v1/webhooks/dsp", payload));
    expect(first.ok).toBe(true);
    const replay = await dspWebhookPost(post("/api/v1/webhooks/dsp", payload));
    expect(replay.ok).toBe(true);
    const firstBody = await first.json();
    const replayBody = await replay.json();
    expect(firstBody.idempotent).toBe(false);
    expect(replayBody.idempotent).toBe(true);
    // The replay caused no second financial effect.
    const creator = await store.getVault("creator_1");
    expect(creator?.pending_balance).toBe(9_500);
  });

  it("422s an unknown DSP event", async () => {
    await seed(store);
    const response = await dspWebhookPost(
      post("/api/v1/webhooks/dsp", { event: "royalty.exploded" }),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.code).toBe("invalid_webhook_event");
  });
});

describe("POST /api/v1/webhooks/baas", () => {
  it("settles a payout through the webhook", async () => {
    await seed(store);
    await store.upsertVault({
      payee_id: "creator_1",
      payee_name: "Creator One",
      available_balance: 0,
      pending_balance: 1_000,
      reserve_balance: 0,
      updated_at: NOW.toISOString(),
    });
    const transfer = await seedBaasTransfer(store, "creator_1", {
      status: "submitted",
      amount_cents: 1_000,
    });
    await seedPayoutHold(store, transfer.id, "creator_1", 1_000, "in_flight");

    const response = await baasWebhookPost(
      post("/api/v1/webhooks/baas", {
        event: "payout.settled",
        transfer_id: transfer.id,
        event_id: "evt_baas_route_1",
      }),
    );
    expect(response.ok).toBe(true);
    const vault = await store.getVault("creator_1");
    expect(vault?.pending_balance).toBe(0);
  });
});

describe("POST /api/v1/splits/recoupment", () => {
  it("upserts a recoupment advance", async () => {
    await seed(store);
    const response = await recoupmentPost(
      post("/api/v1/splits/recoupment", {
        creator_id: "creator_1",
        creator_name: "Creator One",
        recoupment_target_cents: 2_000,
        recoupment_bps: 5_000,
      }),
    );
    expect(response.ok).toBe(true);
    const body = await response.json();
    // The route returns the advance record directly (201).
    expect(body.creator_id).toBe("creator_1");
    expect(body.recoupment_target_cents).toBe(2_000);
    expect(body.recoupment_bps).toBe(5_000);
  });
});

describe("POST /api/v1/vaults/dispute/lock", () => {
  it("locks a payee and routes their incoming royalty to reserve", async () => {
    await seed(store);
    const lock = await disputeLockPost(
      post("/api/v1/vaults/dispute/lock", { payee_id: "creator_1", locked: true }),
    );
    expect(lock.ok).toBe(true);

    const split = await calculatePost(post("/api/v1/splits/calculate", royaltyPayload, "10.0.0.7"));
    expect(split.ok).toBe(true);
    const creator = await store.getVault("creator_1");
    // The lock froze the 5,000 seeded available into reserve, and the new
    // 9,500 runs to reserve while the dispute is open.
    expect(creator?.reserve_balance).toBe(14_500);
    expect(creator?.available_balance).toBe(0);
  });
});

describe("POST /api/v1/splits/reverse", () => {
  it("reverses an existing split run", async () => {
    await seed(store);
    const created = await calculatePost(post("/api/v1/splits/calculate", royaltyPayload, "10.0.0.8"));
    const runBody = await created.json();
    const response = await reversePost(
      post("/api/v1/splits/reverse", { split_run_id: runBody.split_run.id }),
    );
    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(body.idempotent).toBe(false);
    const creator = await store.getVault("creator_1");
    expect(creator?.pending_balance).toBe(0);
  });
});

describe("/api/v1/compliance/withholding", () => {
  it("POST applies withholding and GET reads the snapshot", async () => {
    // Fresh store, no tax profile → unverified → 24% withheld to reserve.
    await seedVault(store, "creator_1", 0, 0, 0, "Creator One");
    const applied = await withholdingPost(
      post("/api/v1/compliance/withholding", {
        creator_id: "creator_1",
        gross_cents: 10_000,
        tax_year: 2026,
      }),
    );
    expect(applied.ok).toBe(true);
    const appliedBody = await applied.json();
    expect(appliedBody.escrow.withheld_cents).toBe(2_400);
    // The standalone withholding route records the escrow row and YTD only —
    // vault reserve crediting is the UDR split flow's job.
    const creator = await store.getVault("creator_1");
    expect(creator?.reserve_balance).toBe(0);

    const snapshot = await withholdingGet(
      get("/api/v1/compliance/withholding?creator_id=creator_1&tax_year=2026"),
    );
    expect(snapshot.ok).toBe(true);
    const snapshotBody = await snapshot.json();
    const payload = snapshotBody.snapshot ?? snapshotBody;
    expect(payload.creator_id).toBe("creator_1");
    expect(payload.ytd_gross_cents).toBe(10_000);
    expect(payload.ytd_withheld_cents).toBe(2_400);
  });
});

describe("/api/v1/vaults", () => {
  it("GET lists vaults and POST release moves pending to available", async () => {
    await seed(store);
    await store.upsertVault({
      payee_id: "creator_1",
      payee_name: "Creator One",
      available_balance: 0,
      pending_balance: 5_000,
      reserve_balance: 0,
      updated_at: NOW.toISOString(),
    });
    const list = await vaultsGet(get("/api/v1/vaults"));
    expect(list.ok).toBe(true);
    const listBody = await list.json();
    const vaults = Array.isArray(listBody) ? listBody : listBody.vaults;
    expect(vaults.map((v: { payee_id: string }) => v.payee_id)).toContain("creator_1");

    const released = await vaultReleasePost(
      post("/api/v1/vaults", { action: "release", payee_id: "creator_1", amount_cents: 2_000 }),
    );
    expect(released.ok).toBe(true);
    const creator = await store.getVault("creator_1");
    expect(creator?.available_balance).toBe(2_000);
    expect(creator?.pending_balance).toBe(3_000);
  });
});

describe("POST /api/v1/vaults/payout", () => {
  it("pays out from available over the sandbox rail", async () => {
    await seed(store);
    const response = await payoutPost(
      post("/api/v1/vaults/payout", { payee_id: "creator_1", amount_cents: 2_000, rail: "rtp" }),
    );
    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(body.transfer.rail).toBe("rtp");
    const creator = await store.getVault("creator_1");
    expect(creator?.available_balance).toBe(3_000);
    expect(creator?.pending_balance).toBe(2_000);
  });

  it("503s with baas_not_configured in live mode without provider keys", async () => {
    await seed(store);
    process.env.BAAS_MODE = "live";
    const response = await payoutPost(
      post("/api/v1/vaults/payout", { payee_id: "creator_1", amount_cents: 2_000, rail: "ach" }),
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("baas_not_configured");
  });
});

describe("sandbox baas rails", () => {
  it("POST /api/v1/baas/ach settles +3 days in sandbox mode", async () => {
    await seed(store);
    const response = await achPost(
      post("/api/v1/baas/ach", {
        payee_id: "creator_1",
        payee_name: "Creator One",
        amount_cents: 2_000,
      }),
    );
    expect(response.ok).toBe(true);
    const body = await response.json();
    const eta = new Date(body.transfer.estimated_settlement).getTime();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    expect(eta - Date.now()).toBeGreaterThan(threeDaysMs - 60_000);
    expect(eta - Date.now()).toBeLessThan(threeDaysMs + 60_000);
  });

  it("POST /api/v1/baas/rtp settles immediately in sandbox mode", async () => {
    await seed(store);
    const response = await rtpPost(
      post("/api/v1/baas/rtp", {
        payee_id: "creator_1",
        payee_name: "Creator One",
        amount_cents: 2_000,
      }),
    );
    expect(response.ok).toBe(true);
    const body = await response.json();
    const eta = new Date(body.transfer.estimated_settlement).getTime();
    expect(eta).toBeGreaterThan(Date.now() - 60_000);
    expect(eta).toBeLessThan(Date.now() + 60_000);
  });
});

describe("plaid sandbox routes", () => {
  it("POST /api/v1/auth/plaid-kyc creates a link token", async () => {
    await seed(store);
    const response = await kycPost(
      post("/api/v1/auth/plaid-kyc", {
        action: "create_link_token",
        creator_id: "creator_1",
        products: ["auth"],
      }),
    );
    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(body.link_token ?? body.result?.link_token).toBeTruthy();
  });

  it("POST /api/v1/auth/plaid-exchange trades a public token for an access token", async () => {
    await seed(store);
    // The exchange requires a sandbox Link session — create one first.
    const link = await kycPost(
      post("/api/v1/auth/plaid-kyc", {
        action: "create_link_token",
        creator_id: "creator_1",
        products: ["auth"],
      }),
    );
    expect(link.ok).toBe(true);
    const linkBody = await link.json();
    const publicToken = linkBody.public_token;
    expect(publicToken).toBeTruthy();

    const response = await exchangePost(
      post("/api/v1/auth/plaid-exchange", {
        creator_id: "creator_1",
        public_token: publicToken,
      }),
    );
    expect(response.ok).toBe(true);
  });
});
