/**
 * Internal onboarding MCP tools for phone OTP verification
 * (send_phone_otp / verify_phone_otp) — the founder directive's focused
 * module inside the EXISTING MCP host, not a parallel server.
 *
 * Both tools run the SAME lifecycle functions and the SAME shared rate
 * limits as the canonical HTTP routes: `requestPhoneOtp` / `verifyPhoneOtp`
 * from src/lib/covnant/otp/lifecycle.ts, called lazily per invocation so
 * the byte-locked stdio server still boots (and lists all tools) without
 * Supabase env — exactly like the Don host's lazy fail-closed pattern.
 *
 * Internal-only by construction: these tools are reached through the
 * internal stdio server, are documented as onboarding-only in their
 * descriptions, and are deliberately NOT in the public /api/v1 HTTP binding
 * catalog (catalog.ts). No session is required — the shared Postgres
 * limiter bounds the tool surface through one bucket key instead of an IP.
 *
 * Codes never appear in any result: payloads carry only delivery status
 * (delivered / deliveredVia) and verification status. A delivery failure is
 * fail-open metadata, never an error wall — the same funnel invariant as
 * the HTTP routes.
 */

import {
  OTP_REJECTION_COPY,
  requestPhoneOtp,
  verifyPhoneOtp,
  type PhoneOtpRequestOutcome,
  type PhoneOtpVerifyOutcome,
} from '@/lib/covnant/otp/lifecycle';
import { OTP_RESEND_COOLDOWN_SECONDS } from '@/lib/covnant/otp/service';
import type { McpToolDescriptor, McpToolResult } from './types';
import { mcpErr, mcpOk } from './types';

/** The shared limiter bucket for the internal onboarding surface. */
const MCP_CLIENT_KEY = 'mcp-internal-onboarding';

export const VERIFY_PHONE_MCP_TOOLS: readonly McpToolDescriptor[] = [
  {
    name: 'send_phone_otp',
    description:
      'Internal onboarding only: trigger the phone verification code for an unverified creator profile (same service path and rate limits as POST /api/covnant/auth/phone/otp). Delivery is best-effort through the WhatsApp → Textbee → console chain; a delivery failure is reported as delivered:false, never an error. Never returns the code.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'The creator profile email.' },
        phone: {
          type: 'string',
          description: 'The profile phone in any format; must match the stored canonical E.164 number.',
        },
      },
      required: ['email', 'phone'],
    },
  },
  {
    name: 'verify_phone_otp',
    description:
      'Internal onboarding only: verify the 6-digit phone code and mark the creator profile phone-verified (same service path and rate limits as POST /api/covnant/auth/phone/verify). Single-use, 5-minute expiry, 5-attempt cap. Never returns the code.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'The creator profile email.' },
        code: { type: 'string', description: 'The 6-digit code from the SMS message.' },
      },
      required: ['email', 'code'],
    },
  },
] as const;

export type VerifyPhoneMcpToolName =
  | 'send_phone_otp'
  | 'verify_phone_otp';

const VERIFY_PHONE_NAMES = new Set(VERIFY_PHONE_MCP_TOOLS.map((tool) => tool.name));

export function isVerifyPhoneMcpTool(name: string): name is VerifyPhoneMcpToolName {
  return VERIFY_PHONE_NAMES.has(name as VerifyPhoneMcpToolName);
}

function sendResult(result: PhoneOtpRequestOutcome): McpToolResult {
  switch (result.outcome) {
    case 'invalid_input':
      return mcpErr(
        'invalid_request',
        result.reason === 'invalid_email'
          ? 'Enter a valid email address.'
          : "That phone number doesn't look right — enter a real number, any format works.",
      );
    case 'not_configured':
      return mcpErr(result.reason, 'Phone verification is not configured.');
    case 'rate_limited':
      return result.kind === 'ip_window'
        ? mcpErr('rate_limited', 'Too many code requests. Try again later.')
        : mcpErr(
            'resend_cooldown',
            `A new code can be requested in ${OTP_RESEND_COOLDOWN_SECONDS} seconds.`,
          );
    case 'store_error':
      return mcpErr('otp_request_failed', 'Phone verification could not be requested.');
    case 'sent':
      // The generic no-enumeration payload — ineligible profiles are
      // indistinguishable from a real send, exactly like the HTTP route.
      return mcpOk({
        ok: true,
        delivered: result.delivered,
        deliveredVia: result.deliveredVia,
      });
  }
}

function verifyResult(result: PhoneOtpVerifyOutcome): McpToolResult {
  switch (result.outcome) {
    case 'invalid_input':
      return mcpErr(
        'invalid_request',
        result.reason === 'invalid_email'
          ? 'Enter a valid email address.'
          : OTP_REJECTION_COPY.invalid_code,
      );
    case 'not_configured':
      return mcpErr(result.reason, 'Phone verification is not configured.');
    case 'rate_limited':
      return mcpErr('rate_limited', 'Too many attempts. Try again later.');
    case 'store_error':
      return mcpErr('otp_verify_failed', 'Phone verification could not be completed.');
    case 'rejected':
      return mcpErr(result.reason, OTP_REJECTION_COPY[result.reason]);
    case 'verified':
      return mcpOk({ ok: true, verified: true });
  }
}

/**
 * The verify-phone tool host. Lifecycle calls are made per invocation (no
 * Supabase client is held at construction) so the stdio server boots
 * without env and every tool call still fails closed.
 */
export class VerifyPhoneMcpToolHost {
  public listTools(): readonly McpToolDescriptor[] {
    return VERIFY_PHONE_MCP_TOOLS;
  }

  public async callTool(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<McpToolResult> {
    const body = args ?? {};
    switch (name) {
      case 'send_phone_otp': {
        const result = await requestPhoneOtp(MCP_CLIENT_KEY, {
          email: body.email,
          phone: body.phone,
        });
        return sendResult(result);
      }
      case 'verify_phone_otp': {
        const result = await verifyPhoneOtp(MCP_CLIENT_KEY, {
          email: body.email,
          code: body.code,
        });
        return verifyResult(result);
      }
      default:
        return mcpErr('unknown_tool', `Unknown verify-phone tool: ${name}`);
    }
  }
}
