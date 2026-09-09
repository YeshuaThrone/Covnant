/**
 * UCT Registry — the cbt_assets rights_holders entries with provisioning
 * STATUS only. The payout routing object (virtual-account ids/numbers) is
 * stripped server-side by PR F's registrySummary — the console can only
 * show what its props carry, and its props never include account or
 * routing numbers.
 */

import type { RegistrySummary } from '@/lib/admin/overview';
import { StatusPill, type PillTone } from '../shared';

const PROVISIONING_TONE: Record<RegistrySummary['holders'][number]['provisioning'], PillTone> = {
  PROVISIONED: 'jade',
  PENDING: 'amber',
};

export function RegistrySection({ registry }: { registry: RegistrySummary }) {
  return (
    <div aria-label="UCT Registry">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-gold-champagne">
        Rights holders
      </p>
      <p className="mt-2 max-w-2xl text-sm text-white/50">
        Every rights holder registered across the UCT asset registry, deduplicated
        by holder id. Provisioning status only — account and routing details never
        appear in this console.
      </p>

      {registry.holders.length === 0 ? (
        <p className="mt-6 text-sm text-white/50">
          No rights holders registered yet — entries appear after the first asset
          registers its holders.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-white/10">
          <table className="status-table">
            <thead>
              <tr>
                <th className="px-4 py-3 font-medium">Holder</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">UCT</th>
                <th className="px-4 py-3 font-medium">Provisioning</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {registry.holders.map((holder) => (
                <tr key={holder.rightsHolderId}>
                  <td className="px-4 py-3 text-white">{holder.name || '—'}</td>
                  <td className="px-4 py-3 text-white/60">{holder.role || '—'}</td>
                  <td className="px-4 py-3 text-white/60">{holder.email ?? '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gold-champagne/90">{holder.uct ?? '—'}</td>
                  <td className="px-4 py-3">
                    <StatusPill label={holder.provisioning} tone={PROVISIONING_TONE[holder.provisioning]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 font-mono text-xs text-white/30">
        {registry.rightsHolderCount} holder{registry.rightsHolderCount === 1 ? '' : 's'} across{' '}
        {registry.assetCount} asset{registry.assetCount === 1 ? '' : 's'} · provisioning status only
      </p>
    </div>
  );
}
