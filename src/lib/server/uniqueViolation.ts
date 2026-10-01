// The UNIQUE-violation shapes the three backends surface — the canonical
// detection every replay-idempotent insert path shares (the sync license
// settlement's helper, extracted when the gaming cashout conversion log
// needed the same guard).
export function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('23505') || message.includes('UNIQUE constraint failed') ||
    message.toLowerCase().includes('unique violation');
}
