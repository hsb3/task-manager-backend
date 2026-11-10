/// <reference path="../pb_data/types.d.ts" />
// decision:rate-limit-counts-x-real-ip: the limiter counts the rightmost X-Real-IP, the address Railway's edge sets.
migrate((app) => {
  const s = app.settings()
  s.trustedProxy = { headers: ["X-Real-IP"], useLeftmostIP: false }
  app.save(s)
}, (app) => {
  // No-op down: settings are re-established on any fresh boot from the migration set.
})
