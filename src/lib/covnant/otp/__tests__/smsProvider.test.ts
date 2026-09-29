/**
 * SMS provider unit tests — the delivery seam's contract without any
 * network: 'none' logs server-side and reports ok; textbee posts the
 * documented shape to the documented endpoint with the x-api-key header and
 * degrades every failure mode (non-2xx, throw, timeout) to ok:false; the
 * env selection defaults to none and falls back loudly when textbee is
 * selected without credentials.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNoneProvider, createTextbeeProvider, getSmsProvider } from '../smsProvider';

describe('none provider', () => {
  it('logs the message to the server console and reports ok', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await createNoneProvider().sendSms('+15125550123', 'Covnant: your code');
      expect(result).toEqual({ ok: true });
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toContain('+15125550123');
      expect(line).toContain('Covnant: your code');
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

    const provider = createTextbeeProvider({ deviceId: 'device-123', apiKey: 'key-abc' });
    const result = await provider.sendSms(
      '+15125550123',
      'Covnant: your verification code is 012345.',
    );

    expect(result).toEqual({ ok: true });
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
    expect(body.recipients).toEqual(['+15125550123']);
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
        '+15125550123',
        'body',
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
        '+15125550123',
        'body',
      );
      expect(result).toEqual({ ok: false, error: 'textbee_request_failed' });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('getSmsProvider env selection', () => {
  it('defaults to none when OTP_SMS_PROVIDER is unset', () => {
    expect(getSmsProvider({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).name).toBe('none');
  });

  it('selects textbee when configured with credentials', () => {
    const provider = getSmsProvider({
      NODE_ENV: 'test',
      OTP_SMS_PROVIDER: 'textbee',
      TEXTBEE_API_KEY: 'key',
      TEXTBEE_DEVICE_ID: 'device',
    } as NodeJS.ProcessEnv);
    expect(provider.name).toBe('textbee');
  });

  it('falls back to none (with a server-side error) when textbee lacks credentials', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const provider = getSmsProvider({
        NODE_ENV: 'test',
        OTP_SMS_PROVIDER: 'textbee',
      } as NodeJS.ProcessEnv);
      expect(provider.name).toBe('none');
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('treats any other value as none — an unknown provider never crashes a route', () => {
    expect(
      getSmsProvider({ NODE_ENV: 'test', OTP_SMS_PROVIDER: 'carrier-pigeon' } as NodeJS.ProcessEnv)
        .name,
    ).toBe('none');
  });
});
