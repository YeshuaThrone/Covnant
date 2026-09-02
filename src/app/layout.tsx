import type { Metadata } from 'next';
import Link from 'next/link';
import { Geist, Geist_Mono } from 'next/font/google';
import { CvRibbonMonogram } from '@/components/brand/CvRibbonMonogram';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'Covnant — Own Your Creation.',
  description: 'Automated Contract Vault & Smart Ledger Verification for creative rights, royalty splitting, and contract automation.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <header className="border-b border-white/10">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-center gap-3">
              <CvRibbonMonogram size={36} />
              <span className="font-mono text-sm tracking-[0.3em] text-[#FFD700]">COVNANT</span>
            </Link>
            <nav className="flex items-center gap-6 text-sm">
              <Link href="/" className="text-white/70 transition hover:text-white">
                Home
              </Link>
              <Link href="/assets" className="text-white/70 transition hover:text-white">
                Asset Studio
              </Link>
              <Link href="/contracts" className="text-white/70 transition hover:text-white">
                Contracts
              </Link>
              <Link href="/ledger" className="text-white/70 transition hover:text-white">
                Ledger
              </Link>
              <Link href="/rights-holders" className="text-white/70 transition hover:text-white">
                Rights Holders
              </Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
