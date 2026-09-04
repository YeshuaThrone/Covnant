import CovnantLanding from '@/components/CovnantLanding';

// Root route renders on demand in production (strict-execution directive):
// no stale prerender of '/' on Vercel.
export const dynamic = 'force-dynamic';

export default function Home() {
  return <CovnantLanding />;
}
