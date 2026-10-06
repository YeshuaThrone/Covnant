import { redirect } from 'next/navigation';

export const metadata = {
  title: 'Covenant Vault — Covnant',
  description: 'The vault surface — redirects to the master contract data.',
};

/**
 * /vault — routes to the contract vault, the live surface where agreements
 * are generated, finalized, and exported. Later PRs may expand this into a
 * dedicated vault experience; the nav entry resolves from day one.
 */
export default function VaultPage() {
  redirect('/contracts');
}
