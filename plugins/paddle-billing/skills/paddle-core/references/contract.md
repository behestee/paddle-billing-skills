# Paddle Billing Contract — v1

This is the **single source of truth** for every Paddle integration built with the
`paddle-billing` skills. Every stack (Node, Next.js, FastAPI, Laravel, Spring, GeneXus)
implements exactly this contract. Code may be idiomatic per language; **names, shapes,
paths, statuses and rules may not differ.** If a project needs something outside the
contract, add it as an extension next to the contract code, never by changing contract
names.

Contents
1. Fixed decisions (never ask the user)
2. The project manifest: `paddle.catalog.json`
3. Environment variables
4. Keys, IDs and `custom_data` conventions
5. Paddle REST client rules
6. Canonical module layout
7. HTTP endpoint contract
8. Status semantics & entitlement
9. Money
10. Audit log event types

---

## 1. Fixed decisions (never ask the user)

These were decided once, for all projects. Do not re-open them.

| Topic | Decision |
|---|---|
| Paddle API access | **Raw REST via a thin client** (see §5) in every stack — not the language SDKs. Field names in this contract are Paddle's raw `snake_case` JSON, identical everywhere. |
| Checkout creation | **Server creates a draft transaction** (`POST /transactions`) and returns its `transactionId`; the browser opens `Paddle.Checkout.open({ transactionId })`. The browser never chooses price IDs, trial eligibility, discounts or `custom_data`. |
| Source of truth for state | **Webhooks + periodic reconciliation**. Never trust the browser's `checkout.completed` event to grant access. |
| Source of truth for catalog & discounts | **The app** (catalog file in fixed mode, app DB in dynamic mode) → pushed to Paddle. Paddle dashboard edits to app-managed entities are overwritten on the next sync. |
| Price → plan mapping | Read `price.custom_data.app_key` from the payload first, then fall back to the env/DB ID lookup. An unmapped price **never** downgrades anyone: keep the previous plan, log `price_mapping_failed`. |
| Price changes | Never PATCH `unit_price` on an existing price. Create a new price with the same `app_key`, archive the old one, and apply the policy (`ask` / `grandfather` / `migrate`) — see `catalog-sync.md`. |
| Deleting catalog items | Paddle can't delete. "Delete" = archive (`status: "archived"`). |
| Customer IDs | Stored **per Paddle environment** (`paddle_env` column). A sandbox `ctm_` ID is never sent to live. Always verify a stored ID exists in the current environment before reuse. |
| Attribution | Every checkout transaction carries `custom_data.app`, `custom_data.account_id` (and `team_id` / `user_id` when relevant). Webhooks attribute by these first, customer record second. |
| Webhook security | Manual HMAC verification (§ `webhooks.md`), raw body, all `h1` values accepted, 5 s timestamp tolerance (configurable), idempotency by `event_id`. |
| Cancel default | At period end (`effective_from: "next_billing_period"`). Immediate cancel is admin-only. |
| Plan change default | `proration_billing_mode: "prorated_immediately"`, always preview first. |
| Trials | Card-required Paddle trial on a separate `_trial` price variant, **once per account ever** (see subscription skill). |
| Entitled statuses | Subscriptions: `active`, `trialing`, `past_due`. One-time purchases: `completed` and not fully refunded/charged back. |
| Tax mode | `account_setting` unless the catalog says otherwise. |
| Quantity | Locked to 1..1 for everything except seat prices (1..999) and digital goods marked `allowQuantity`. Prevents the editable stepper in the overlay. |
| Currency | Catalog base currency (default `USD`). Country overrides optional. |
| Money in DB | Integer minor units + ISO currency code. Never floats. |
| Timestamps in DB | UTC. Store Paddle's RFC 3339 strings parsed to timestamp columns. |
| Logging | Every billing action and every verified webhook writes an append-only `billing_events` row (§10). |

## 2. The project manifest: `paddle.catalog.json`

Lives in the project root and is committed. It records the project's decisions, so the
skills **read it instead of asking questions again**. Full schema: `catalog-schema.md`.

```jsonc
{
  "contractVersion": 1,
  "app": "slaxify",                 // namespace; written to custom_data.app on every Paddle entity
  "mode": "fixed",                  // fixed | dynamic
  "skills": ["subscription"],       // any of: subscription, digital-goods, ebook
  "project": { "backend": "express", "frontend": "vanilla", "database": "sqlite" },
  "currency": "USD",
  "priceChangePolicy": "ask",       // ask | grandfather | migrate
  "checkout": { "allowDiscountEntry": true, "displayMode": "overlay", "successPath": "/billing/success" },
  "products": [ /* see catalog-schema.md */ ],
  "discounts": [ /* see catalog-schema.md */ ]
}
```

