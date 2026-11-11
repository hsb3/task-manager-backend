/// <reference path="../pb_data/types.d.ts" />
// Exempts the MCP service's calls, recognised by a shared secret, from the per-address rate limits.

// Priority -1040 runs before PB's rate limiter (-1000), which reads X-Real-IP at call time.
require(`${__hooks}/lib/routes.js`).use(
  new Middleware(
    (e) => {
      // Must equal the rateLimits.excludedIPs entry; tests/test_internal_caller.ts goes red if not.
      const SENTINEL = "192.0.2.254";
      const h = e.request.header;
      const sent = h.get("X-TM-Internal");
      h.del("X-TM-Internal");
      const secret = $os.getenv("MCP_INTERNAL_SECRET");
      if (secret && sent && $security.equal(sent, secret)) {
        h.set("X-Real-IP", SENTINEL);
      } else if (
        h.values("X-Real-IP").some((v) =>
          String(v)
            .split(",")
            .some((t) => t.trim() === SENTINEL),
        )
      ) {
        h.del("X-Real-IP");
      }
      return e.next();
    },
    -1040,
    "tmInternalCaller",
  ),
);
