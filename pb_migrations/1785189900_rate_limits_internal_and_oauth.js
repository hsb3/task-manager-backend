/// <reference path="../pb_data/types.d.ts" />
// hosted-mcp-endpoint rate limits: the internal caller's sentinel address is excluded, and /oauth/ is limited per address.
migrate((app) => {
  const s = app.settings()
  const sentinel = "192.0.2.254"
  const ips = s.rateLimits.excludedIPs.slice()
  if (!ips.includes(sentinel)) s.rateLimits.excludedIPs = ips.concat([sentinel])
  const rules = s.rateLimits.rules.slice()
  if (!rules.some((r) => r.label === "/oauth/")) {
    s.rateLimits.rules = rules.concat([{ label: "/oauth/", maxRequests: 30, duration: 60, audience: "" }])
  }
  app.save(s)
}, (app) => {
  // No-op down: settings are re-established on any fresh boot from the migration set.
})