In **dynamic** mode `products`/`discounts` may be empty or seed-only: the admin UI owns
them and the app pushes them to Paddle at runtime. The file still records `app`, `mode`,
`skills`, `project`, `currency`, `priceChangePolicy`, `checkout`.

## 3. Environment variables

One `.env` per environment (local/sandbox, staging, production). The sync scripts read
`PADDLE_ENV` **from the file they write to**, so sandbox IDs can't end up in a live file.

| Variable | Required | Written by script | Notes |
|---|---|---|---|
| `PADDLE_ENV` | yes | no | `sandbox` \| `production` |
| `PADDLE_API_KEY` | yes | no | `pdl_sdbx_apikey_…` (sandbox) / `pdl_live_apikey_…` (production). Validate the prefix at boot; warn loudly, don't crash. Trim whitespace. |
| `PADDLE_CLIENT_TOKEN` | yes | no | `test_…` (sandbox) / `live_…` (production). Public; sent to the browser. |
| `PADDLE_WEBHOOK_SECRET` | yes | **yes**, if `PADDLE_WEBHOOK_URL` is set | `pdl_ntfset_…` |
| `PADDLE_WEBHOOK_URL` | no | no | e.g. `https://example.com/webhooks/paddle`. If set, the script creates/updates the notification destination. |
| `PADDLE_WEBHOOK_TOLERANCE_SEC` | no | no | default `5` |
| `PADDLE_NOTIFICATION_SETTING_ID` | no | yes | `ntfset_…` |
| `PADDLE_CATALOG_MODE` | no | yes | mirrors the catalog file's `mode` so runtime code needn't read the JSON |
| `PADDLE_PRODUCT_<KEY>` | fixed mode | yes | `pro_…` |
| `PADDLE_PRICE_<KEY>` | fixed mode | yes | `pri_…` |
| `PADDLE_PRICE_<KEY>_TRIAL` | fixed mode, trial prices | yes | `pri_…` trial variant |
| `PADDLE_DISCOUNT_<KEY>` | fixed mode | yes | `dsc_…` |
| `PADDLE_SYNCED_AT` | — | yes | ISO timestamp of the last sync |
| `APP_BASE_URL` | yes | no | used for success URLs and download links |
| `DOWNLOAD_SIGNING_SECRET` | one-time goods | no | ≥32 random bytes, for signed download links |

`<KEY>` = the catalog key upper-cased with every non-alphanumeric character replaced by
`_`. Example: `team_pro_yearly` → `PADDLE_PRICE_TEAM_PRO_YEARLY`.

The script also writes `paddle.<env>.lock.json` (committable, IDs only, no secrets) with
current **and archived** IDs per key. Stacks that prefer JSON over env (GeneXus, Java)
may read that file instead. Both must agree; the script writes both in one run.

## 4. Keys, IDs and `custom_data` conventions

Keys are lowercase `snake_case`, stable forever, unique within the app: `starter`,
`starter_monthly`, `team_pro_yearly`, `ebook_rust_guide`, `launch50`.

| Paddle entity | `custom_data` written by us |
|---|---|
| product | `{ "app", "app_key", "kind" }`, where `kind` ∈ `subscription` \| `digital_good` \| `ebook` |
| price | `{ "app", "app_key", "product_key", "plan", "cycle", "seat", "trial" }` (`plan`/`cycle` only for subscriptions; `trial` is `true` on `_trial` variants and their `app_key` ends in `_trial`) |
| discount | `{ "app", "app_key" }` |
| transaction (checkout) | `{ "app", "account_id", "user_id", "team_id"?, "purchase": "subscription" \| "team_subscription" \| "one_time", "trial": bool, "guest_email"? }` |

Subscriptions created from a checkout transaction inherit its `custom_data`. That is how a
webhook knows whose subscription it is even if Paddle swapped the customer record.

Scripts and runtime sync only ever touch Paddle entities whose `custom_data.app` equals
this app's `app`. Several apps can share one Paddle account safely.

## 5. Paddle REST client rules

- Base URL: `https://sandbox-api.paddle.com` when `PADDLE_ENV=sandbox`, else `https://api.paddle.com`.
- Headers: `Authorization: Bearer <PADDLE_API_KEY>`, `Content-Type: application/json`, `Paddle-Version: 1`.
- Success body: `{ "data": …, "meta": { "request_id", "pagination"? } }`.
- Error body: `{ "error": { "type", "code", "detail", "documentation_url", "errors"? }, "meta": { "request_id" } }`. Raise a typed error that keeps `status`, `code`, `detail`, `request_id`. **Always log `request_id`.**
- `not_found` detection: `error.code == "not_found"` (or HTTP 404). A network error or 5xx is **never** treated as "not found".
- Pagination: list endpoints return `meta.pagination.next` (a full URL you can GET as-is) and `has_more`. Use `per_page=200` (transactions max 30, adjustments max 50).
- Retries: on `429` and `5xx`, retry up to 3 times with exponential backoff (0.5 s, 1 s, 2 s), honouring `Retry-After` if present. Never retry other 4xx.
- Timeouts: 15 s per request.
- The client exposes exactly: `get(path, query?)`, `post(path, body)`, `patch(path, body)`, `list(path, query?)` → all items across pages.

