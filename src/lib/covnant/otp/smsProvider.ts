/**
 * The pluggable SMS delivery seam — the spec's locked decision 1.
 *
 * One interface, selected by OTP_SMS_PROVIDER (default 'none' when unset):
 *   - 'none'    — the pre-config state: the message is logged to the SERVER
 *                 console and the send reports ok. Dev and the founder's
 *                 pre-Textbee window; the plaintext code exists only in the
 *                 server log, never in an API response.
 *   - 'textbee' — the founder's device gateway: POST to api.textbee.dev with
 *                 the x-api-key header and TEXTBEE_DEVICE_ID. $0/month; a
 *                 single point of failure by architecture, which is exactly
 *                 why the route's delivery is best-effort fail-open.
 *   - 'telnyx'  — the future carrier-grade provider: one new implementation
 *                 of this interface plus OTP_SMS_PROVIDER=telnyx. Not built
 *                 here by design — the switch must be configuration, and it
 *                 already is.
 *
 * Endpoint note: the spec's sketch pinned the device-scoped
 * /gateway/{DEVICE_ID}/send-sms path; Textbee's live docs (read 2026-09-29)
 * deprecate that route in favor of POST /api/v1/gateway/send-sms with a
 * deviceId body field — same targeting, current API. Request shape per the
 * docs: { recipients: [E.164], message } with the x-api-key header.
 *
 * A textbee send that is misconfigured, throws, times out, or reports a
 * non-2xx degrades to { ok: false } — the ROUTE turns that into the
 * fail-open delivered:false response (signup is never blocked by delivery).
 */

/** The one delivery contract every provider implements. */
export interface SmsProvider {
  readonly name: 'textbee' | 'none' | 'telnyx';
  sendSms(phone: string, body: string): Promise<{ ok: boolean; error?: string }>;
}

const TEXTBEE_SEND_ENDPOINT = 'https://api.textbee.dev/api/v1/gateway/send-sms';

/** Hard ceiling on a device-gateway round trip — the route stays fast even when the phone is offline. */
const TEXTBEE_TIMEOUT_MS = 10_000;

/** The unset default: log to the server console, report delivered. */
export function createNoneProvider(): SmsProvider {
  return {
    name: 'none',
    async sendSms(phone, body) {
      // The pre-config state's code handoff — server console ONLY. This is
      // the one sanctioned plaintext surface (spec: "codes log server-side
      // and the skip path covers everyone").
      console.log(`[otp] SMS to ${phone}: ${body}`);
      return { ok: true };
    },
  };
}

/** The founder's device gateway — timeout-bounded, errors fail closed to ok:false. */
export function createTextbeeProvider(config: { deviceId: string; apiKey: string }): SmsProvider {
  return {
    name: 'textbee',
    async sendSms(phone, body) {
      try {
        const response = await fetch(TEXTBEE_SEND_ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': config.apiKey,
          },
          body: JSON.stringify({
            // Textbee's documented send shape — recipients must be E.164,
            // which every phone entering this flow already is (the shared
            // normalizer's canonical form).
            recipients: [phone],
            message: body,
            deviceId: config.deviceId,
          }),
          signal: AbortSignal.timeout(TEXTBEE_TIMEOUT_MS),
          cache: 'no-store',
        });
        if (!response.ok) {
          // Status only — never the response body (it could echo the key or
          // account details into the logs).
          return { ok: false, error: `textbee_http_${response.status}` };
        }
        return { ok: true };
      } catch (error) {
        // Timeout (AbortError), DNS, reset — a device-gateway outage is a
        // degraded delivery, not a route error.
        console.error('Textbee SMS send failed:', error);
        return { ok: false, error: 'textbee_request_failed' };
      }
    },
  };
}

/**
 * The env-selected provider. OTP_SMS_PROVIDER=textbee without its credentials
 * falls back to none with a loud server-side error: the funnel must never
 * block on a misconfiguration (fail-open), and a silent fallback would hide
 * why no texts are going out.
 */
export function getSmsProvider(env: NodeJS.ProcessEnv = process.env): SmsProvider {
  const selected = env.OTP_SMS_PROVIDER ?? 'none';
  if (selected === 'textbee') {
    const apiKey = env.TEXTBEE_API_KEY;
    const deviceId = env.TEXTBEE_DEVICE_ID;
    if (!apiKey || !deviceId) {
      console.error(
        'OTP_SMS_PROVIDER=textbee but TEXTBEE_API_KEY/TEXTBEE_DEVICE_ID is unset — ' +
          'falling back to the none provider (codes log server-side; delivery stays fail-open).',
      );
      return createNoneProvider();
    }
    return createTextbeeProvider({ deviceId, apiKey });
  }
  return createNoneProvider();
}
