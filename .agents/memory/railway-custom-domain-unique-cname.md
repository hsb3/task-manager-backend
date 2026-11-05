---
name: railway-custom-domain-unique-cname
description: "Every Railway custom domain gets its own unique CNAME target, even when the same hostname is re-added to another service, so the DNS record must be updated on every re-add"
metadata:
  type: reference
---

Re-adding a hostname to a different service issues a NEW CNAME target, so a DNS record written
for an earlier add does not carry over. functionform.ai DNS is managed with the Cloudflare token in
`~/.cloudflared/cert.pem`.

**How to apply:** after adding or moving a custom domain, read the target Railway shows for it
and update the CNAME at the registrar before testing the hostname.