## 6. Canonical module layout

Same module names in every stack (file extension/case per language convention):

```
billing/
  paddle_client        # §5
  config               # env loading + key-prefix validation (§3)
  catalog              # key <-> id lookup (env or DB), price→plan mapping
  catalog_sync         # dynamic mode: push plans/prices/discounts to Paddle (algorithm in catalog-sync.md)
  customers            # ensure_customer(account) per env (customers.md)
  discounts            # validate code, admin CRUD + push (discounts.md)
  checkout             # create draft transactions (§7)
  webhooks             # verify + dedupe + route (webhooks.md)
  subscriptions        # sync, change, cancel, resume, portal, trial rules   [subscription skill]
  teams                # seats                                              [subscription skill]
  purchases            # one-time fulfilment, entitlements, downloads      [digital-goods / ebook]
  refunds              # admin refunds via adjustments
  reconciliation       # periodic safety net
  audit                # billing_events writer (§10)
```

## 7. HTTP endpoint contract

Same paths, methods and JSON shapes in every backend. `🔒` = requires an authenticated
user; `🛡` = requires an admin. Errors are always `{ "error": "<code>", "message": "<human text>" }`
with an appropriate HTTP status.

### Shared
| Method & path | Body | Response |
|---|---|---|
| `POST /webhooks/paddle` | raw Paddle body | `200 {"received":true}` / `400` bad signature / `500` handler error (Paddle retries) |
| `GET /api/billing/config` | — | `{ "env", "clientToken" }` (public) |
| `POST /api/billing/discounts/validate` | `{ "code", "priceKeys": [..] }` | `{ "valid": bool, "reason"?: "not_found"\|"expired"\|"used_up"\|"not_applicable"\|"disabled", "discount"?: { "code", "type", "amount", "currency", "recur", "maxRecurringIntervals" } }` |
| `GET 🛡 /api/admin/billing/discounts` · `POST` · `PATCH /:key` · `POST /:key/archive` · `POST /:key/resync` | see `discounts.md` | discount objects incl. `syncStatus` |
| `GET 🛡 /api/admin/billing/refunds` · `POST 🛡 /api/admin/billing/refunds` | `{ "transactionId", "type": "full"\|"partial", "reason", "items"?, "cancelSubscription"?: bool }` | `{ "adjustment": { "id", "status" } }` |
| `POST 🛡 /api/admin/billing/reconcile` | — | `{ "checked", "changed", "errors" }` |
| `POST 🛡 /api/admin/billing/catalog/resync` | — | dynamic mode: re-push everything, return a per-item result |

### Subscription skill
| Method & path | Body | Response |
|---|---|---|
| `GET /api/billing/plans` | — | `{ "plans": [{ "key", "name", "description", "features", "prices": [{ "key", "cycle", "amount", "currency", "trialDays", "seat" }] }], "trialEligible": bool }` (`trialEligible` only when logged in) |
| `GET 🔒 /api/billing/status` | — | `{ "plan", "priceKey", "cycle", "status", "entitled", "trialEndsAt", "currentPeriodEnd", "cancelAtPeriodEnd", "scheduledChange", "quantity", "provider": "paddle", "invoices": [...] }` |
| `POST 🔒 /api/billing/checkout` | `{ "priceKey", "discountCode"? }` | `{ "transactionId", "clientToken", "env", "trial": bool }` · `409 already_subscribed` |
| `POST 🔒 /api/billing/change-plan/preview` | `{ "priceKey", "quantity"? }` | `{ "immediateCharge": {amount,currency}, "nextBilledAt", "nextAmount": {amount,currency}, "credit"? }` |
| `POST 🔒 /api/billing/change-plan` | `{ "priceKey", "quantity"? }` | `{ "ok": true, "status": <status object> }` · `402 payment_failed` |
| `POST 🔒 /api/billing/cancel` | `{}` | `{ "ok": true, "cancelAt" }` |
| `POST 🔒 /api/billing/resume` | `{}` | `{ "ok": true }` (removes a scheduled cancel) |
| `POST 🔒 /api/billing/portal` | `{ "intent"?: "overview"\|"update_payment"\|"cancel" }` | `{ "url" }` |
| `GET 🔒 /api/billing/invoices/:transactionId/pdf` | — | `302` to Paddle's signed PDF URL (ownership checked) |
| `POST 🔒 /api/billing/support-request` | `{ "topic": "refund"\|"paid_not_activated"\|"other", "message", "transactionId"? }` | `{ "ok": true, "requestId" }` |
| `POST 🔒 /api/team/checkout` | `{ "priceKey", "seats", "discountCode"? }` | same as `/api/billing/checkout` |
| `POST 🔒 /api/team/seats/preview` · `POST 🔒 /api/team/seats` | `{ "seats" }` | preview / `{ "ok": true }` |
| `POST 🔒 /api/team/seats/assign` · `POST 🔒 /api/team/seats/unassign` | `{ "userId" }` | `{ "ok": true, "seatsUsed", "seats" }` |
| `GET/POST/PATCH 🛡 /api/admin/billing/plans[/:key]` | dynamic mode only | plan objects incl. `syncStatus` |

