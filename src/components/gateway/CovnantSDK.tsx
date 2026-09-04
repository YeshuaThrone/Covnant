'use client';

import { createClient, type Session } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { toE164Phone } from '@/lib/gateway/phone';

/**
 * COVNANT MASTER SDK
 * Enforces strict inline styling rules to prevent external CSS resets
 * or framework defaults from overriding layout, font, or logic.
 *
 * Backend wiring (currently DORMANT — see the PERMANENT OVERRIDE markers
 * below): identity intake verifies through Supabase SMS OTP
 * (signInWithOtp / verifyOtp), verified creators register their telemetry via
 * POST /api/users/register (bearer-authenticated with the session token), and
 * the CEO admin vault reads its ledger from GET /api/admin/ledger — the
 * server, never this client, is the enforcement point for privileged reads.
 */

// Module scope per the gateway directive. NEXT_PUBLIC vars inline at build;
// placeholder fallbacks keep module evaluation safe when the gateway runs
// without Supabase configured — handlers surface the resulting auth failure
// in the existing errorMsg banner.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'covnant-anon'
);

interface GatewayUserData {
  legalName: string;
  artistName: string;
  regularEmail: string;
  businessEmail: string;
  phone: string;
}

interface GatewayCurrentUser {
  role?: string;
  isAdmin: boolean;
}

/** Tolerant union of the admin ledger record shapes (camelCase API + snake_case columns). */
interface AdminLedgerRecord {
  id?: string;
  createdAt?: string;
  verifiedAt?: string;
  created_at?: string;
  verified_at?: string;
  legalName?: string;
  legal_name?: string;
  artistName?: string;
  artist_name?: string;
  regularEmail?: string;
  regular_email?: string;
  businessEmail?: string;
  business_email?: string;
  phone?: string;
  phoneVerified?: boolean;
  phone_verified?: boolean;
}

type AdminVaultLoad =
  | { status: 'loading' }
  | { status: 'denied' }
  | { status: 'ready'; records: AdminLedgerRecord[] };

// Authoritative gateway snippet: GET /api/admin/ledger; a non-OK response is
// the Unauthorized signal the vault renders as its access-denied state.
async function fetchAdminLedger(): Promise<AdminLedgerRecord[]> {
  const res = await fetch('/api/admin/ledger');
  if (!res.ok) throw new Error('Unauthorized');
  return (await res.json()).records;
}

function deriveCurrentUser(user: Session['user']): GatewayCurrentUser {
  const metadata = user.app_metadata as { role?: unknown } | undefined;
  const role = typeof metadata?.role === 'string' ? metadata.role : undefined;
  return { role, isAdmin: role === 'CEO' || role === 'ADMIN' };
}

