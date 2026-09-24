# Sandbox testing & go-live (contract v1)

## One-time Paddle account setup (per environment)

1. Sandbox account at sandbox-vendors.paddle.com; live account at vendors.paddle.com (after approval).
2. Developer tools → Authentication → **API key** (`pdl_sdbx_apikey_…` / `pdl_live_apikey_…`)
   with permissions: products, prices, discounts, customers, transactions, subscriptions,
   adjustments, notification settings (read + write), customer portal sessions (write).
3. Developer tools → Authentication → **Client-side token** (`test_…` / `live_…`).
4. Checkout → Checkout settings → **Default payment link** = `https://<domain>/pay` (a page
   that loads Paddle.js; the skills create it).
5. Checkout settings → approved **domains** (live).
6. Live only: request tax categories other than `standard` (Catalog → Tax categories →
   "Get approval for new category"). Needed for `saas`, `digital-goods`, `ebooks`.

## Sandbox loop

```bash
cp <core>/templates/env.example .env            # fill PADDLE_API_KEY, PADDLE_CLIENT_TOKEN
cloudflared tunnel --url http://localhost:3000  # copy the https URL
# .env: PADDLE_WEBHOOK_URL=https://<tunnel>/webhooks/paddle
node scripts/paddle-sync.mjs                    # creates catalog + webhook, fills secret
node scripts/paddle-sync.mjs check
```

Test cards (sandbox): `4242 4242 4242 4242` succeeds; `4000 0027 6000 3184` needs 3DS;
`4000 0000 0000 0002` is declined. Any future expiry and any CVC. If one stops working,
check Paddle's current list at developer.paddle.com → "Test cards".

### Minimum test matrix (every project, every stack)

Subscription:
- [ ] New account → checkout with trial → `trialing`, trial badge gone for this account and email afterwards
- [ ] Same account/email again → checkout gets the non-trial price
- [ ] Promo code in the app field → discount on the transaction; invalid code → a clear reason
- [ ] Promo code typed inside the overlay → recorded on the subscription
- [ ] Upgrade with preview → prorated charge matches the preview
- [ ] Cancel → "cancels on <date>", still entitled; resume → cancellation removed
- [ ] Simulate `subscription.past_due` → banner; portal `update_payment` link works
- [ ] Simulate `subscription.canceled` → access removed
- [ ] Team: buy 3 seats, assign 3, 4th assign blocked, increase seats with preview
- [ ] Admin refund → `pending_approval` shown; `adjustment.updated` approved → status updates
- [ ] Replay the same webhook twice → second is `webhook_duplicate`, no double effects
- [ ] Stop the app, complete a checkout, start the app → webhook retry or reconciliation fixes it

One-time:
- [ ] Guest buys → email with a link → download works, counter increments, limit enforced
- [ ] Logged-in buy → library shows it; buying the same item again → `409 already_owned`
- [ ] Quantity 3 license keys → 3 unique keys
- [ ] Full refund approved → entitlement revoked, download returns 410
- [ ] Partial refund of one line item → only that item revoked
- [ ] Tampered/expired download token → 410

## Go-live checklist

- [ ] Paddle approved the live account and domain; tax categories approved (or products use `standard`)
- [ ] Production `.env` has **live** keys; `PADDLE_ENV=production`; `APP_BASE_URL` https
- [ ] `node scripts/paddle-sync.mjs --env-file .env.production plan` reviewed, then applied (asks "yes")
- [ ] `… check` passes on the production server
- [ ] Default payment link set in the **live** dashboard
- [ ] The webhook URL is reachable from the internet, and the proxy passes the raw body through
- [ ] Server clock is NTP-synced
- [ ] The reconciliation job is running (log line at boot)
- [ ] One real purchase with a real card, then refund it from the admin UI
- [ ] `billing_events` shows the full trail for that purchase