### Digital goods / ebook skills
| Method & path | Body | Response |
|---|---|---|
| `GET /api/store/products` | — | `{ "products": [{ "key", "kind", "name", "description", "imageUrl", "prices": [{ "key", "amount", "currency", "allowQuantity" }] }] }` |
| `POST /api/store/checkout` | `{ "items": [{ "priceKey", "quantity"? }], "email"? , "discountCode"? }` | `{ "transactionId", "clientToken", "env" }` (`email` required for guests) |
| `GET 🔒 /api/store/purchases` | — | `{ "purchases": [{ "transactionId", "status", "createdAt", "total", "currency", "items": [{ "productKey", "name", "entitlements": [...] }] }] }` |
| `GET 🔒 /api/store/entitlements/:id/download` | — | `302` to a short-lived signed file URL |
| `GET /d/:token` | — | guest download via signed token (`302`, or `410` if expired/revoked/limit reached) |
| `POST /api/store/resend-links` | `{ "email" }` | always `200 {"ok":true}` (no account enumeration), rate limited |
| `GET/POST/PATCH 🛡 /api/admin/store/products[/:key]` | dynamic mode only | product objects incl. `syncStatus` |

## 8. Status semantics & entitlement

Subscription statuses are Paddle's, stored verbatim: `active`, `trialing`, `past_due`,
`paused`, `canceled`.

```
entitled(sub) = sub.status in {active, trialing, past_due}
```

- `past_due`: still entitled (Paddle is retrying payment). Show an "update payment method"
  banner that calls `/api/billing/portal` with `intent: "update_payment"`.
- `scheduled_change.action == "cancel"` → `cancelAtPeriodEnd = true`; still entitled until
  Paddle sends `subscription.canceled`.
- `paused` / `canceled` → not entitled; fall back to the free tier (if the app has one).

One-time entitlement:
```
entitled(entitlement) = purchase.status == "completed" and entitlement.revoked_at is null
```
A refund or chargeback that is **approved** revokes the entitlements of the refunded items.

## 9. Money

- Paddle amounts are strings in the currency's minor unit (`"499"` = $4.99).
- Zero-decimal currencies (no minor unit): `JPY, KRW, CLP, ISK, VND, HUF, TWD, UGX, XAF, XOF, PYG, RWF, KMF, GNF, DJF, BIF, VUV, XPF` — the amount is already whole units.
- Catalog files hold **major-unit decimal strings** (`"4.99"`, `"700"` for JPY). Scripts and runtime convert with the same function: `to_minor(amount, currency)` / `from_minor(minor, currency)`.
- Display via the platform's locale currency formatter (`Intl.NumberFormat`, `NumberFormatter`, `babel`, `java.text.NumberFormat`).

## 10. Audit log event types

`billing_events.event_type` is one of (add new types only as extensions):

`checkout_created`, `webhook_received`, `webhook_duplicate`, `webhook_failed`,
`subscription_synced`, `subscription_stale_event_ignored`, `price_mapping_failed`,
`customer_created`, `customer_reused`, `customer_id_repaired`, `customer_email_corrected`,
`trial_started`, `trial_denied_repeat`, `plan_change_previewed`, `plan_changed`,
`cancel_scheduled`, `cancel_removed`, `seats_changed`, `seat_assigned`, `seat_unassigned`,
`purchase_fulfilled`, `entitlement_revoked`, `download_issued`, `download_denied`,
`discount_created`, `discount_updated`, `discount_archived`, `discount_sync_failed`,
`catalog_synced`, `catalog_sync_failed`, `price_superseded`, `subscriptions_migrated`,
`refund_requested`, `refund_submitted`, `refund_status_changed`, `support_request`,
`reconciliation_run`.
