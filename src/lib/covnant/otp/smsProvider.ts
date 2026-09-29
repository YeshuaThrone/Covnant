/**
 * The pluggable SMS delivery seam — the spec's locked decision 1, amended by
 * the founder directive (2026-09-29 evening) into MULTI-CHANNEL FALLBACK
 * ROUTING (amended locked decision 5):
 *
 *   1. WhatsApp Business Cloud API  — primary (founder's Meta WABA; the free
 *      1,000 monthly conversations cover SERVICE conversations only, so OTP
 *      rides a paid authentication template — pennies per message).
 *   2. Textbee device gateway       — secondary ($0/month; a physical Android
 *      phone with a US SIM running the Textbee app).
 *   3. none                         — terminal: the message is logged to the
 *      SERVER console and the send reports ok. Dev and the pre-config state;
 *      the plaintext code exists only in the server log, never in a response.
 *
 * The composite tries channels IN ORDER; the first channel that is configured
 * AND sends successfully wins. Every unset, errored, timed-out, or non-2xx
 * hop falls through to the next channel and is logged server-side. Fail-open
 * signup semantics hold at every hop: a delivery outage degrades to
 * delivered:false, never to a broken signup.
 *
 * OTP_SMS_PROVIDER still works as a single-channel PIN (locked decision 1):
 * 'whatsapp' | 'textbee' | 'none' forces exactly that channel — useful in dev
 * and while proving out one device gateway. Unset (the default) = the full
 * chain above.
 *
 * Codes never appear in responses or logs for the WhatsApp/Textbee hops —
 * errors are logged as status codes only, never bodies.
 *
 * Endpoint notes, verified against live docs on 2026-09-29:
 *   - Textbee: POST /api/v1/gateway/send-sms (the spec sketch's device-scoped
 *     path is deprecated) — { recipients: [E.164], message, deviceId } with
 *     the x-api-key header.
 *   - WhatsApp Cloud API: POST graph.facebook.com/{version}/{PHONE_NUMBER_ID}/
 *     messages, Bearer auth, type=template authentication message with the
 *     code as the body parameter (the founder approves the template in Meta;
 *     name defaults to WHATSAPP_OTP_TEMPLATE or the built-in default).
 */

/** What a channel needs to carry one message: the rendered body AND the raw code. */
export interface OtpSmsPayload {
  /** The human-facing SMS body (template-rotated by the caller). */
  body: string;
  /** The bare code — WhatsApp authentication templates take it as a parameter. */
  code: string;
}

export type SmsProviderName = 'whatsapp' | 'textbee' | 'none' | 'telnyx' | 'fallback';

export interface SmsSendResult {
  ok: boolean;
  error?: string;
  /** On success: the channel that actually carried the message. */
  via?: SmsProviderName;
}

/** The one delivery contract every channel implements. */
export interface SmsProvider {
  readonly name: SmsProviderName;
  sendSms(phone: string, message: OtpSmsPayload): Promise<SmsSendResult>;
}

const TEXTBEE_SEND_ENDPOINT = 'https://api.textbee.dev/api/v1/gateway/send-sms';

/** Hard ceiling on a channel round trip — the route stays fast even when a device is offline. */
const CHANNEL_TIMEOUT_MS = 10_000;

/** Default Meta authentication-template name when WHATSAPP_OTP_TEMPLATE is unset. */
const DEFAULT_WHATSAPP_TEMPLATE = 'otp_authentication';

/** Template language — the founder approves the template in this locale. */
const WHATSAPP_TEMPLATE_LANGUAGE = 'en_us';

/** Graph API version — overridable via WHATSAPP_GRAPH_VERSION, pinned default. */
const DEFAULT_GRAPH_VERSION = 'v21.0';

/** The terminal channel: log to the server console, report delivered. */
export function createNoneProvider(): SmsProvider {
  return {
    name: 'none',
    async sendSms(phone, message) {
      // The pre-config state's code handoff — server console ONLY. This is
      // the one sanctioned plaintext surface (spec: "codes log server-side
      // and the skip path covers everyone").
      console.log(`[otp] SMS to ${phone}: ${message.body}`);
      return { ok: true, via: 'none' };
    },
  };
}

/** The founder's device gateway — timeout-bounded, errors fail closed to ok:false. */
export function createTextbeeProvider(config: { deviceId: string; apiKey: string }): SmsProvider {
  return {
    name: 'textbee',
    async sendSms(phone, message) {
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
            message: message.body,
            deviceId: config.deviceId,
          }),
          signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
          cache: 'no-store',
        });
        if (!response.ok) {
          // Status only — never the response body (it could echo the key or
          // account details into the logs).
          return { ok: false, error: `textbee_http_${response.status}` };
        }
        return { ok: true, via: 'textbee' };
      } catch (error) {
        // Timeout (AbortError), DNS, reset — a device-gateway outage is a
        // degraded delivery, not a route error.
        console.error('Textbee SMS send failed:', error);
        return { ok: false, error: 'textbee_request_failed' };
      }
    },
  };
}

