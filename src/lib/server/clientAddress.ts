/**
 * The client-address extraction the beta routes rate-limit on: the first
 * x-forwarded-for hop (the platform edge overwrites the header per hop, so
 * the first value seen server-side is the edge-reported client), falling
 * back to x-real-ip, then one shared 'unknown' bucket.
 *
 * Deliberately identical to the Don surface's clientIdentity
 * (src/modules/don/http.ts) so the whole API has one notion of client
 * identity. Rate-limit KEYING only — never an authorization input: the
 * headers are client-controllable on untrusted paths, and access decisions
 * come from the verified session/secret gates.
 *
 * The request is optional because the unit harness invokes handlers without
 * one; production Next.js always passes it.
 */
export function clientAddress(request: Request | undefined): string {
  return (
    request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request?.headers.get('x-real-ip') ??
    'unknown'
  );
}
