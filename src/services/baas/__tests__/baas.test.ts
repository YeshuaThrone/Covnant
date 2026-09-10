import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import type { BaasProvider, BaasTransferRecord } from "@/lib/don/types";

// Structural in-memory Store covering exactly the methods the BaaS layer
// calls. Swapped for the repo's real InMemoryStore once the Store PR lands.
type TransferRecord = BaasTransferRecord;

class InMemoryStoreMock {
  transfers: TransferRecord[] = [];
  ledger: Map<string, LedgerRow> = new Map();
  settlements: {
    id: string;
    patch: SettlementPatch;
  }[] = [];
  private nextId = 1;

  insertBaasTransfer(input: Omit<TransferRecord, "id">) {
    const record: TransferRecord = { ...input, id: `baas_${this.nextId++}` };
    this.transfers.push(record);
    return record;
  }

  getLedgerTransaction(id: string): LedgerRow | undefined {
    return this.ledger.get(id);
  }

  updateLedgerSettlement(id: string, patch: SettlementPatch): void {
    this.settlements.push({ id, patch });
  }
}

type LedgerRow = {
  id: string;
  payee_id: string;
  payee_name: string;
  amount_cents: number;
  currency: string;
  status: string;
};

type SettlementPatch = {
  status: string;
  rail: "ach" | "rtp";
  baas_provider: BaasProvider;
  baas_transfer_id: string | null;
  settled_at: string | null;
};

const NOW = new Date("2026-09-10T12:00:00.000Z");
const NOW_PLUS_3_DAYS = "2026-09-13T12:00:00.000Z";

let store: InMemoryStoreMock;

const pendingRow = (id: string): LedgerRow => ({
  id,
  payee_id: "creator_1",
  payee_name: "Creator One",
  amount_cents: 12_345,
  currency: "usd",
  status: "pending_settlement",
});

const sandboxInput = (rail: "ach" | "rtp") => ({
  provider: "column" as const,
  rail,
  payee_id: "creator_1",
  payee_name: "Creator One",
  amount_cents: 12_345,
  currency: "usd",
  ledger_transaction_id: "lt_1",
});

describe("sandbox rail", () => {
  beforeEach(() => {
    store = new InMemoryStoreMock();
  });

  it("settles RTP immediately with no ETA gap", async () => {
    const result = await processSandboxRail(store, sandboxInput("rtp"), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("sandbox");
    expect(result.transfer.status).toBe("settled");
    expect(result.transfer.rail).toBe("rtp");
    expect(result.transfer.provider).toBe("column");
    expect(result.transfer.estimated_settlement).toBe(result.transfer.created_at);
    expect(result.transfer.created_at).toBe(NOW.toISOString());
    expect(result.transfer.ledger_transaction_id).toBe("lt_1");
    expect(store.transfers).toHaveLength(1);
  });

  it("records ACH as submitted with a +3-day settlement ETA", async () => {
    const result = await processSandboxRail(store, sandboxInput("ach"), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transfer.status).toBe("submitted");
    expect(result.transfer.estimated_settlement).toBe(NOW_PLUS_3_DAYS);
    expect(result.transfer.created_at).toBe(NOW.toISOString());
  });

  it("computes the ACH ETA in UTC across month boundaries", () => {
    const endOfMonth = new Date("2026-08-30T12:00:00.000Z");
    expect(estimatedAchSettlement(endOfMonth)).toBe("2026-09-02T12:00:00.000Z");
  });
});

describe("live mode fails closed", () => {
  beforeEach(() => {
    store = new InMemoryStoreMock();
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
      ledger_transaction_id: "lt_1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(501);
    expect(store.transfers).toHaveLength(0);
  });
});

describe("adapter dispatch", () => {
  beforeEach(() => {
    store = new InMemoryStoreMock();
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
      ledger_transaction_id: "lt_1",
    });
    expect(result.ok).toBe(true);
    expect(store.transfers[0]?.provider).toBe("unit");
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
    store = new InMemoryStoreMock();
    store.ledger.set("lt_1", pendingRow("lt_1"));
  });

  afterEach(() => {
    setBaasAdapter(null);
  });

  it("transitions a pending transaction to settled on the RTP rail", async () => {
    // Deterministic clock via the deps.processRail injection seam.
    const adapter = new ColumnAdapter({
      store,
      mode: "sandbox",
      processRail: (s, input) => processSandboxRail(s, input, NOW),
    });
    const result = await settleLedgerThroughBaas(store, adapter, "lt_1", "rtp");
    expect(result.ok).toBe(true);
    expect(store.settlements).toEqual([
      {
        id: "lt_1",
        patch: {
          status: "settled",
          rail: "rtp",
          baas_provider: "column",
          baas_transfer_id: "baas_1",
          settled_at: NOW.toISOString(),
        },
      },
    ]);
  });

  it("transitions a pending transaction to submitted on the ACH rail", async () => {
    const adapter = new ColumnAdapter({ store, mode: "sandbox" });
    const result = await settleLedgerThroughBaas(store, adapter, "lt_1", "ach");
    expect(result.ok).toBe(true);
    expect(store.settlements).toEqual([
      {
        id: "lt_1",
        patch: {
          status: "submitted",
          rail: "ach",
          baas_provider: "column",
          baas_transfer_id: "baas_1",
          settled_at: null,
        },
      },
    ]);
  });

  it("marks the ledger failed when the adapter refuses", async () => {
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
      "lt_1",
      "ach",
    );
    expect(result.ok).toBe(false);
    expect(store.settlements).toEqual([
      {
        id: "lt_1",
        patch: {
          status: "failed",
          rail: "ach",
          baas_provider: "unit",
          baas_transfer_id: null,
          settled_at: null,
        },
      },
    ]);
  });

  it("returns ledger_not_found when no transaction matches", async () => {
    const adapter = new ColumnAdapter({ store, mode: "sandbox" });
    const result = await settleLedgerThroughBaas(store, adapter, "lt_404", "rtp");
    expect(result).toMatchObject({
      ok: false,
      status: 404,
      code: "ledger_not_found",
    });
    expect(store.settlements).toHaveLength(0);
  });

  it("routes RTP settlement through createRtpPayment and ACH through createAchTransfer", async () => {
    const adapter = new ColumnAdapter({ store, mode: "sandbox" });
    await settleLedgerThroughBaas(store, adapter, "lt_1", "rtp");
    const [rtpTransfer] = store.transfers;
    expect(rtpTransfer?.rail).toBe("rtp");
    await settleLedgerThroughBaas(store, adapter, "lt_1", "ach");
    const [, achTransfer] = store.transfers;
    expect(achTransfer?.rail).toBe("ach");
  });
});
