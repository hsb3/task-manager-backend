/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const s = app.settings()

  s.rateLimits.enabled = true
  s.rateLimits.excludedIPs = []
  s.rateLimits.rules = [
    {
      "label": "POST /api/collections/users/auth-with-password",
      "audience": "",
      "duration": 60,
      "maxRequests": 10
    },
    {
      "label": "POST /api/collections/_superusers/auth-with-password",
      "audience": "",
      "duration": 60,
      "maxRequests": 10
    },
    {
      "label": "POST /api/collections/users/request-otp",
      "audience": "",
      "duration": 60,
      "maxRequests": 5
    },
    {
      "label": "POST /api/collections/_superusers/request-otp",
      "audience": "",
      "duration": 60,
      "maxRequests": 5
    },
    {
      "label": "/api/",
      "audience": "",
      "duration": 60,
      "maxRequests": 300
    },
    {
      "label": "POST /api/collections/users/records",
      "audience": "",
      "duration": 60,
      "maxRequests": 5
    }
  ]

  s.trustedProxy = { headers: ["X-Forwarded-For"], useLeftmostIP: true }

  s.batch.enabled = true
  s.batch.maxRequests = 50
  s.batch.timeout = 3

  app.save(s)
}, (app) => {
  // No-op down: settings are re-established on any fresh boot from this file.
})
