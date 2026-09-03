'use client';

import {
  describePoolGap,
  formatUnitsAsPercent,
  POOL_LABELS,
  POOL_NAMES,
  poolStateForUnits,
  RIGHTS_HOLDER_ROLES,
  sumPoolUnits,
  TAX_FORM_LABELS,
  TAX_FORM_TYPES,
  type HolderDraft,
  type PoolDraft,
  type PoolName,
} from '@/lib/splits/shared';

const FIELD =
  'w-full rounded-lg border border-white/10 bg-onyx-800 px-3 py-2 text-sm text-[#F2F4F8] placeholder:text-white/30 focus:border-gold focus:outline-none';
const LABEL = 'block text-xs uppercase tracking-wider text-white/40 mb-1';

export function emptyHolder(): HolderDraft {
  return {
    id: crypto.randomUUID(),
    name: '',
    role: 'COMPOSER',
    splitPercentage: 0,
    taxFormType: 'W9_US_PERSON',
    usTaxResident: true,
    isVerified: true,
    routing: {
      accountHolderName: '',
      bankName: '',
      accountNumberOrIBAN: '',
      routingOrBIC: '',
      currency: 'USD',
      countryCode: 'US',
      planetaryJurisdiction: 'EARTH',
      railType: 'ACH',
    },
  };
}

export function freshPools(): PoolDraft[] {
  return POOL_NAMES.map((pool) => ({ pool, holders: [emptyHolder()] }));
}

/** Live save-gate chip: EXACT (emerald) / UNDER (amber) / OVER (red). */
function PoolTotalChip({ pool }: { pool: PoolDraft }) {
  const units = sumPoolUnits(
    pool.holders.map((h) => (Number.isFinite(h.splitPercentage) ? h.splitPercentage : 0)),
  );
  const state = poolStateForUnits(units);
  const gap = describePoolGap(units);
  const tone =
    state === 'EXACT'
      ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
      : state === 'UNDER'
        ? 'border-amber-400/40 bg-amber-400/10 text-amber-300'
        : 'border-red-400/40 bg-red-400/10 text-red-300';
  return (
    <span className={`rounded-full border px-3 py-1 font-mono text-xs ${tone}`}>
      {formatUnitsAsPercent(units)}%{gap ? ` · ${gap}` : ''}
    </span>
  );
}

interface PoolSplitEditorProps {
  pools: PoolDraft[];
  onChange: (next: PoolDraft[]) => void;
}

