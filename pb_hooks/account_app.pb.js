/// <reference path="../pb_data/types.d.ts" />
// Security headers for the account app's static files under /account (openspec account-spa contract).

require(`${__hooks}/lib/routes.js`).use((e) => {
  const m = e.request.method;
  const p = e.request.url.path;
  if (m !== "GET" && m !== "HEAD") return e.next();
  // The static handler resolves a (percent-encoded) dot segment itself, so such a path could reach /account without the check below.
  if (
    e.request.pattern === "GET /{path...}" &&
    p.split("/").some((s) => s === "." || s === "..")
  ) {
    throw new NotFoundError("File not found.");
  }
  if (p !== "/account" && !p.startsWith("/account/")) return e.next();
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
  try {
    return e.next();
  } catch (err) {
    // A missing file is an error answer written after this returns; it must not be cached as immutable.
    h.set("Cache-Control", "no-cache");
    throw err;
  }
});
