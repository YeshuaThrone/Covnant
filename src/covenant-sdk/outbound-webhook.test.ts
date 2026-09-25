import { describe, expect, it, vi } from "vitest";
import { dispatchCovenantWebhook } from "./outbound-webhook";

describe("dispatchCovenantWebhook", () => {
  it("skips when no URL is configured", async () => {
    const fetchImpl = vi.fn();
    const result = await dispatchCovenantWebhook(
      "work.registered",
      { workId: "work_1" },
      { webhookUrl: "", fetchImpl },
    );
    expect(result).toEqual({ ok: true, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-http URLs", async () => {
    const result = await dispatchCovenantWebhook(
      "work.registered",
      { workId: "work_1" },
      { webhookUrl: "file:///tmp/out" },
    );
    expect(result).toEqual({
      ok: false,
      code: "invalid_webhook_url",
      message: "COVENANT_WEBHOOK_URL must be an http or https URL.",
    });
  });

  it("POSTs a typed envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 204 });
    const result = await dispatchCovenantWebhook(
      "sweep.completed",
      { recoveredRevenueCents: 1000 },
      {
        webhookUrl: "https://hooks.example.test/covenant",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        clock: () => new Date("2026-09-13T12:00:00.000Z"),
      },
    );
    expect(result).toEqual({ ok: true, skipped: false, status: 204 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hooks.example.test/covenant",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "sweep.completed",
          payload: { recoveredRevenueCents: 1000 },
          timestamp: "2026-09-13T12:00:00.000Z",
        }),
      },
    );
  });
});
