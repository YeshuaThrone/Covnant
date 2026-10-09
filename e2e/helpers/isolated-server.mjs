/**
 * Isolated admin-server harness shared by the gate/mutation e2e specs
 * (admin.spec.ts, mul-registry.spec.ts).
 *
 * A private-port `next start` with the Supabase boundary pointed at
 * e2e/helpers/postgrest-stub.mjs: the gate, routes, validation, and audit
 * logic all run for real — only the PostgREST boundary is stubbed
 * (CI/sandbox has no database). The shared webServer from
 * playwright.config.ts keeps its env untouched so every other spec's
 * Supabase-less behavior is unchanged.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

export const ADMIN_E2E_PASSWORD =
  process.env.ADMIN_DASHBOARD_PASSWORD ?? 'e2e-admin-test-password';

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function startIsolatedServer() {
  const appPort = await freePort();
  const stubPort = await freePort();

  // Flake diagnosis: tee the stub's output to a file when STUB_LOG is set.
  const stubStdio = process.env.STUB_LOG
    ? ['ignore', fs.openSync(process.env.STUB_LOG, 'a'), fs.openSync(process.env.STUB_LOG, 'a')]
    : ['ignore', 'pipe', 'pipe'];
  const stub = spawn('node', ['./e2e/helpers/postgrest-stub.mjs'], {
    env: {
      ...process.env,
      PORT: String(stubPort),
      STUB_VERBOSE: process.env.STUB_VERBOSE ?? '',
    },
    stdio: stubStdio,
    // Group leaders: teardown below signals the whole process group, because
    // `npx next start` re-execs into a detached next-server grandchild that
    // survives a plain parent kill — leaked servers then starve later boots.
    detached: true,
  });

  const app = spawn('npx', ['next', 'start', '-p', String(appPort)], {
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${stubPort}`,
      SUPABASE_SERVICE_ROLE_KEY: 'e2e-stub-service-role-key',
      // The Store seam (the /mul page's read path) requires the anon key as
      // well — the /admin routes only need the service-role key.
      SUPABASE_ANON_KEY: 'e2e-stub-anon-key',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'e2e-stub-anon-key',
      ADMIN_DASHBOARD_PASSWORD: ADMIN_E2E_PASSWORD,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  const bootLog = [];
  app.stdout?.on('data', (chunk) => bootLog.push(chunk.toString()));
  app.stderr?.on('data', (chunk) => bootLog.push(chunk.toString()));

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              `isolated admin server on :${appPort} never became ready (exit ${app.exitCode}): ${bootLog.join('')}`,
            ),
          ),
        30_000,
      );
      timeout.unref?.();
      const probe = async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${appPort}/admin`);
          if (response.status === 200) {
            clearTimeout(timeout);
            resolve(undefined);
            return;
          }
        } catch {
          // not up yet — keep probing
        }
        setTimeout(probe, 500).unref?.();
      };
      probe();
    });
  } catch (error) {
    // The app never came up — surface the child's own boot output and exit
    // code so the failure names itself instead of timing out blind, and
    // stop the children so a failed boot does not leak servers.
    if (app.pid) process.kill(-app.pid, 'SIGTERM');
    if (stub.pid) process.kill(-stub.pid, 'SIGTERM');
    throw error;
  }

  return {
    baseUrl: `http://127.0.0.1:${appPort}`,
    stubPort,
    close: async () => {
      const stopped = new Promise((resolve) => {
        app.once('exit', () => resolve(undefined));
        stub.once('exit', () => resolve(undefined));
      });
      // Negative-PID signals hit the whole process group — the only way the
      // detached next-server grandchild actually dies with its wrapper.
      if (app.pid) process.kill(-app.pid, 'SIGTERM');
      if (stub.pid) process.kill(-stub.pid, 'SIGTERM');
      await stopped;
    },
  };
}
