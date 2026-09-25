/**
 * Express paste composition, without an Express runtime.
 *
 *   app.use('/api/v1/works', workRoutes);
 *   app.use('/api/v1/sweeper', sweepDirectRoutes);
 *   app.use('/api/v1/sweeper', sweepAsyncRoutes);
 *   app.use('/api/v1/sweeper', luminateRoutes);
 *
 * EmeraldVal serves the same mounts via Next.js App Router.
 * This file is the mount table only — importing it must not load the
 * route handlers (that created a Vercel collect-page-data cycle).
 */

export const COVENANT_HTTP_MOUNTS = [
  {
    mount: "/api/v1/works",
    router: "works",
    routes: [
      { method: "POST", path: "/" },
      { method: "GET", path: "/" },
    ],
  },
  {
    mount: "/api/v1/sweeper",
    router: "sweep-direct",
    routes: [{ method: "POST", path: "/" }],
  },
  {
    mount: "/api/v1/sweeper",
    router: "sweep-async",
    routes: [{ method: "POST", path: "/async" }],
  },
  {
    mount: "/api/v1/sweeper",
    router: "luminate",
    routes: [{ method: "POST", path: "/luminate" }],
  },
] as const;

export function covenantMountPath(
  mount: (typeof COVENANT_HTTP_MOUNTS)[number],
  route: (typeof COVENANT_HTTP_MOUNTS)[number]["routes"][number],
): string {
  if (route.path === "/") {
    return mount.mount;
  }
  return `${mount.mount}${route.path}`;
}
