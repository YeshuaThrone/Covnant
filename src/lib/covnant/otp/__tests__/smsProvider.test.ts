/**
 * SMS provider unit tests — the delivery seam's contract without any
 * network: 'none' logs server-side and reports ok; textbee and whatsapp post
 * their documented shapes to their documented endpoints and degrade every
 * failure mode (non-2xx, throw, timeout) to ok:false; the fallback composite
 * tries channels in order, first configured-AND-successful wins, every
 * failed hop falls through with a server-side log; env selection defaults to
 * the full chain and a pinned channel without credentials falls back loudly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFallbackProvider,
  createNoneProvider,
  createTextbeeProvider,
  createWhatsAppProvider,
  getSmsProvider,
  type SmsProvider,
} from '../smsProvider';

const PAYLOAD = { body: 'Covnant: your verification code is 012345.', code: '012345' };
const PHONE = '+15125550123';

/** A channel stub whose send result is settable per test. */
function stubChannel(
  name: SmsProvider['name'],
  result: { ok: boolean; error?: string; via?: SmsProvider['name'] },
  calls: string[] = [],
): SmsProvider {
  return {
    name,
    async sendSms(phone) {
      calls.push(`${name}:${phone}`);
      return result;
    },
  };
}

describe('none provider', () => {
  it('logs the message to the server console and reports ok via none', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await createNoneProvider().sendSms(PHONE, PAYLOAD);
      expect(result).toEqual({ ok: true, via: 'none' });
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toContain(PHONE);
      expect(line).toContain('Covnant: your verification code is 012345.');
    } finally {
      log.mockRestore();
    }
  });
});

