export const COVENANT_WEBHOOK_EVENTS = [
  "work.registered",
  "sweep.completed",
] as const;

export type CovenantWebhookEvent = (typeof COVENANT_WEBHOOK_EVENTS)[number];

export type CovenantWebhookEnvelope = {
  event: CovenantWebhookEvent;
  payload: unknown;
  timestamp: string;
};

export type DispatchWebhookResult =
  | { ok: true; skipped: true }
  | { ok: true; skipped: false; status: number }
  | {
      ok: false;
      code: "invalid_webhook_url" | "webhook_dispatch_failed";
      message: string;
    };

export type DispatchWebhookOptions = {
  webhookUrl?: string;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
};

function resolveWebhookUrl(explicit?: string): string | undefined {
  const raw = explicit ?? process.env.COVENANT_WEBHOOK_URL;
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Best-effort outbound notice. Missing URL skips. HTTP/HTTPS only.
 * Failures do not throw — callers keep their success path.
 */
export async function dispatchCovenantWebhook(
  event: CovenantWebhookEvent,
  payload: unknown,
  options: DispatchWebhookOptions = {},
): Promise<DispatchWebhookResult> {
  const webhookUrl = resolveWebhookUrl(options.webhookUrl);
  if (!webhookUrl) {
    return { ok: true, skipped: true };
  }
  if (!isHttpUrl(webhookUrl)) {
    return {
      ok: false,
      code: "invalid_webhook_url",
      message: "COVENANT_WEBHOOK_URL must be an http or https URL.",
    };
  }

  const envelope: CovenantWebhookEnvelope = {
    event,
    payload,
    timestamp: (options.clock ?? (() => new Date()))().toISOString(),
  };
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    return { ok: true, skipped: false, status: response.status };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "unknown_error";
    console.error("Webhook dispatch failed:", message);
    return {
      ok: false,
      code: "webhook_dispatch_failed",
      message,
    };
  }
}