export default function CovnantSDK() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('gateway');
  const [currentUser, setCurrentUser] = useState<GatewayCurrentUser | undefined>(undefined);
  const [userData, setUserData] = useState<GatewayUserData>({
    legalName: '',
    artistName: '',
    regularEmail: '',
    businessEmail: '',
    phone: '',
  });

  // PERMANENT OVERRIDE UNTIL MANUALLY REVERTED — handshake state stays
  // declared so the dormant step-2 screen and the world-view verification
  // gate restore with zero edits. During the override step is pinned to 1
  // (its only setStep(2) call lives in the commented handleInitiateSms) and
  // isVerified stays false (only handleVerifyCode sets it true).
  // Supabase + Twilio handshake disabled by user command.
  // DO NOT RE-ENABLE UNTIL EXPLICITLY REQUESTED.
  const [step, setStep] = useState(1);
  const [verificationCode, setVerificationCode] = useState('');
  const [isVerified, setIsVerified] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // currentUser derives from the Supabase session; the admin tab it unhides is
  // cosmetic — /api/admin/ledger enforces the real gate server-side.
  useEffect(() => {
    const applySession = (session: Session | null) =>
      setCurrentUser(session?.user ? deriveCurrentUser(session.user) : undefined);

    supabase.auth.getSession().then(({ data }) => applySession(data.session));
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) =>
      applySession(session)
    );
    return () => subscription.subscription.unsubscribe();
  }, []);

  // PERMANENT OVERRIDE UNTIL MANUALLY REVERTED
  // Supabase + Twilio handshake disabled by user command.
  // DO NOT RE-ENABLE UNTIL EXPLICITLY REQUESTED.
  //
  // The original SMS handshake sender is preserved verbatim below. Manual
  // revert (uncomment-only):
  //   1. Uncomment handleInitiateSms.
  //   2. In the step-1 form below, swap `onSubmit={handleAuthSubmit}` back
  //      to the commented `onSubmit={handleInitiateSms}` line.
  // Nothing else was removed: the 6-digit step-2 screen, handleVerifyCode
  // (verifyOtp + bearer POST /api/users/register + world-view unlock), and
  // the isVerified nav gate all stay wired but unreachable while step is
  // pinned to 1.
  //
  // const handleInitiateSms = async (e: FormEvent<HTMLFormElement>) => {
  //   e.preventDefault();
  //   // UX pre-check only — the UI collects a NANP number under a fixed +1
  //   // prefix. Supabase is the verification authority, never this check.
  //   if (!userData.phone || userData.phone.replace(/\D/g, '').length !== 10) {
  //     setErrorMsg('Please enter a valid 10-digit phone number.');
  //     return;
  //   }
  //   setErrorMsg('');
  //   try {
  //     const { error } = await supabase.auth.signInWithOtp({
  //       phone: toE164Phone(userData.phone),
  //     });
  //     if (error) {
  //       setErrorMsg(`Device ping failed: ${error.message}`);
  //       return;
  //     }
  //     setStep(2);
  //   } catch (err) {
  //     setErrorMsg(`Device ping failed: ${err instanceof Error ? err.message : String(err)}`);
  //   }
  // };

  // PERMANENT OVERRIDE UNTIL MANUALLY REVERTED
  const handleAuthSubmit = async (e: FormEvent<HTMLFormElement>) => {
    if (e) e.preventDefault();
    // Supabase + Twilio handshake disabled by user command.
    // DO NOT RE-ENABLE UNTIL EXPLICITLY REQUESTED.
    // await supabase.auth.signInWithOtp({ phone });
    // Direct advance to main UI state / router
    router.push('/dashboard');
  };

  // PERMANENT OVERRIDE UNTIL MANUALLY REVERTED — verification half of the
  // handshake (verifyOtp, bearer-authenticated telemetry registration, and
  // the world-view unlock). Supabase + Twilio handshake disabled by user
  // command. DO NOT RE-ENABLE UNTIL EXPLICITLY REQUESTED. Left fully intact
  // and wired to the unreachable step-2 screen so the manual revert needs
  // no code restoration.
  const handleVerifyCode = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (verificationCode.trim().length !== 6) {
      setErrorMsg('Enter the 6-digit verification pin sent to your device.');
      return;
    }

    setErrorMsg('');
    const formattedPhone = toE164Phone(userData.phone);
    try {
      const { error } = await supabase.auth.verifyOtp({
        phone: formattedPhone,
        token: verificationCode,
        type: 'sms',
      });
      if (error) {
        setErrorMsg(`Verification failed: ${error.message}`);
        return;
      }

      // Registration is bearer-authenticated with the verified session token;
      // the server re-verifies the JWT before persisting telemetry.
      const { data } = await supabase.auth.getSession();
      const res = await fetch('/api/users/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(data.session?.access_token
            ? { Authorization: `Bearer ${data.session.access_token}` }
            : {}),
        },
        body: JSON.stringify({ ...userData, phone: formattedPhone, phoneVerified: true }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        setErrorMsg(`Registration failed: ${detail?.error ?? `status ${res.status}`}`);
        return;
      }

      setIsVerified(true);
      setActiveTab('world');
    } catch (err) {
      setErrorMsg(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Base Reset to force exact font hierarchy and stop outside CSS pollution
  const fontReset: CSSProperties = {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    WebkitFontSmoothing: 'antialiased',
    MozOsxFontSmoothing: 'grayscale',
    boxSizing: 'border-box',
  };

  return (
    <div style={{ ...containerStyle, ...fontReset }}>
      {/* GLOBAL HEADER */}
      <header style={headerStyle}>
        <div style={{ fontSize: '22px', fontWeight: '800', letterSpacing: '2px', ...fontReset }}>
          COVNANT
        </div>
        <nav style={{ display: 'flex', gap: '24px' }}>
          <button
            type="button"
            onClick={() => setActiveTab('gateway')}
            style={{ ...navBtnStyle, ...fontReset, color: activeTab === 'gateway' ? '#FFFFFF' : '#666666' }}
          >
            Gateway
          </button>

          <button
            type="button"
            onClick={() => isVerified && setActiveTab('world')}
            disabled={!isVerified}
            style={{
              ...navBtnStyle,
              ...fontReset,
              color: activeTab === 'world' ? '#FFFFFF' : '#333333',
              cursor: isVerified ? 'pointer' : 'not-allowed',
            }}
          >
            Your World
          </button>

          {(currentUser?.role === 'CEO' || currentUser?.isAdmin) && (
            <button
              type="button"
              onClick={() => setActiveTab('admin')}
              style={{ ...navBtnStyle, ...fontReset, color: activeTab === 'admin' ? '#D4AF37' : '#666666' }}
            >
              Covnant Admin
            </button>
          )}
        </nav>
      </header>

      {/* MAIN VIEW AREA */}
      <main style={{ padding: '40px 20px', maxWidth: '1100px', margin: '0 auto', ...fontReset }}>

        {/* GATEWAY / SMS STEP */}
        {activeTab === 'gateway' && (
          <div style={{ maxWidth: '460px', margin: '0 auto' }}>
            <div style={{ textAlign: 'center', marginBottom: '28px' }}>
              <h1 style={{ fontSize: '30px', fontWeight: 'bold', margin: '0 0 6px 0', letterSpacing: '1px', color: '#FFFFFF', ...fontReset }}>
                COVNANT
              </h1>
              <p style={{ color: '#888888', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px', margin: 0, ...fontReset }}>
                {step === 1 ? 'Identity Verification Required' : 'Device Handshake Verification'}
              </p>
            </div>

            {errorMsg && (
              <div style={{ backgroundColor: '#2a0808', border: '1px solid #721c24', color: '#f8d7da', padding: '10px', borderRadius: '4px', fontSize: '13px', marginBottom: '16px', textAlign: 'center', ...fontReset }}>
                {errorMsg}
              </div>
            )}

            {step === 1 && (
              <form
                // PERMANENT OVERRIDE UNTIL MANUALLY REVERTED
                // Supabase + Twilio handshake disabled by user command.
                // DO NOT RE-ENABLE UNTIL EXPLICITLY REQUESTED.
                // Manual revert: restore the line below and uncomment
                // handleInitiateSms (preserved verbatim above the override).
                // onSubmit={handleInitiateSms}
                onSubmit={handleAuthSubmit}
                style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
              >
                <div>
                  <label htmlFor="gateway-legal-name" style={{ ...labelStyle, ...fontReset }}>LEGAL NAME</label>
                  <input
                    id="gateway-legal-name"
                    name="legalName"
                    type="text"
                    required
                    value={userData.legalName}
                    onChange={(e) => setUserData({ ...userData, legalName: e.target.value })}
                    style={{ ...inputStyle, ...fontReset }}
                  />
                </div>

                <div>
                  <label htmlFor="gateway-artist-name" style={{ ...labelStyle, ...fontReset }}>ARTIST / CREATOR NAME</label>
                  <input
                    id="gateway-artist-name"
                    name="artistName"
                    type="text"
                    required
                    value={userData.artistName}
                    onChange={(e) => setUserData({ ...userData, artistName: e.target.value })}
                    style={{ ...inputStyle, ...fontReset }}
                  />
                </div>

                <div>
                  <label htmlFor="gateway-regular-email" style={{ ...labelStyle, ...fontReset }}>EMAIL</label>
                  <input
                    id="gateway-regular-email"
                    name="regularEmail"
                    type="email"
                    required
                    value={userData.regularEmail}
                    onChange={(e) => setUserData({ ...userData, regularEmail: e.target.value })}
                    style={{ ...inputStyle, ...fontReset }}
                  />
                </div>

                <div>
                  <label htmlFor="gateway-business-email" style={{ ...labelStyle, ...fontReset }}>BUSINESS EMAIL (OPTIONAL)</label>
                  <input
                    id="gateway-business-email"
                    name="businessEmail"
                    type="email"
                    value={userData.businessEmail}
                    onChange={(e) => setUserData({ ...userData, businessEmail: e.target.value })}
                    style={{ ...inputStyle, ...fontReset }}
                  />
                </div>

                <div>
                  <label htmlFor="gateway-phone-number" style={{ ...labelStyle, ...fontReset }}>PHONE NUMBER (SMS VERIFICATION REQUIRED)</label>
                  <div style={{ display: 'flex' }}>
                    <span style={{ padding: '12px 14px', backgroundColor: '#1a1a1a', border: '1px solid #282828', borderRight: 'none', color: '#888888', borderRadius: '4px 0 0 4px', fontSize: '14px', ...fontReset }}>
                      +1
                    </span>
                    <input
                      id="gateway-phone-number"
                      name="phone"
                      type="tel"
                      required
                      placeholder="(000) 000-0000"
                      value={userData.phone}
                      onChange={(e) => setUserData({ ...userData, phone: e.target.value })}
                      style={{ ...inputStyle, borderRadius: '0 4px 4px 0', ...fontReset }}
                    />
                  </div>
                </div>

                <button type="submit" style={{ ...primaryBtnStyle, ...fontReset }}>
                  Ping Device &amp; Send Code
                </button>
              </form>
            )}

            {/* PERMANENT OVERRIDE UNTIL MANUALLY REVERTED — the 6-digit device
                handshake screen. Unreachable while step is pinned to 1 (the
                only setStep(2) call lives in the commented handleInitiateSms).
                Supabase + Twilio handshake disabled by user command.
                DO NOT RE-ENABLE UNTIL EXPLICITLY REQUESTED. */}
            {step === 2 && (
              <form onSubmit={handleVerifyCode} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
                <p style={{ fontSize: '14px', color: '#AAAAAA', textAlign: 'center', margin: '0 0 10px 0', ...fontReset }}>
                  Verification pin sent to <strong>+1 {userData.phone}</strong>
                </p>
                <div>
                  <label htmlFor="gateway-verification-code" style={{ ...labelStyle, textAlign: 'center', marginBottom: '8px', ...fontReset }}>ENTER 6-DIGIT CODE</label>
                  <input
                    id="gateway-verification-code"
                    name="verificationCode"
                    type="text"
                    maxLength={6}
                    required
                    placeholder="000000"
                    value={verificationCode}
                    onChange={(e) => setVerificationCode(e.target.value)}
                    style={{ ...inputStyle, textAlign: 'center', fontSize: '24px', letterSpacing: '6px', ...fontReset }}
                  />
                </div>

                <button type="submit" style={{ ...primaryBtnStyle, ...fontReset }}>
                  Verify Device &amp; Enter Your World
                </button>

                <button
                  type="button"
                  onClick={() => { setStep(1); setErrorMsg(''); }}
                  style={{ background: 'none', border: 'none', color: '#666666', fontSize: '12px', cursor: 'pointer', marginTop: '4px', ...fontReset }}
                >
                  Change Phone Number
                </button>
              </form>
            )}
          </div>
        )}

        {/* YOUR WORLD VIEW */}
        {activeTab === 'world' && (
          <div style={{ maxWidth: '800px', margin: '0 auto', textAlign: 'center' }}>
            <h1 style={{ fontSize: '42px', fontWeight: 'bold', margin: '0 0 8px 0', color: '#FFFFFF', ...fontReset }}>Enter Your World.</h1>
            <p style={{ color: '#00FF66', fontSize: '12px', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: '36px', ...fontReset }}>
              Covnant Ledger Handshake Active &amp; Verified
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', textAlign: 'left' }}>
              <div style={cardStyle}>
                <p style={{ ...cardLabelStyle, ...fontReset }}>Creator Profile</p>
                <h2 style={{ fontSize: '22px', margin: '0 0 6px 0', fontWeight: 'bold', color: '#FFFFFF', ...fontReset }}>{userData.artistName}</h2>
                <p style={{ fontSize: '14px', color: '#888888', margin: 0, ...fontReset }}>Legal Name: {userData.legalName}</p>
              </div>

              <div style={cardStyle}>
                <p style={{ ...cardLabelStyle, ...fontReset }}>Verified Routing</p>
                <p style={{ margin: '0 0 6px 0', fontSize: '14px', color: '#FFFFFF', ...fontReset }}>Email: {userData.regularEmail}</p>
                {userData.businessEmail && (
                  <p style={{ margin: '0 0 6px 0', fontSize: '14px', color: '#888888', ...fontReset }}>Biz Email: {userData.businessEmail}</p>
                )}
                <p style={{ margin: 0, fontSize: '14px', color: '#00FF66', ...fontReset }}>Phone: +1 {userData.phone} (SMS VERIFIED)</p>
              </div>
            </div>

            {/* PRIMARY ACTION — the verified workspace entry point */}
            <button
              type="button"
              onClick={() => router.push('/dashboard')}
              style={{ ...primaryBtnStyle, maxWidth: '360px', margin: '36px auto 0 auto', display: 'block', ...fontReset }}
            >
              Enter the Workspace
            </button>
          </div>
        )}

        {/* CEO ADMIN VAULT */}
        {activeTab === 'admin' && <CovnantAdminVault />}

      </main>
    </div>
  );
}

/**
 * Self-fetching vault: no row props ever cross this boundary. On activation it
 * calls fetchAdminLedger and renders the loading, empty, access-denied, or
 * table state — the server's admin gate (GET /api/admin/ledger) decides which.
 */
function CovnantAdminVault() {
  const [load, setLoad] = useState<AdminVaultLoad>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchAdminLedger()
      .then((records) => {
        if (!cancelled) setLoad({ status: 'ready', records });
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: 'denied' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (load.status === 'loading') {
    return (
      <div style={{ padding: '40px', backgroundColor: '#0d0d0d', border: '1px solid #1a1a1a', textAlign: 'center', color: '#666666', borderRadius: '6px', ...fontResetModule }}>
        Loading live records from the Covnant ledger...
      </div>
    );
  }

  if (load.status === 'denied') {
    return (
      <div style={{ textAlign: 'center', padding: '60px 20px' }}>
        <h2 style={{ color: '#FF3333', fontSize: '20px', margin: '0 0 8px 0', ...fontResetModule }}>403 — ACCESS DENIED</h2>
        <p style={{ color: '#888888', fontSize: '14px', ...fontResetModule }}>Covnant CEO authentication required to view system ledger.</p>
      </div>
    );
  }

  return (
    <div style={{ width: '100%' }}>
      <div style={{ borderBottom: '1px solid #1a1a1a', paddingBottom: '16px', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 'bold', margin: '0 0 4px 0', color: '#FFFFFF', ...fontResetModule }}>COVNANT MASTER ADMIN VAULT</h2>
        <p style={{ color: '#888888', fontSize: '13px', margin: 0, ...fontResetModule }}>Live User &amp; Telemetry Database Records</p>
      </div>

      {load.records.length === 0 ? (
        <div style={{ padding: '40px', backgroundColor: '#0d0d0d', border: '1px solid #1a1a1a', textAlign: 'center', color: '#666666', borderRadius: '6px', ...fontResetModule }}>
          No live records captured in database yet.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #282828', color: '#888888', fontSize: '11px', textTransform: 'uppercase' }}>
                <th style={{ ...thStyle, ...fontResetModule }}>TIMESTAMP</th>
                <th style={{ ...thStyle, ...fontResetModule }}>LEGAL NAME</th>
                <th style={{ ...thStyle, ...fontResetModule }}>ARTIST NAME</th>
                <th style={{ ...thStyle, ...fontResetModule }}>EMAIL</th>
                <th style={{ ...thStyle, ...fontResetModule }}>BIZ EMAIL</th>
                <th style={{ ...thStyle, ...fontResetModule }}>PHONE</th>
                <th style={{ ...thStyle, ...fontResetModule }}>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {load.records.map((item, idx) => (
                <tr key={item.id || idx} style={{ borderBottom: '1px solid #141414' }}>
                  <td style={{ ...tdStyle, ...fontResetModule }}>{item.createdAt || item.verifiedAt || 'JUST NOW'}</td>
                  <td style={{ ...tdStyle, ...fontResetModule }}>{item.legalName || item.legal_name}</td>
                  <td style={{ ...tdStyle, ...fontResetModule }}>{item.artistName || item.artist_name}</td>
                  <td style={{ ...tdStyle, ...fontResetModule }}>{item.regularEmail || item.regular_email}</td>
                  <td style={{ ...tdStyle, ...fontResetModule }}>{(item.businessEmail || item.business_email) || '—'}</td>
                  <td style={{ ...tdStyle, ...fontResetModule }}>+1 {item.phone}</td>
                  <td style={{ ...tdStyle, ...fontResetModule, color: item.phoneVerified || item.phone_verified ? '#00FF66' : '#FFCC00' }}>
                    {item.phoneVerified || item.phone_verified ? 'VERIFIED' : 'PENDING'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Inlined Style System
const containerStyle: CSSProperties = { backgroundColor: '#000000', color: '#FFFFFF', minHeight: '100vh' };
const headerStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 32px', borderBottom: '1px solid #141414' };
const navBtnStyle: CSSProperties = { background: 'none', border: 'none', fontWeight: 'bold', fontSize: '14px', cursor: 'pointer', outline: 'none' };
const labelStyle: CSSProperties = { display: 'block', fontSize: '11px', color: '#888888', marginBottom: '6px', letterSpacing: '0.5px' };
const inputStyle: CSSProperties = { width: '100%', padding: '12px', backgroundColor: '#0d0d0d', border: '1px solid #222222', color: '#FFFFFF', borderRadius: '4px', boxSizing: 'border-box', outline: 'none' };
const primaryBtnStyle: CSSProperties = { width: '100%', padding: '14px', backgroundColor: '#FFFFFF', color: '#000000', border: 'none', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px', cursor: 'pointer', borderRadius: '4px', marginTop: '8px' };
const cardStyle: CSSProperties = { backgroundColor: '#0d0d0d', border: '1px solid #1a1a1a', padding: '24px', borderRadius: '6px' };
const cardLabelStyle: CSSProperties = { fontSize: '11px', color: '#888888', margin: '0 0 12px 0', textTransform: 'uppercase', letterSpacing: '1px' };
const thStyle: CSSProperties = { padding: '12px 8px' };
const tdStyle: CSSProperties = { padding: '14px 8px', fontSize: '13px', color: '#FFFFFF' };

// Shared font reset for both components (hoisted so the vault needs no props).
const fontResetModule: CSSProperties = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  WebkitFontSmoothing: 'antialiased',
  MozOsxFontSmoothing: 'grayscale',
  boxSizing: 'border-box',
};
