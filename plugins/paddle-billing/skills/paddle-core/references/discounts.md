# Discounts & promo codes (contract v1)

**Direction: app → Paddle.** The app (catalog file in fixed mode, admin UI in dynamic
mode) owns every promo code. Paddle is the enforcement engine at checkout. Paddle webhooks
only feed back `times_used` and `status`.

## Fixed mode

- Discounts live in `paddle.catalog.json` → `discounts[]`, pushed by `paddle-sync`.
- On app boot, `discounts.load_fixed()` upserts the catalog discounts into
  `billing_discounts` (with `paddle_discount_id` from `PADDLE_DISCOUNT_<KEY>`,
  `sync_status='synced'`), so validation and the admin list work the same in both modes.
- The admin UI shows fixed-mode discounts **read-only**, with the note "edit
  paddle.catalog.json and run paddle-sync".

## Dynamic mode (admin CRUD)

Admin endpoints (contract §7): `GET/POST /api/admin/billing/discounts`,
`PATCH /api/admin/billing/discounts/:key`, `POST …/:key/archive`, `POST …/:key/resync`.

Admin form fields = catalog discount fields (`code, description, type, amount, currency,
recur, maxRecurringIntervals, usageLimit, restrictTo[keys], expiresAt, enabled`).
Validation is the same as the script's (see catalog-schema.md), plus: `code` must be
unique among active discounts (the DB partial unique index).

Write path, always the same:
```
BEGIN
  upsert billing_discounts row, sync_status = 'pending'
  audit discount_created / discount_updated
COMMIT
push(discount):                      # outside the DB transaction
  body = to_paddle(discount)         # identical mapping to paddle-sync's bodyFor()
  if paddle_discount_id: PATCH /discounts/{id} body
  else: POST /discounts body -> store paddle_discount_id
  sync_status = 'synced', synced_at = now, sync_error = null
on error:
  sync_status = 'failed', sync_error = "<code>: <detail> (request_id …)"
  audit discount_sync_failed
  the admin UI shows a red "Not synced — Retry" badge (POST …/resync)
```
A retry job every 10 minutes re-pushes `pending`/`failed` rows older than 1 minute.

`to_paddle` mapping (must match the scripts exactly):

| Paddle field | Value |
|---|---|
| `description` | description |
| `type` | type |
| `amount` | percentage: the number as a string (`"50"`, `"12.5"`); flat: minor units string |
| `currency_code` | null for percentage, else currency |
| `code` | upper-case code |
| `enabled_for_checkout` | enabled |
| `recur` / `maximum_recurring_intervals` | recur / (recur ? maxRecurringIntervals : null) |
| `usage_limit` | usageLimit or null |
| `restrict_to` | keys → IDs: product key → product id; price key → price id **and its `_trial` variant id**; null = unrestricted |
| `expires_at` | RFC 3339 UTC or null |
| `custom_data` | `{ app, app_key: key }` |
| archive | `PATCH { status: "archived" }` |

When a price is superseded (price change), every discount whose `restrictTo` includes
that price key (or its product key) is re-pushed so `restrict_to` points at the new ID.
The script does this automatically; dynamic mode's `catalog_sync` must do it too.

## Validation endpoint

`POST /api/billing/discounts/validate { code, priceKeys }` powers the "Apply" button on
your own pricing / checkout pages:

```
d = billing_discounts WHERE upper(code) = upper(?) AND status = 'active'
not found / sync_status != 'synced'        -> { valid:false, reason:"not_found" }
not d.enabled                              -> "disabled"
d.expires_at and d.expires_at < now        -> "expired"
d.usage_limit and d.times_used >= limit    -> "used_up"
d.restrict_to and no priceKey (or its product key) is in it -> "not_applicable"
else { valid:true, discount:{ code, type, amount (display units), currency, recur, maxRecurringIntervals } }
```
Rate-limit this endpoint (for example 10/min per IP) to stop code guessing.

## Applying a code at checkout

- The server resolves `discountCode` → `paddle_discount_id` (after the same validation)
  and sets `discount_id` on the draft transaction. The browser never sends a discount id.
- If `checkout.allowDiscountEntry` is true, customers can also type a code inside the
  Paddle overlay. That works because every code exists in Paddle.
- The webhook records `discount_id` from the transaction/subscription on
  `billing_purchases` / `billing_subscriptions`.

## Webhook feedback

`discount.created` / `discount.updated`: find the row by `paddle_discount_id`. Update
`times_used`, and set `status = archived` if Paddle archived it. **Don't** overwrite
code/amount/etc. (the app owns those). If they differ from the app's values, someone
edited it in the Paddle dashboard: audit `discount_updated` with `detail.driftFromPaddle`
and re-push the app's values.
