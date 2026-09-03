import { redirect } from 'next/navigation';

/**
 * /vault — routes to the contract vault, the live surface where agreements
 * are generated, finalized, and exported. Later PRs may expand this into a
 * dedicated vault experience; the nav entry resolves from day one.
 */
export default function VaultPage() {
  redirect('/contracts');
}