export function PoolSplitEditor({ pools, onChange }: PoolSplitEditorProps) {
  const updatePool = (pool: PoolName, holders: HolderDraft[]) =>
    onChange(pools.map((p) => (p.pool === pool ? { ...p, holders } : p)));

  const updateHolder = (pool: PoolName, id: string, patch: Partial<HolderDraft>) => {
    const target = pools.find((p) => p.pool === pool);
    if (!target) return;
    updatePool(
      pool,
      target.holders.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    );
  };

  const updateRouting = (pool: PoolName, id: string, patch: Partial<HolderDraft['routing']>) => {
    const target = pools.find((p) => p.pool === pool)?.holders.find((h) => h.id === id);
    if (!target) return;
    updateHolder(pool, id, { routing: { ...target.routing, ...patch } });
  };

  return (
    <div className="space-y-6">
      {pools.map((pool) => (
        <section key={pool.pool} className="glass-card p-6">
          <div className="flex items-center justify-between gap-4">
            <h3 className="font-mono text-sm uppercase tracking-widest text-gold">
              {POOL_LABELS[pool.pool]}
            </h3>
            <PoolTotalChip pool={pool} />
          </div>

          <div className="mt-4 space-y-4">
            {pool.holders.map((holder) => (
              <div key={holder.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <label className={LABEL}>Holder name</label>
                    <input
                      className={FIELD}
                      value={holder.name}
                      placeholder="Rights holder"
                      onChange={(e) => updateHolder(pool.pool, holder.id, { name: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className={LABEL}>Role</label>
                    <select
                      className={FIELD}
                      value={holder.role}
                      onChange={(e) =>
                        updateHolder(pool.pool, holder.id, {
                          role: e.target.value as HolderDraft['role'],
                        })
                      }
                    >
                      {RIGHTS_HOLDER_ROLES.map((role) => (
                        <option key={role} value={role} className="bg-onyx-800">
                          {role}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={LABEL}>Pool share %</label>
                    <input
                      className={FIELD}
                      type="number"
                      step="0.0001"
                      min="0"
                      max="100"
                      value={holder.splitPercentage}
                      onChange={(e) =>
                        updateHolder(pool.pool, holder.id, {
                          splitPercentage: e.target.value === '' ? 0 : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={() =>
                        updatePool(
                          pool.pool,
                          pool.holders.filter((h) => h.id !== holder.id),
                        )
                      }
                      className="w-full rounded-lg border border-white/10 px-3 py-2 text-sm text-white/50 hover:border-red-400/40 hover:text-red-300"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <label className={LABEL}>Tax form</label>
                    <select
                      className={FIELD}
                      value={holder.taxFormType}
                      onChange={(e) =>
                        updateHolder(pool.pool, holder.id, {
                          taxFormType: e.target.value as HolderDraft['taxFormType'],
                          usTaxResident: e.target.value === 'W9_US_PERSON',
                        })
                      }
                    >
                      {TAX_FORM_TYPES.map((t) => (
                        <option key={t} value={t} className="bg-onyx-800">
                          {TAX_FORM_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-2 pt-5">
                    <input
                      id={`verified-${holder.id}`}
                      type="checkbox"
                      checked={holder.isVerified}
                      onChange={(e) =>
                        updateHolder(pool.pool, holder.id, { isVerified: e.target.checked })
                      }
                      className="h-4 w-4 accent-gold"
                    />
                    <label htmlFor={`verified-${holder.id}`} className="text-sm text-white/60">
                      Identity verified
                    </label>
                  </div>
                  <div className="flex items-center gap-2 pt-5">
                    <input
                      id={`taxres-${holder.id}`}
                      type="checkbox"
                      checked={holder.usTaxResident}
                      onChange={(e) =>
                        updateHolder(pool.pool, holder.id, { usTaxResident: e.target.checked })
                      }
                      className="h-4 w-4 accent-gold"
                    />
                    <label htmlFor={`taxres-${holder.id}`} className="text-sm text-white/60">
                      US tax resident
                    </label>
                  </div>
                  <div>
                    <label className={LABEL}>Jurisdiction</label>
                    <select
                      className={FIELD}
                      value={holder.routing.planetaryJurisdiction}
                      onChange={(e) =>
                        updateRouting(pool.pool, holder.id, {
                          planetaryJurisdiction: e.target
                            .value as HolderDraft['routing']['planetaryJurisdiction'],
                        })
                      }
                    >
                      <option value="EARTH" className="bg-onyx-800">EARTH</option>
                      <option value="MARS" className="bg-onyx-800">MARS</option>
                      <option value="ORBITAL" className="bg-onyx-800">ORBITAL</option>
                    </select>
                  </div>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <label className={LABEL}>Bank</label>
                    <input
                      className={FIELD}
                      value={holder.routing.bankName}
                      placeholder="Bank name"
                      onChange={(e) =>
                        updateRouting(pool.pool, holder.id, { bankName: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className={LABEL}>Account / IBAN</label>
                    <input
                      className={FIELD}
                      value={holder.routing.accountNumberOrIBAN}
                      placeholder="Account number or IBAN"
                      onChange={(e) =>
                        updateRouting(pool.pool, holder.id, { accountNumberOrIBAN: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className={LABEL}>Routing / BIC</label>
                    <input
                      className={FIELD}
                      value={holder.routing.routingOrBIC}
                      placeholder="Routing number or BIC"
                      onChange={(e) =>
                        updateRouting(pool.pool, holder.id, { routingOrBIC: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className={LABEL}>Currency</label>
                    <input
                      className={FIELD}
                      value={holder.routing.currency}
                      placeholder="USD"
                      onChange={(e) =>
                        updateRouting(pool.pool, holder.id, { currency: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className={LABEL}>Country</label>
                    <input
                      className={FIELD}
                      value={holder.routing.countryCode}
                      placeholder="US"
                      onChange={(e) =>
                        updateRouting(pool.pool, holder.id, { countryCode: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className={LABEL}>Rail</label>
                    <input
                      className={FIELD}
                      value={holder.routing.railType}
                      placeholder="ACH"
                      onChange={(e) =>
                        updateRouting(pool.pool, holder.id, { railType: e.target.value })
                      }
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() => updatePool(pool.pool, [...pool.holders, emptyHolder()])}
            className="mt-4 rounded-lg border border-gold/40 px-4 py-2 text-sm text-gold hover:bg-gold/10"
          >
            + Add holder
          </button>
        </section>
      ))}
    </div>
  );
}
