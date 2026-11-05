/// <reference path="../pb_data/types.d.ts" />
// Enable MFA + email OTP for superusers. Kept as the final, separately-named
// file so the e2e/battery clean rooms can drop it by filename to bypass the
// second factor.
migrate((app) => {
  const c = app.findCollectionByNameOrId("_superusers")
  c.mfa.enabled = true
  c.mfa.duration = 1800
  c.otp.enabled = true
  c.otp.duration = 300
  c.otp.length = 8
  app.save(c)
}, (app) => {
  const c = app.findCollectionByNameOrId("_superusers")
  c.mfa.enabled = false
  c.otp.enabled = false
  app.save(c)
})
