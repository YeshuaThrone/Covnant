import { describe, expect, it } from "vitest";
import { COVENANT_HTTP_MOUNTS, covenantMountPath } from "./app";
import { covenantRouters } from "./routers";

describe("Covenant HTTP app mounts", () => {
  it("matches the Express modular endpoint map", () => {
    const paths = COVENANT_HTTP_MOUNTS.flatMap((mount) =>
      mount.routes.map((route) => ({
        router: mount.router,
        method: route.method,
        path: covenantMountPath(mount, route),
      })),
    );

    expect(paths).toEqual([
      { router: "works", method: "POST", path: "/api/v1/works" },
      { router: "works", method: "GET", path: "/api/v1/works" },
      { router: "sweep-direct", method: "POST", path: "/api/v1/sweeper" },
      { router: "sweep-async", method: "POST", path: "/api/v1/sweeper/async" },
      { router: "luminate", method: "POST", path: "/api/v1/sweeper/luminate" },
    ]);
    expect(Object.keys(covenantRouters)).toEqual([
      "works",
      "sweepDirect",
      "sweepAsync",
      "luminate",
    ]);
  });
});
