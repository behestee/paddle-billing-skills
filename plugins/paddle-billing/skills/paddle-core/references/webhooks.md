# Webhooks (contract v1)

Endpoint: `POST /webhooks/paddle`. Paddle expects a 2xx response within **5 seconds**,
otherwise it retries (with backoff, for up to about 3 days in production). The webhook
is the **only** thing that grants or removes access. The browser's `checkout.completed`
event just means "start polling status".

## 1. Receive the raw body

Signature verification needs the **exact bytes** Paddle sent. Register the route
*before* any JSON body parser, or use the framework's raw-body escape hatch (see
`stacks/<stack>.md`). Never re-serialise parsed JSON to verify it.

## 2. Verify `Paddle-Signature`

Header: `Paddle-Signature: ts=1671552777;h1=eb4d0d…[;h1=…]` (more than one `h1` appears
during secret rotation).

```
parts      = header.split(";") -> key=value pairs
ts         = parts["ts"]                     (required, integer seconds)
signatures = every value whose key is "h1"   (at least one)
reject if |now_seconds - ts| > PADDLE_WEBHOOK_TOLERANCE_SEC (default 5)
signed     = ts + ":" + raw_body             (bytes, UTF-8)
expected   = hex( HMAC_SHA256(key = PADDLE_WEBHOOK_SECRET, msg = signed) )
valid      = any( constant_time_equals(expected, h1) for h1 in signatures )
```

Invalid → `400` and log `webhook_failed` with reason `bad_signature` (no payload stored).
The secret is the full `pdl_ntfset_…` string, used as-is.

## 3. Deduplicate, store, respond

```
event = json.parse(raw_body)          # { event_id, event_type, occurred_at, notification_id, data }
INSERT INTO paddle_webhook_events (event_id, event_type, occurred_at, paddle_env, payload)
  ON CONFLICT (event_id) DO NOTHING
if the row already existed AND status in (processed, ignored):
    audit webhook_duplicate; return 200
audit webhook_received
try:
    route(event)                      # §4, inside one DB transaction
    mark processed (or ignored)
    return 200 {"received": true}
except error:
    mark failed, attempts += 1, error = message
    audit webhook_failed
    return 500                        # Paddle retries
```

If a handler might take longer than about 3 s (for example sending emails with
attachments), commit the DB changes, return 200, and do the slow part in a job queue or
background task. Email sending must never decide the HTTP status.

## 4. Routing

| Event | Handler |
|---|---|
| `subscription.created`, `.updated`, `.activated`, `.trialing`, `.past_due`, `.paused`, `.resumed`, `.canceled` | `subscriptions.sync_from_paddle(data, occurred_at, source="webhook")` |
| `transaction.completed` with `data.subscription_id` null | `purchases.fulfill(data)` (one-time) |
| `transaction.completed` with `data.subscription_id` set | nothing extra (the subscription events carry the state). Optionally record for invoices |
| `transaction.payment_failed` | audit only (the subscription goes `past_due` via its own event) |
| `adjustment.created`, `adjustment.updated` | `refunds.on_adjustment(data)` |
| `discount.created`, `discount.updated` | `discounts.on_paddle_update(data)` — refresh `times_used`, `status`. Never overwrite app-owned fields |
| `customer.updated` | update `billing_customers.email` if it's our customer |
| anything else | mark `ignored` |

Ignore (mark `ignored`, return 200) any entity whose `custom_data.app` exists and differs
from this app's `app`, so shared Paddle accounts don't cross-talk. Transactions and
subscriptions without `custom_data.app` are still processed if we know the customer.

## 5. Ordering

Paddle doesn't guarantee delivery order. For subscriptions:

```
if local.last_event_at is not null and event.occurred_at < local.last_event_at:
    audit subscription_stale_event_ignored; mark ignored; return
apply; local.last_event_at = event.occurred_at
```

`subscription.created` may arrive after `subscription.updated`. The sync is an upsert, so
the order doesn't matter beyond the guard above.

## 6. Attribution (whose subscription / purchase is this?)

In order of trust:
1. `data.custom_data.account_id` (plus `team_id`), which we set on the checkout transaction and which the subscription inherits.
2. `billing_customers` lookup by `data.customer_id` for the current `paddle_env`.
3. Neither → store with `account_id = 'unattributed:<customer_id>'`, audit `customer_id_repaired` with `attributedVia: "none"` and surface it in the admin billing log. Never drop a paid event.

If (1) resolves an account whose `billing_customers` row has a *different*
`paddle_customer_id` for this env, repoint the row to `data.customer_id` and audit
`customer_id_repaired`. This is the self-heal for "Paddle created its own customer".

## 7. Local testing

- Sandbox: run `paddle-sync` with `PADDLE_WEBHOOK_URL` pointing at a tunnel
  (`cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`). Sandbox
  destinations are created with `traffic_source: "all"` so the **webhook simulator**
  (Dashboard → Developer tools → Simulations) reaches you too.
- Tunnel URLs change on each start; re-run `paddle-sync --only webhook` after updating
  `PADDLE_WEBHOOK_URL`. The destination is found by URL, so a new URL creates a new
  destination. Archive old ones in the dashboard occasionally.
- Unit test the verifier with a fixed secret/ts/body and a known HMAC (the same vector
  in every stack):
  - secret `pdl_ntfset_test_secret`, ts `1700000000`, body `{"event_id":"evt_1"}`
  - signed string `1700000000:{"event_id":"evt_1"}`
  - header `ts=1700000000;h1=3ca149782497b5c91447ffbb6950f9398efb95a8ebe4229fb05e9181780d61c2` → **valid** (clock injected at 1700000000)
  - same header with the body changed by one byte → invalid
  - same header, clock at 1700000010 (tolerance 5) → invalid (too old)
  - header `ts=1700000000;h1=deadbeef;h1=3ca1497…61c2` → valid (rotation: any h1 matches)