describe('textbee provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts recipients+message+deviceId to the send endpoint with the x-api-key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createTextbeeProvider({ deviceId: 'device-123', apiKey: 'key-abc' })
      .sendSms(PHONE, PAYLOAD);

    expect(result).toEqual({ ok: true, via: 'textbee' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.textbee.dev/api/v1/gateway/send-sms');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('key-abc');
    const body = JSON.parse(String(init.body)) as {
      recipients: string[];
      message: string;
      deviceId: string;
    };
    expect(body.recipients).toEqual([PHONE]);
    expect(body.message).toContain('012345');
    expect(body.deviceId).toBe('device-123');
  });

  it('degrades a non-2xx response to ok:false without leaking the body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"message":"bad key"}', { status: 401 })),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await createTextbeeProvider({ deviceId: 'd', apiKey: 'k' }).sendSms(
        PHONE,
        PAYLOAD,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe('textbee_http_401');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('degrades a thrown fetch (timeout, DNS, reset) to ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await createTextbeeProvider({ deviceId: 'd', apiKey: 'k' }).sendSms(
        PHONE,
        PAYLOAD,
      );
      expect(result).toEqual({ ok: false, error: 'textbee_request_failed' });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('whatsapp provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the authentication template with the CODE as the body parameter, Bearer-authed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"messages":[{"id":"wamid.1"}]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createWhatsAppProvider({
      accessToken: 'eaag-token',
      phoneNumberId: '109876543210987',
      templateName: 'signup_otp',
    });
    const result = await provider.sendSms(PHONE, PAYLOAD);

    expect(result).toEqual({ ok: true, via: 'whatsapp' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/109876543210987/messages');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer eaag-token');
    const body = JSON.parse(String(init.body)) as {
      messaging_product: string;
      to: string;
      type: string;
      template: {
        name: string;
        language: { code: string };
        components: Array<{ type: string; parameters: Array<{ text: string }> }>;
      };
    };
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe(PHONE);
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('signup_otp');
    expect(body.template.language.code).toBe('en_us');
    const bodyComponent = body.template.components.find((component) => component.type === 'body');
    expect(bodyComponent?.parameters[0]?.text).toBe('012345');
  });

  it('defaults the template name and honors a custom graph version', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createWhatsAppProvider({
      accessToken: 't',
      phoneNumberId: 'p',
      graphVersion: 'v22.0',
    });
    await provider.sendSms(PHONE, PAYLOAD);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v22.0/p/messages');
    const body = JSON.parse(String(init.body)) as { template: { name: string } };
    expect(body.template.name).toBe('otp_authentication');
  });

  it('degrades a non-2xx response to ok:false without leaking the body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":{"message":"bad token"}}', { status: 401 })),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await createWhatsAppProvider({ accessToken: 't', phoneNumberId: 'p' })
        .sendSms(PHONE, PAYLOAD);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('whatsapp_http_401');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('degrades a thrown fetch (timeout, DNS, reset) to ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await createWhatsAppProvider({ accessToken: 't', phoneNumberId: 'p' })
        .sendSms(PHONE, PAYLOAD);
      expect(result).toEqual({ ok: false, error: 'whatsapp_request_failed' });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('fallback composite — the amended locked decision 5', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the first configured AND successful channel wins', async () => {
    const calls: string[] = [];
    const composite = createFallbackProvider([
      stubChannel('whatsapp', { ok: true, via: 'whatsapp' }, calls),
      stubChannel('textbee', { ok: true, via: 'textbee' }, calls),
    ]);

    const result = await composite.sendSms(PHONE, PAYLOAD);

    expect(result).toEqual({ ok: true, via: 'whatsapp' });
    expect(calls).toEqual([`whatsapp:${PHONE}`]);
  });

  it('falls through a failed primary to the secondary and logs the hop', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls: string[] = [];
    const composite = createFallbackProvider([
      stubChannel('whatsapp', { ok: false, error: 'whatsapp_http_500' }, calls),
      stubChannel('textbee', { ok: true, via: 'textbee' }, calls),
    ]);

    const result = await composite.sendSms(PHONE, PAYLOAD);

    expect(result).toEqual({ ok: true, via: 'textbee' });
    expect(calls).toEqual([`whatsapp:${PHONE}`, `textbee:${PHONE}`]);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('whatsapp');
    expect(line).toContain('whatsapp_http_500');
    // The fall-through log never carries the message body or the code.
    expect(line).not.toContain('012345');
  });

  it('a THROWN hop propagates to the route try/catch — reported failures are the fall-through signal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const calls: string[] = [];
    const throwing = createFallbackProvider([
      {
        name: 'whatsapp',
        async sendSms() {
          throw new TypeError('fetch failed');
        },
      },
      stubChannel('textbee', { ok: true, via: 'textbee' }, calls),
    ]);

    // A channel implementation that throws violates the SmsProvider contract
    // (channels catch their own fetch errors); the chain treats REPORTED
    // failures as the fall-through signal, and a thrown hop propagates to the
    // route's fail-open backstop — verified in the route suite.
    const outcome = await throwing.sendSms(PHONE, PAYLOAD).then(
      () => ({ threw: false }),
      (error: unknown) => ({ threw: true, error: String(error) }),
    );

    expect(outcome).toEqual({ threw: true, error: 'TypeError: fetch failed' });
    expect(calls).toEqual([]); // never reached the secondary
    expect(warn).not.toHaveBeenCalled();
  });

  it('reaches the terminal none channel after every real channel fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const calls: string[] = [];
    const composite = createFallbackProvider([
      stubChannel('whatsapp', { ok: false, error: 'whatsapp_request_failed' }, calls),
      stubChannel('textbee', { ok: false, error: 'textbee_request_failed' }, calls),
      createNoneProvider(),
    ]);

    const result = await composite.sendSms(PHONE, PAYLOAD);

    expect(result).toEqual({ ok: true, via: 'none' });
    expect(calls).toEqual([`whatsapp:${PHONE}`, `textbee:${PHONE}`]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(1); // the none channel's console handoff
  });

  it('reports all_channels_failed when no terminal channel exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const composite = createFallbackProvider([
      stubChannel('whatsapp', { ok: false, error: 'whatsapp_http_500' }),
    ]);

    const result = await composite.sendSms(PHONE, PAYLOAD);

    expect(result).toEqual({ ok: false, error: 'all_channels_failed' });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('getSmsProvider env selection', () => {
  it('defaults to the fallback chain ending at none when OTP_SMS_PROVIDER is unset', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const provider = getSmsProvider({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
      expect(provider.name).toBe('fallback');
      // With no credentials anywhere, the send lands on the none terminal.
      const result = await provider.sendSms(PHONE, PAYLOAD);
      expect(result).toEqual({ ok: true, via: 'none' });
    } finally {
      log.mockRestore();
    }
  });

  it('orders the chain whatsapp → textbee → none when both credential sets exist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":{"message":"down"}}', { status: 500 })) // whatsapp fails
      .mockResolvedValue(new Response(null, { status: 200 })); // textbee wins
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = getSmsProvider({
        NODE_ENV: 'test',
        WHATSAPP_ACCESS_TOKEN: 't',
        WHATSAPP_PHONE_NUMBER_ID: 'p',
        TEXTBEE_API_KEY: 'k',
        TEXTBEE_DEVICE_ID: 'd',
      } as NodeJS.ProcessEnv);
      expect(provider.name).toBe('fallback');

      const result = await provider.sendSms(PHONE, PAYLOAD);
      expect(result).toEqual({ ok: true, via: 'textbee' });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      log.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('pins textbee when configured with credentials', () => {
    const provider = getSmsProvider({
      NODE_ENV: 'test',
      OTP_SMS_PROVIDER: 'textbee',
      TEXTBEE_API_KEY: 'key',
      TEXTBEE_DEVICE_ID: 'device',
    } as NodeJS.ProcessEnv);
    expect(provider.name).toBe('textbee');
  });

  it('pins whatsapp when its credentials exist', () => {
    const provider = getSmsProvider({
      NODE_ENV: 'test',
      OTP_SMS_PROVIDER: 'whatsapp',
      WHATSAPP_ACCESS_TOKEN: 't',
      WHATSAPP_PHONE_NUMBER_ID: 'p',
    } as NodeJS.ProcessEnv);
    expect(provider.name).toBe('whatsapp');
  });

  it('falls back to none (with a server-side error) when a pinned channel lacks credentials', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const pin of ['textbee', 'whatsapp']) {
        const provider = getSmsProvider({
          NODE_ENV: 'test',
          OTP_SMS_PROVIDER: pin,
        } as NodeJS.ProcessEnv);
        expect(provider.name).toBe('none');
      }
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('treats any other value as none — an unknown pin never crashes a route', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(
        getSmsProvider({ NODE_ENV: 'test', OTP_SMS_PROVIDER: 'carrier-pigeon' } as NodeJS.ProcessEnv)
          .name,
      ).toBe('none');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
