import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "@/lib/server/inMemoryStore";
import {
  ColumnAdapter,
  UnitAdapter,
  getBaasAdapter,
  processSandboxRail,
  readBaasMode,
  readBaasProvider,
  setBaasAdapter,
  settleLedgerThroughBaas,
} from "../index";
import { estimatedAchSettlement, liveFailure } from "../sandboxRail";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const NOW_PLUS_3_DAYS = "2026-09-13T12:00:00.000Z";

let store: InMemoryStore;

const seedPendingLedger = () =>
  store.insertLedgerTransaction({
    split_run_id: "run_1",
    line_item_id: "li_1",
    payee_id: "creator_1",
    payee_name: "Creator One",
    role: "other",
    share_bps: 5000,
    amount_cents: 12_345,
    currency: "usd",
    status: "pending_settlement",
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    created_at: NOW.toISOString(),
    settled_at: null,
  });

const sandboxInput = (rail: "ach" | "rtp", ledgerId: string | null) => ({
  provider: "column" as const,
  rail,
  payee_id: "creator_1",
  payee_name: "Creator One",
  amount_cents: 12_345,
  currency: "usd",
  ledger_transaction_id: ledgerId,
});

describe("sandbox rail", () => {
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it("settles RTP immediately with no ETA gap", async () => {
    const result = await processSandboxRail(
      store,
      sandboxInput("rtp", null),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("sandbox");
    expect(result.transfer.status).toBe("settled");
    expect(result.transfer.rail).toBe("rtp");
    expect(result.transfer.provider).toBe("column");
    expect(result.transfer.estimated_settlement).toBe(result.transfer.created_at);
    expect(result.transfer.created_at).toBe(NOW.toISOString());
    expect(result.transfer.ledger_transaction_id).toBeNull();
    const persisted = await store.getBaasTransfer(result.transfer.id);
    expect(persisted).toMatchObject({ status: "settled", rail: "rtp" });
  });

  it("records ACH as submitted with a +3-day settlement ETA", async () => {
    const result = await processSandboxRail(
      store,
      sandboxInput("ach", null),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transfer.status).toBe("submitted");
    expect(result.transfer.estimated_settlement).toBe(NOW_PLUS_3_DAYS);
    expect(result.transfer.created_at).toBe(NOW.toISOString());
    expect((await store.listBaasTransfers()).length).toBe(1);
  });

  it("computes the ACH ETA in UTC across month boundaries", () => {
    const endOfMonth = new Date("2026-08-30T12:00:00.000Z");
    expect(estimatedAchSettlement(endOfMonth)).toBe("2026-09-02T12:00:00.000Z");
  });
});

describe("live mode fails closed", () => {
  beforeEach(() => {
    store = new InMemoryStore();
  });

  afterEach(() => {
    delete process.env.COLUMN_API_KEY;
    delete process.env.UNIT_API_KEY;
  });

  it("returns 503 baas_not_configured when the provider key is missing", () => {
    const failure = liveFailure("column");
    expect(failure).toMatchObject({
      ok: false,
      status: 503,
      code: "baas_not_configured",
    });
  });

  it("treats a whitespace-only key as unconfigured", () => {
    process.env.COLUMN_API_KEY = "   ";
    expect(liveFailure("column").code).toBe("baas_not_configured");
  });

  it("keys off the provider's own credential", () => {
    process.env.UNIT_API_KEY = "unit-live-key";
    expect(liveFailure("column").code).toBe("baas_not_configured");
    expect(liveFailure("unit").code).toBe("baas_live_not_implemented");
  });

  it("returns 501 baas_live_not_implemented when keys exist — never a silent live attempt", () => {
    process.env.COLUMN_API_KEY = "column-live-key";
    const failure = liveFailure("column");
    expect(failure).toMatchObject({
      ok: false,
      status: 501,
      code: "baas_live_not_implemented",
    });
  });

  it("live-mode dispatch never touches the store", async () => {
    process.env.COLUMN_API_KEY = "column-live-key";
    const adapter = new ColumnAdapter({ store, mode: "live" });
    const result = await adapter.createAchTransfer({
      payee_id: "creator_1",
      payee_name: "Creator One",
      amount_cents: 12_345,
      currency: "usd",
      ledger_transaction_id: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(501);
    expect(await store.listBaasTransfers()).toHaveLength(0);
  });
});

describe("adapter dispatch", () => {
  beforeEach(() => {
    store = new InMemoryStore();
  });

  afterEach(() => {
    delete process.env.BAAS_MODE;
    delete process.env.BAAS_PROVIDER;
    setBaasAdapter(null);
  });

  it("honors BAAS_PROVIDER=unit", () => {
    process.env.BAAS_PROVIDER = "unit";
    expect(readBaasProvider()).toBe("unit");
    expect(getBaasAdapter(store)).toBeInstanceOf(UnitAdapter);
    expect(getBaasAdapter(store).provider).toBe("unit");
  });

  it("defaults to the column processor when BAAS_PROVIDER is unset or unknown", () => {
    expect(readBaasProvider()).toBe("column");
    expect(getBaasAdapter(store)).toBeInstanceOf(ColumnAdapter);
    process.env.BAAS_PROVIDER = "increase";
    expect(readBaasProvider()).toBe("column");
    expect(getBaasAdapter(store)).toBeInstanceOf(ColumnAdapter);
  });

  it("returns a sandbox processor by default and a live processor with BAAS_MODE=live", () => {
    expect(readBaasMode()).toBe("sandbox");
    expect(getBaasAdapter(store).mode).toBe("sandbox");
    process.env.BAAS_MODE = "live";
    expect(readBaasMode()).toBe("live");
    expect(getBaasAdapter(store).mode).toBe("live");
  });

  it("sandbox dispatch processes the rail through the store", async () => {
    const adapter = new UnitAdapter({ store, mode: "sandbox" });
    const result = await adapter.createRtpPayment({
      payee_id: "creator_1",
      payee_name: "Creator One",
      amount_cents: 12_345,
      currency: "usd",
      ledger_transaction_id: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const persisted = await store.getBaasTransfer(result.transfer.id);
    expect(persisted?.provider).toBe("unit");
  });

  it("setBaasAdapter overrides and clears the module singleton", () => {
    const stub = new ColumnAdapter({ store, mode: "sandbox" });
    setBaasAdapter(stub);
    expect(getBaasAdapter(store)).toBe(stub);
    setBaasAdapter(null);
    expect(getBaasAdapter(store)).not.toBe(stub);
  });
});

describe("settleLedgerThroughBaas", () => {
  beforeEach(() => {
    store = new InMemoryStore();
  });

  afterEach(() => {
    setBaasAdapter(null);
  });

  it("transitions a pending transaction to settled on the RTP rail", async () => {
    const row = await seedPendingLedger();
    const adapter = new ColumnAdapter({ store, mode: "sandbox" });
    const result = await settleLedgerThroughBaas(
      store,
      adapter,
      row.id,
      "rtp",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = await store.getLedgerTransaction(row.id);
    expect(updated).toMatchObject({
      status: "settled",
      rail: "rtp",
      baas_provider: "column",
      baas_transfer_id: result.transfer.id,
      settled_at: result.transfer.created_at,
    });
    expect(result.transfer.status).toBe("settled");
  });

  it("transitions a pending transaction to submitted on the ACH rail", async () => {
    const row = await seedPendingLedger();
    const adapter = new ColumnAdapter({ store, mode: "sandbox" });
    const result = await settleLedgerThroughBaas(
      store,
      adapter,
      row.id,
      "ach",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = await store.getLedgerTransaction(row.id);
    expect(updated).toMatchObject({
      status: "submitted",
      rail: "ach",
      baas_provider: "column",
      baas_transfer_id: result.transfer.id,
      settled_at: null,
    });
    expect(result.transfer.status).toBe("submitted");
    const created = new Date(result.transfer.created_at);
    const eta = new Date(result.transfer.estimated_settlement ?? "");
    expect(eta.getTime() - created.getTime()).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it("marks the ledger failed when the adapter refuses", async () => {
    const row = await seedPendingLedger();
    setBaasAdapter({
      provider: "unit",
      mode: "live",
      createAchTransfer: () =>
        Promise.resolve({
          ok: false as const,
          status: 503,
          code: "baas_not_configured",
          message: "refused",
        }),
      createRtpPayment: () =>
        Promise.resolve({
          ok: false as const,
          status: 503,
          code: "baas_not_configured",
          message: "refused",
        }),
    });
    const result = await settleLedgerThroughBaas(
      store,
      getBaasAdapter(store),
      row.id,
      "ach",
    );
    expect(result.ok).toBe(false);
    const updated = await store.getLedgerTransaction(row.id);
    expect(updated).toMatchObject({
      status: "failed",
      rail: "ach",
      baas_provider: "unit",
      baas_transfer_id: null,
      settled_at: null,
    });
  });

  it("returns ledger_not_found when no transaction matches", async () => {
    const adapter = new ColumnAdapter({ store, mode: "sandbox" });
    const result = await settleLedgerThroughBaas(
      store,
      adapter,
      "no-such-ledger-id",
      "rtp",
    );
    expect(result).toMatchObject({
      ok: false,
      status: 404,
      code: "ledger_not_found",
    });
    expect(await store.listBaasTransfers()).toHaveLength(0);
  });

  it("routes RTP settlement through createRtpPayment and ACH through createAchTransfer", async () => {
    const row = await seedPendingLedger();
    const adapter = new ColumnAdapter({ store, mode: "sandbox" });
    await settleLedgerThroughBaas(store, adapter, row.id, "rtp");
    await settleLedgerThroughBaas(store, adapter, row.id, "ach");
    const transfers = await store.listBaasTransfers();
    // listBaasTransfers sorts created_at DESC (production SupabaseStore
    // semantics) — assert the rail set, not list order.
    expect(transfers.map((t) => t.rail).sort()).toEqual(["ach", "rtp"]);
  });
});
