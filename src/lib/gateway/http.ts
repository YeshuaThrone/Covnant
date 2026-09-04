/**
 * Shared gateway route helpers — bearer extraction and uniform auth failures.
 *
 * 401 = unauthenticated (no/invalid session token), 403 = authenticated but
 * not an admin. Neither response ever carries data rows.
 */

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get('authorization') ?? undefined;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme && scheme.toLowerCase() === 'bearer' && token ? token : undefined;
}

export function unauthorizedResponse(): Response {
  return Response.json(
    { ok: false, error: 'Unauthorized' },
    { status: 401, headers: { 'cache-control': 'no-store' } }
  );
}

export function forbiddenResponse(): Response {
  return Response.json(
    { ok: false, error: 'Forbidden' },
    { status: 403, headers: { 'cache-control': 'no-store' } }
  );
}
