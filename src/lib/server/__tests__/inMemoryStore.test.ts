/**
 * InMemoryStore round-trips — one suite per record family, ordered so the
 * suite doubles as the contract walkthrough: insert → get → update → list
 * through the seam every engine file will call. The GL section proves
 * ordering + prev_hash chain continuity through the store (the store only
 * persists and orders what the ledger engine hashes — the chain values are
 * set by the caller, exactly as Cursor's ledger/chain.ts will feed them).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryStore } from '@/lib/server/inMemoryStore';
import { getStore, setStore, type ShowRecord, type Store } from '@/lib/server/store';
import type { LedgerTransactionRecord } from '@/lib/don/types';
import type {
  GlJournalRecord,
  PayoutHoldRecord,
  SovereignVaultRecord,
} from '@/modules/don/records';

let store: InMemoryStore;

beforeEach(() => {
  store = new InMemoryStore();
});

const showInput = (overrides: Partial<ShowRecord> = {}): Parameters<Store['insertShow']>[0] => ({
  artist_id: 'artist_1',
  artist_name: 'Test Artist',
  venue_name: 'Mohawk',
  district: 'east',
  set_time: '2026-10-01T20:00:00Z',
  created_at: '2026-09-01T00:00:00Z',
  ticketing_type: 'native',
  native_ticket_price: 2500,
  native_ticket_capacity: 2,
  ...overrides,
});

describe('shows + checkout capacity accounting', () => {
  it('round-trips insert → get → list with newest-first tiebreak', async () => {
    const a = await store.insertShow(showInput({ created_at: '2026-09-01T00:00:00Z' }));
    const b = await store.insertShow(
      showInput({ artist_name: 'Second', created_at: '2026-09-02T00:00:00Z' }),
    );
    const c = await store.insertShow(
      showInput({ artist_name: 'Tied', created_at: '2026-09-02T00:00:00Z' }),
    );

    expect(await store.getShow(a.id)).toEqual(a);
    expect((await store.getShow('missing')) ?? null).toBeNull();

    const list = await store.listShows();
    // Newest first; the c/b pair shares a timestamp — latest insertion leads.
    expect(list.map((s) => s.id)).toEqual([c.id, b.id, a.id]);

    // Limit truncates from the head.
    expect((await store.listShows(2)).map((s) => s.id)).toEqual([c.id, b.id]);
  });

  it('records a purchase once, then stays idempotent and capacity-safe', async () => {
    const show = await store.insertShow(showInput({ native_ticket_capacity: 2 }));

    expect(await store.recordCheckoutPurchase('s1', show.id, 2)).toEqual({
      outcome: 'recorded',
      remaining: 0,
    });
    // Repeat confirm of the same session — no double decrement.
    expect(await store.recordCheckoutPurchase('s1', show.id, 2)).toEqual({
      outcome: 'already_recorded',
      remaining: 0,
    });
    // New session after sellout — session recorded, capacity untouched.
    expect(await store.recordCheckoutPurchase('s2', show.id, 1)).toEqual({
      outcome: 'insufficient_capacity',
      remaining: 0,
    });
  });

  it('returns null for missing, non-native, and null-capacity shows', async () => {
    expect(await store.recordCheckoutPurchase('s1', 'nope', 1)).toBeNull();

    const external = await store.insertShow(
      showInput({ ticketing_type: 'external', native_ticket_capacity: null }),
    );
    expect(await store.recordCheckoutPurchase('s1', external.id, 1)).toBeNull();
  });
});

describe('live pings', () => {
  it('round-trips insert → list newest-first', async () => {
    const a = await store.insertLivePing({
      artist_id: 'artist_1',
      latitude: 30.26,
      longitude: -97.74,
      timestamp: '2026-09-01T00:00:00Z',
      status: 'onstage',
    });
    await store.insertLivePing({
      artist_id: 'artist_1',
      latitude: 30.27,
      longitude: -97.75,
      timestamp: '2026-09-01T00:01:00Z',
      status: 'onstage',
    });

    const pings = await store.listLivePings();
    expect(pings).toHaveLength(2);
    expect(pings[0].id).not.toBe(a.id); // later timestamp first
    expect(pings[1].id).toBe(a.id);
  });
});

describe('artists', () => {
  it('trims the name and resolves by id and key hash', async () => {
    const artist = await store.insertArtist('  Trimmed Name  ', 'hash-1', 'prefix-1');
    expect(artist.name).toBe('Trimmed Name');
    expect(artist.created_at).toBeTruthy();

    expect(await store.getArtist(artist.id)).toEqual(artist);
    expect((await store.getArtistByKeyHash('hash-1'))?.id).toBe(artist.id);
    expect((await store.getArtistByKeyHash('missing')) ?? null).toBeNull();
  });
});

describe('plaid link tokens', () => {
  it('round-trips both token lookups and the access-token update', async () => {
    await store.insertPlaidLinkToken({
      creator_id: 'creator_1',
      link_token: 'link-1',
      public_token: 'public-1',
      access_token: 'access-1',
      expiration: '2026-09-02T00:00:00Z',
      products: 'auth,transactions',
    });

    const byLink = await store.getPlaidLinkTokenByLinkToken('link-1');
    expect(byLink?.public_token).toBe('public-1');
    expect((await store.getPlaidLinkTokenByPublicToken('public-1'))?.id).toBe(byLink?.id);

    const updated = await store.updatePlaidAccessToken('public-1', 'access-rotated');
    expect(updated?.access_token).toBe('access-rotated');
    expect((await store.updatePlaidAccessToken('missing', 'x')) ?? null).toBeNull();
  });

  it('enforces unique link_token and public_token', async () => {
    const token = {
      creator_id: 'creator_1',
      link_token: 'link-1',
      public_token: 'public-1',
      access_token: 'access-1',
      expiration: '2026-09-02T00:00:00Z',
      products: 'auth',
    };
    await store.insertPlaidLinkToken(token);
    await expect(store.insertPlaidLinkToken(token)).rejects.toThrow(/UNIQUE constraint failed/i);
    await expect(
      store.insertPlaidLinkToken({ ...token, link_token: 'link-2' }),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });
});

describe('kyc verifications', () => {
  it('lists by creator newest-first', async () => {
    await store.insertKycVerification({
      creator_id: 'creator_1',
      plaid_link_token: null,
      plaid_public_token: null,
      status: 'pending',
      identity_json: '{}',
      failure_reason: null,
      created_at: '2026-09-01T00:00:00Z',
      verified_at: null,
    });
    await store.insertKycVerification({
      creator_id: 'creator_1',
      plaid_link_token: 'link-1',
      plaid_public_token: 'public-1',
      status: 'verified',
      identity_json: '{}',
      failure_reason: null,
      created_at: '2026-09-02T00:00:00Z',
      verified_at: '2026-09-02T01:00:00Z',
    });
    await store.insertKycVerification({
      creator_id: 'creator_2',
      plaid_link_token: null,
      plaid_public_token: null,
      status: 'failed',
      identity_json: '{}',
      failure_reason: 'doc mismatch',
      created_at: '2026-09-01T00:00:00Z',
      verified_at: null,
    });

    const list = await store.listKycVerificationsByCreator('creator_1');
    expect(list).toHaveLength(2);
    expect(list[0].status).toBe('verified'); // newer created_at first
    expect(await store.listKycVerificationsByCreator('creator_2')).toHaveLength(1);
  });
});

describe('processor tokens', () => {
  it('round-trips the pair lookup and enforces the unique pair', async () => {
    const row = {
      creator_id: 'creator_1',
      public_token: 'public-1',
      processor: 'column' as const,
      processor_token: 'processor-1',
      account_id: 'acct-1',
      created_at: '2026-09-01T00:00:00Z',
    };
    await store.insertProcessorToken(row);

    expect((await store.getProcessorToken('public-1', 'column'))?.processor_token).toBe(
      'processor-1',
    );
    expect((await store.getProcessorToken('public-1', 'unit')) ?? null).toBeNull();

    await expect(
      store.insertProcessorToken({ ...row, processor_token: 'processor-2' }),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });
});

describe('split runs', () => {
  it('defaults status to posted and round-trips status updates', async () => {
    const run = await store.insertSplitRun({
      source: 'dsp',
      period: '2026-08',
      currency: 'USD',
      gross_cents: 100_000,
      line_item_count: 1,
      variance_account_cents: 0,
      created_at: '2026-09-01T00:00:00Z',
    });
    expect(run.status).toBe('posted');
    expect(run.currency).toBe('USD');

    expect((await store.updateSplitRunStatus(run.id, 'reversed'))?.status).toBe('reversed');
    expect((await store.getSplitRun(run.id))?.status).toBe('reversed');
    expect((await store.getSplitRun('missing')) ?? null).toBeNull();
    expect((await store.updateSplitRunStatus('missing', 'posted')) ?? null).toBeNull();
  });
});

describe('ledger transactions', () => {
  const run = { id: 'run-1', created_at: '2026-09-01T00:00:00Z' };

  const lineInput = (lineItemId: string, createdAt: string) => ({
    split_run_id: run.id,
    line_item_id: lineItemId,
    payee_id: 'creator_1',
    payee_name: 'Creator One',
    role: 'creator' as const,
    share_bps: 10000,
    amount_cents: 7_600,
    currency: 'USD',
    status: 'pending_settlement' as const,
    rail: null,
    baas_provider: null,
    baas_transfer_id: null,
    settled_at: null,
    created_at: createdAt,
  });

  it('insert → get → update → list per run and per line item', async () => {
    const a = await store.insertLedgerTransaction(lineInput('li-1', run.created_at));
    const b = await store.insertLedgerTransaction(lineInput('li-1', '2026-09-02T00:00:00Z'));

    expect(a.kind).toBe('royalty');
    expect(a.currency).toBe('USD');
    expect((await store.getLedgerTransaction(a.id))?.id).toBe(a.id);
    expect((await store.getLedgerTransaction('missing')) ?? null).toBeNull();

    const settled = await store.updateLedgerSettlement(a.id, {
      status: 'settled',
      rail: 'rtp',
      baas_provider: 'column',
      baas_transfer_id: 'bt-1',
      settled_at: '2026-09-03T00:00:00Z',
    });
    expect(settled).toMatchObject({ status: 'settled', rail: 'rtp', baas_transfer_id: 'bt-1' });

    const byRun = await store.listLedgerTransactionsByRun(run.id);
    expect(byRun.map((t) => t.id)).toEqual([a.id, b.id]); // created_at ASC
    expect(
      (await store.listLedgerTransactionsByLineItem('li-1')).map((t) => t.id),
    ).toEqual([a.id, b.id]);
    expect(
      (await store.listLedgerTransactionsByLineItem('li-other')).map(
        (t: LedgerTransactionRecord) => t.id,
      ),
    ).toEqual([]);
  });

  it('returns undefined when settling a missing transaction', async () => {
    expect(
      (await store.updateLedgerSettlement('missing', {
        status: 'settled',
        rail: null,
        baas_provider: null,
        baas_transfer_id: null,
        settled_at: null,
      })) ?? null,
    ).toBeNull();
  });
});

describe('baas transfers', () => {
  it('insert → get → update → list newest-first', async () => {
    const a = await store.insertBaasTransfer({
      provider: 'column',
      rail: 'rtp',
      payee_id: 'creator_1',
      payee_name: 'Creator One',
      amount_cents: 7_600,
      currency: 'USD',
      status: 'submitted',
      ledger_transaction_id: 'lt-1',
      created_at: '2026-09-01T00:00:00Z',
      estimated_settlement: null,
    });
    const b = await store.insertBaasTransfer({
      provider: 'unit',
      rail: 'ach',
      payee_id: 'creator_2',
      payee_name: 'Creator Two',
      amount_cents: 100,
      currency: 'USD',
      status: 'submitted',
      ledger_transaction_id: null,
      created_at: '2026-09-02T00:00:00Z',
      estimated_settlement: '2026-09-05T00:00:00Z',
    });

    expect((await store.getBaasTransfer(a.id))?.provider).toBe('column');
    expect((await store.getBaasTransfer('missing')) ?? null).toBeNull();

    expect((await store.updateBaasTransferStatus(a.id, 'settled'))?.status).toBe('settled');
    expect((await store.updateBaasTransferStatus('missing', 'settled')) ?? null).toBeNull();

    const list = await store.listBaasTransfers();
    expect(list.map((t) => t.id)).toEqual([b.id, a.id]);
  });
});

describe('company dust', () => {
  it('lists dust rows per run in insertion order', async () => {
    const first = await store.insertCompanyDust({
      split_run_id: 'run-1',
      line_item_id: 'li-1',
      amount_cents: 7,
      variance_account_id: 'platform',
      created_at: '2026-09-01T00:00:00Z',
    });
    const second = await store.insertCompanyDust({
      split_run_id: 'run-1',
      line_item_id: 'li-2',
      amount_cents: 3,
      variance_account_id: 'platform',
      created_at: '2026-09-01T00:00:00Z',
    });

    const dust = await store.listCompanyDustByRun('run-1');
    expect(dust.map((d) => d.id)).toEqual([first.id, second.id]);
    expect(await store.listCompanyDustByRun('run-other')).toEqual([]);
  });
});

describe('compliance: tax profiles, YTD, escrow', () => {
  it('upserts tax profiles by creator_id', async () => {
    expect((await store.getCreatorTaxProfile('creator_1')) ?? null).toBeNull();

    await store.upsertCreatorTaxProfile({
      creator_id: 'creator_1',
      tin_verified: 0,
      w9_on_file: 0,
      updated_at: '2026-09-01T00:00:00Z',
    });
    await store.upsertCreatorTaxProfile({
      creator_id: 'creator_1',
      tin_verified: 1,
      w9_on_file: 1,
      updated_at: '2026-09-02T00:00:00Z',
    });

    const profile = await store.getCreatorTaxProfile('creator_1');
    expect(profile).toEqual({
      creator_id: 'creator_1',
      tin_verified: 1,
      w9_on_file: 1,
      updated_at: '2026-09-02T00:00:00Z',
    });
  });

  it('upserts YTD earnings on the (creator_id, tax_year) key', async () => {
    const base = {
      creator_id: 'creator_1',
      tax_year: 2026,
      gross_cents: 100,
      withheld_cents: 24,
      updated_at: '2026-09-01T00:00:00Z',
    };
    await store.upsertCreatorYtd(base);
    await store.upsertCreatorYtd({ ...base, gross_cents: 700, withheld_cents: 168 });
    expect(await store.getCreatorYtd('creator_1', 2026)).toEqual({
      ...base,
      gross_cents: 700,
      withheld_cents: 168,
    });
    expect((await store.getCreatorYtd('creator_1', 2025)) ?? null).toBeNull();
  });

  it('lists escrow per creator+year in insertion order', async () => {
    const escrow = (createdAt: string) => ({
      creator_id: 'creator_1',
      tax_year: 2026,
      gross_cents: 600,
      withheld_cents: 144,
      net_cents: 456,
      tin_verified: 0,
      w9_on_file: 0,
      requires_1099: 1,
      crossed_1099_threshold: 1,
      created_at: createdAt,
    });
    const first = await store.insertTaxEscrow(escrow('2026-09-01T00:00:00Z'));
    const second = await store.insertTaxEscrow(escrow('2026-09-02T00:00:00Z'));
    await store.insertTaxEscrow({ ...escrow('2026-09-01T00:00:00Z'), creator_id: 'creator_2' });

    const list = await store.listTaxEscrowByCreator('creator_1', 2026);
    expect(list.map((e) => e.id)).toEqual([first.id, second.id]);
  });
});

describe('sovereign vaults', () => {
  it('upserts per payee and lists by payee_id', async () => {
    expect((await store.getVault('creator_1')) ?? null).toBeNull();

    const vault = (payeeId: string, name: string): SovereignVaultRecord => ({
      payee_id: payeeId,
      payee_name: name,
      available_balance: 100,
      pending_balance: 20,
      reserve_balance: 5,
      updated_at: '2026-09-01T00:00:00Z',
    });
    await store.upsertVault(vault('creator_2', 'Two'));
    await store.upsertVault(vault('creator_1', 'One'));
    await store.upsertVault({ ...vault('creator_1', 'One'), available_balance: 900 });

    expect((await store.getVault('creator_1'))?.available_balance).toBe(900);
    const list = await store.listVaults();
    expect(list.map((v) => v.payee_id)).toEqual(['creator_1', 'creator_2']);
  });
});

describe('vault + catalog disputes', () => {
  it('upserts one dispute row per payee', async () => {
    await store.upsertVaultDispute({
      payee_id: 'creator_1',
      locked: 1,
      line_item_id: 'li-1',
      frozen_from_available: 100,
      frozen_from_pending: 0,
      updated_at: '2026-09-01T00:00:00Z',
    });
    await store.upsertVaultDispute({
      payee_id: 'creator_1',
      locked: 0,
      line_item_id: null,
      frozen_from_available: 0,
      frozen_from_pending: 0,
      updated_at: '2026-09-02T00:00:00Z',
    });

    const dispute = await store.getVaultDispute('creator_1');
    expect(dispute).toMatchObject({ locked: 0, line_item_id: null });
  });

  it('upserts one catalog dispute row per work', async () => {
    await store.upsertCatalogDispute({ work_id: 'work-1', locked: 1, updated_at: 't1' });
    await store.upsertCatalogDispute({ work_id: 'work-1', locked: 0, updated_at: 't2' });
    expect(await store.getCatalogDispute('work-1')).toMatchObject({
      locked: 0,
      updated_at: 't2',
    });
    expect((await store.getCatalogDispute('missing')) ?? null).toBeNull();
  });
});

describe('recoupment advances + ledger', () => {
  it('upserts advances per creator and lists by creator_id', async () => {
    const advance = (creatorId: string, current: number) => ({
      creator_id: creatorId,
      creator_name: `Creator ${creatorId}`,
      recoupment_target_cents: 100_000,
      recoupment_current_cents: current,
      recoupment_bps: 10000,
      updated_at: '2026-09-01T00:00:00Z',
    });
    await store.upsertRecoupmentAdvance(advance('creator_2', 0));
    await store.upsertRecoupmentAdvance(advance('creator_1', 50));
    await store.upsertRecoupmentAdvance(advance('creator_1', 500));

    expect((await store.getRecoupmentAdvance('creator_1'))?.recoupment_current_cents).toBe(500);
    expect(
      (await store.listRecoupmentAdvances()).map((a) => a.creator_id),
    ).toEqual(['creator_1', 'creator_2']);
  });

  it('lists recoupment ledger rows per run in insertion order', async () => {
    const first = await store.insertRecoupmentLedger({
      creator_id: 'creator_1',
      split_run_id: 'run-1',
      incoming_cents: 700,
      recouped_cents: 500,
      excess_cents: 200,
      recoupment_current_cents: 500,
      created_at: '2026-09-01T00:00:00Z',
    });
    const second = await store.insertRecoupmentLedger({
      creator_id: 'creator_1',
      split_run_id: 'run-1',
      incoming_cents: 300,
      recouped_cents: 300,
      excess_cents: 0,
      recoupment_current_cents: 800,
      created_at: '2026-09-01T00:00:01Z',
    });

    const ledger = await store.listRecoupmentLedgerByRun('run-1');
    expect(ledger.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(await store.listRecoupmentLedgerByRun('run-other')).toEqual([]);
  });
});

describe('payout holds', () => {
  const hold = (transferId: string, payeeId: string, amount: number): PayoutHoldRecord => ({
    transfer_id: transferId,
    payee_id: payeeId,
    amount_cents: amount,
    status: 'in_flight',
    created_at: '2026-09-01T00:00:00Z',
  });

  it('insert → get → status update → in-flight sum', async () => {
    await store.insertPayoutHold(hold('t-1', 'creator_1', 100));
    await store.insertPayoutHold(hold('t-2', 'creator_1', 50));
    await store.insertPayoutHold(hold('t-3', 'creator_2', 999));

    expect((await store.getPayoutHold('t-1'))?.amount_cents).toBe(100);
    expect((await store.getPayoutHold('missing')) ?? null).toBeNull();

    expect((await store.updatePayoutHoldStatus('t-1', 'settled'))?.status).toBe('settled');
    expect((await store.updatePayoutHoldStatus('missing', 'settled')) ?? null).toBeNull();

    // Only in_flight rows count toward the in-flight sum.
    expect(await store.sumInFlightPayoutHolds('creator_1')).toBe(50);
    expect(await store.sumInFlightPayoutHolds('creator_2')).toBe(999);
    expect(await store.sumInFlightPayoutHolds('missing')).toBe(0);
  });
});

describe('payout reversals', () => {
  it('returns the latest reversal per transfer', async () => {
    await store.insertPayoutReversal({
      transfer_id: 't-1',
      payee_id: 'creator_1',
      amount_cents: 100,
      reason: 'payout.returned',
      ledger_transaction_id: null,
      journal_id: 'j-1',
      created_at: '2026-09-01T00:00:00Z',
    });
    await store.insertPayoutReversal({
      transfer_id: 't-1',
      payee_id: 'creator_1',
      amount_cents: 100,
      reason: 'payout.failed',
      ledger_transaction_id: 'lt-1',
      journal_id: 'j-2',
      created_at: '2026-09-02T00:00:00Z',
    });

    expect((await store.getPayoutReversalByTransfer('t-1'))?.reason).toBe('payout.failed');
    expect((await store.getPayoutReversalByTransfer('missing')) ?? null).toBeNull();
  });
});

describe('webhook event ledgers', () => {
  it('dedupes baas webhook events by event_id', async () => {
    await store.insertWebhookEvent({
      event_id: 'evt-1',
      event: 'payout.settled',
      transfer_id: 't-1',
      payload_json: '{}',
      reversal_id: null,
      created_at: '2026-09-01T00:00:00Z',
    });
    expect((await store.getWebhookEvent('evt-1'))?.transfer_id).toBe('t-1');
    expect((await store.getWebhookEvent('missing')) ?? null).toBeNull();
    await expect(
      store.insertWebhookEvent({
        event_id: 'evt-1',
        event: 'payout.settled',
        transfer_id: 't-1',
        payload_json: '{}',
        reversal_id: null,
        created_at: '2026-09-01T00:00:00Z',
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  it('dedupes dsp webhook events by event_id', async () => {
    await store.insertDspWebhookEvent({
      event_id: 'dsp-1',
      event: 'usage.reported',
      source: 'dsp-a',
      split_run_id: null,
      payload_json: '{}',
      created_at: '2026-09-01T00:00:00Z',
    });
    expect((await store.getDspWebhookEvent('dsp-1'))?.source).toBe('dsp-a');
    expect((await store.getDspWebhookEvent('missing')) ?? null).toBeNull();
    await expect(
      store.insertDspWebhookEvent({
        event_id: 'dsp-1',
        event: 'usage.reported',
        source: 'dsp-a',
        split_run_id: null,
        payload_json: '{}',
        created_at: '2026-09-01T00:00:00Z',
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });
});

describe('GL journals + entries: ordering and chain continuity', () => {
  it('keeps journal sequence order and serves the chain head', async () => {
    // Three journals, each linking its prev_hash to the prior entry_hash —
    // the caller computes the hashes; the store persists and orders them.
    const journals: GlJournalRecord[] = [];
    for (const [index, [kind, refType, refId]] of [
      ['royalty_posted', 'split_run', 'run-1'],
      ['royalty_posted', 'split_run', 'run-1'],
      ['payout_reversed', 'payout_reversal', 'pr-1'],
    ].entries()) {
      journals.push(
        await store.insertGlJournal({
          kind,
          ref_type: refType,
          ref_id: refId,
          created_at: '2026-09-01T00:0' + index + ':00Z',
          sequence: index + 1,
          prev_hash: index === 0 ? '' : journals[index - 1].entry_hash,
          entry_hash: 'hash-' + (index + 1),
        }),
      );
    }

    // Chain continuity as read back: seq N's prev_hash === seq N-1's entry_hash,
    // and the head is the highest sequence.
    const list = await store.listGlJournals();
    expect(list.map((j) => j.sequence)).toEqual([1, 2, 3]);
    expect(list[0].prev_hash).toBe('');
    expect(list[1].prev_hash).toBe(list[0].entry_hash);
    expect(list[2].prev_hash).toBe(list[1].entry_hash);
    expect((await store.getLatestGlJournal())?.id).toBe(journals[2].id);
    expect((await store.getLatestGlJournal())?.sequence).toBe(3);

    const byRef = await store.listGlJournalsByRef('split_run', 'run-1');
    expect(byRef.map((j) => j.id)).toEqual([journals[0].id, journals[1].id]);
    expect(await store.listGlJournalsByRef('split_run', 'missing')).toEqual([]);
  });

  it('defaults optional chain fields and serves entries per journal in insertion order', async () => {
    const journal = await store.insertGlJournal({
      kind: 'royalty_posted',
      ref_type: 'split_run',
      ref_id: 'run-1',
      created_at: '2026-09-01T00:00:00Z',
    });
    expect(journal).toMatchObject({
      sequence: 0,
      prev_hash: '',
      entry_hash: '',
      state: 'posted',
    });

    const debit = await store.insertGlEntry({
      journal_id: journal.id,
      account: 'platform:variance',
      debit_cents: 10,
      credit_cents: 0,
      created_at: '2026-09-01T00:00:00Z',
    });
    const credit = await store.insertGlEntry({
      journal_id: journal.id,
      account: 'creator:creator_1',
      debit_cents: 0,
      credit_cents: 10,
      created_at: '2026-09-01T00:00:00Z',
    });

    const entries = await store.listGlEntriesByJournal(journal.id);
    expect(entries.map((e) => e.id)).toEqual([debit.id, credit.id]);
    expect((await store.listGlEntries()).map((e) => e.id)).toEqual([debit.id, credit.id]);
    expect(await store.listGlEntriesByJournal('missing-journal')).toEqual([]);
  });
});

describe('split reversals', () => {
  it('round-trips one reversal per run and enforces uniqueness', async () => {
    const reversal = await store.insertSplitReversal({
      split_run_id: 'run-1',
      journal_id: 'j-1',
      created_at: '2026-09-01T00:00:00Z',
    });
    expect((await store.getSplitReversalByRun('run-1'))?.id).toBe(reversal.id);
    expect((await store.getSplitReversalByRun('missing')) ?? null).toBeNull();
    await expect(
      store.insertSplitReversal({
        split_run_id: 'run-1',
        journal_id: 'j-2',
        created_at: '2026-09-02T00:00:00Z',
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });
});

describe('store singleton', () => {
  it('serves an injected test store until reset', () => {
    setStore(store);
    expect(getStore()).toBe(store);
    setStore(null);
  });
});
