/// <reference path="../pb_data/types.d.ts" />
// Security headers for the account app's static files under /account (openspec account-spa contract).

require(`${__hooks}/lib/routes.js`).use((e) => {
  const m = e.request.method;
  const p = e.request.url.path;
  if (
    (m === "GET" || m === "HEAD") &&
    (p === "/account" || p.startsWith("/account/"))
  ) {
    const h = e.response.header();
    h.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    h.set("X-Frame-Options", "DENY");
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "no-referrer");
    h.set(
      "Cache-Control",
      p.startsWith("/account/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
  }
  return e.next();
});
