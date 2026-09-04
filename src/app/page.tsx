import CovnantSDK from '@/components/gateway/CovnantSDK';

// Root route renders on demand in production (strict-execution directive):
// no stale prerender of '/' on Vercel.
export const dynamic = 'force-dynamic';

// The CovnantSDK gateway is the root surface: identity intake, SMS
// verification, Your World entry, and the CEO admin vault.
export default function Home() {
  return <CovnantSDK />;
}