/** The Meta WhatsApp Cloud API channel — timeout-bounded like Textbee, status-only errors. */
export function createWhatsAppProvider(config: {
  accessToken: string;
  phoneNumberId: string;
  templateName?: string;
  graphVersion?: string;
}): SmsProvider {
  const endpoint = `https://graph.facebook.com/${config.graphVersion ?? DEFAULT_GRAPH_VERSION}/${config.phoneNumberId}/messages`;
  return {
    name: 'whatsapp',
    async sendSms(phone, message) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.accessToken}`,
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'template',
            template: {
              name: config.templateName ?? DEFAULT_WHATSAPP_TEMPLATE,
              language: { code: WHATSAPP_TEMPLATE_LANGUAGE },
              components: [
                {
                  type: 'body',
                  // The code is the authentication template's body parameter —
                  // it rides the approved template, never a free-form body.
                  parameters: [{ type: 'text', text: message.code }],
                },
              ],
            },
          }),
          signal: AbortSignal.timeout(CHANNEL_TIMEOUT_MS),
          cache: 'no-store',
        });
        if (!response.ok) {
          // Status only — never the response body (token/account details stay
          // out of the logs, and the code is not echoed by this hop either).
          return { ok: false, error: `whatsapp_http_${response.status}` };
        }
        return { ok: true, via: 'whatsapp' };
      } catch (error) {
        console.error('WhatsApp Cloud API send failed:', error);
        return { ok: false, error: 'whatsapp_request_failed' };
      }
    },
  };
}

/**
 * The multi-channel composite — the amended locked decision 5. Channels are
 * tried in array order; the first CONFIGURED-AND-SUCCESSFUL channel wins.
 * Each failed hop is logged server-side (error label only, no body, no code)
 * and the chain falls through. With the terminal `none` channel in the chain
 * the composite always reports ok; fail-open is structural.
 */
export function createFallbackProvider(channels: readonly SmsProvider[]): SmsProvider {
  return {
    name: 'fallback',
    async sendSms(phone, message) {
      for (const channel of channels) {
        const result = await channel.sendSms(phone, message);
        if (result.ok) {
          if (channel.name !== 'none') {
            console.log(`[otp] delivered via ${channel.name}`);
          }
          return result;
        }
        console.warn(
          `[otp] ${channel.name} delivery failed (${result.error ?? 'unknown'}) — falling through to the next channel.`,
        );
      }
      return { ok: false, error: 'all_channels_failed' };
    },
  };
}

/** The env-selected channel for one hop, or undefined when unconfigured. */
function readTextbeeProvider(env: NodeJS.ProcessEnv): SmsProvider | undefined {
  const apiKey = env.TEXTBEE_API_KEY;
  const deviceId = env.TEXTBEE_DEVICE_ID;
  if (!apiKey || !deviceId) return undefined;
  return createTextbeeProvider({ apiKey, deviceId });
}

function readWhatsAppProvider(env: NodeJS.ProcessEnv): SmsProvider | undefined {
  const accessToken = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) return undefined;
  return createWhatsAppProvider({
    accessToken,
    phoneNumberId,
    templateName: env.WHATSAPP_OTP_TEMPLATE,
    graphVersion: env.WHATSAPP_GRAPH_VERSION,
  });
}

function loudNone(pin: string, missing: string): SmsProvider {
  console.error(
    `OTP_SMS_PROVIDER=${pin} but ${missing} is unset — falling back to the none provider ` +
      '(codes log server-side; delivery stays fail-open).',
  );
  return createNoneProvider();
}

/**
 * The env-selected provider. Unset OTP_SMS_PROVIDER (the default) builds the
 * full fallback chain — WhatsApp primary when its credentials exist, Textbee
 * secondary when its credentials exist, none terminal always. A pin selects
 * exactly one channel; a pinned channel without its credentials falls back to
 * none LOUDLY: the funnel must never block on a misconfiguration, and a
 * silent fallback would hide why no messages are going out.
 */
export function getSmsProvider(env: NodeJS.ProcessEnv = process.env): SmsProvider {
  const pin = env.OTP_SMS_PROVIDER?.trim();
  if (pin === 'none') return createNoneProvider();
  if (pin === 'whatsapp') {
    return readWhatsAppProvider(env) ?? loudNone('whatsapp', 'WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID');
  }
  if (pin === 'textbee') {
    return readTextbeeProvider(env) ?? loudNone('textbee', 'TEXTBEE_API_KEY/TEXTBEE_DEVICE_ID');
  }
  if (pin) {
    return loudNone(pin, 'a known channel (whatsapp|textbee|none)');
  }
  const channels: SmsProvider[] = [];
  const whatsapp = readWhatsAppProvider(env);
  if (whatsapp) channels.push(whatsapp);
  const textbee = readTextbeeProvider(env);
  if (textbee) channels.push(textbee);
  channels.push(createNoneProvider());
  return createFallbackProvider(channels);
}
