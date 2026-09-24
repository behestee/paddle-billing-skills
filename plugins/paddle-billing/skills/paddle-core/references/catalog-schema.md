# `paddle.catalog.json` schema (contract v1)

Read by both sync scripts (`scripts/paddle-sync.mjs`, `scripts/paddle_sync.py`) and by
the skills. Unknown fields are rejected by the scripts, which catches typos.

## Top level

| Field | Type | Default | Meaning |
|---|---|---|---|
| `contractVersion` | `1` | required | Contract version this project follows |
| `app` | string `[a-z0-9_-]{2,40}` | required | Namespace written to `custom_data.app` |
| `mode` | `"fixed"` \| `"dynamic"` | required | Fixed: catalog lives here and is pushed by the script. Dynamic: the admin UI owns the catalog and the app pushes it at runtime |
| `skills` | array of `"subscription"`, `"digital-goods"`, `"ebook"` | required | Which skills this project uses |
| `project` | `{ backend, frontend, database }` | required | Recorded so skills don't ask again. backend ∈ `express`, `nextjs`, `fastapi`, `laravel`, `spring`, `genexus`, `other`; frontend ∈ `vanilla`, `react`, `nextjs`, `angular`, `blade`, `thymeleaf`, `genexus`, `other`; database ∈ `postgres`, `mysql`, `sqlite`, `sqlserver`, `other` |
| `currency` | ISO 4217 | `"USD"` | Base currency for every price without its own `currency` |
| `taxMode` | `"account_setting"` \| `"internal"` \| `"external"` \| `"location"` | `"account_setting"` | Paddle `tax_mode` for created prices |
| `priceChangePolicy` | `"ask"` \| `"grandfather"` \| `"migrate"` | `"ask"` | What happens to existing subscribers when a subscription price's money fields change |
| `checkout` | object | see below | Checkout behaviour |
| `products` | array | `[]` | Fixed mode: the whole catalog. Dynamic mode: optional seed |
| `discounts` | array | `[]` | Fixed mode: all promo codes. Dynamic mode: optional seed |

`checkout`:

| Field | Default | Meaning |
|---|---|---|
| `allowDiscountEntry` | `true` | Paddle overlay shows "Add discount" (`settings.showAddDiscounts`) |
| `displayMode` | `"overlay"` | `overlay` \| `inline` |
| `successPath` | `"/billing/success"` | Relative to `APP_BASE_URL`; the page polls status until the webhook has landed |
| `theme` | `"light"` | `light` \| `dark` |

## Product

| Field | Type | Default | Meaning |
|---|---|---|---|
| `key` | snake_case | required | Stable forever |
| `kind` | `"subscription"` \| `"digital_good"` \| `"ebook"` | required | |
| `name` | string ≤ 200 | required | Shown in checkout & invoices |
| `description` | string | `null` | |
| `taxCategory` | Paddle tax category | by kind: subscription → `saas`, digital_good → `standard`, ebook → `ebooks` | `standard`, `saas`, `digital-goods`, `ebooks`, `software-programming-services`, `training-services`, `professional-services`, `implementation-services`, `website-hosting`. Only `standard` ("standard digital goods") is enabled on every account. **Every other category must be approved by Paddle** (they audit your site); until then Paddle taxes the product as `standard` |
| `imageUrl` | https URL | `null` | |
| `features` | string[] | `[]` | App-side only (pricing page); not sent to Paddle |
| `plan` | snake_case | = `key` | Subscriptions: the plan key your app gates features on. Team and individual products can share one `plan` (e.g. `pro`) |
| `fulfillment` | object | — | One-time goods only (see below) |
| `prices` | Price[] | required, ≥1 | |
| `archived` | bool | `false` | Archive the product and all its prices in Paddle |

## Price

| Field | Type | Default | Meaning |
|---|---|---|---|
| `key` | snake_case | required | Must not end in `_trial` (reserved for generated variants) |
| `name` | string | product name | Paddle price `name` (checkout line label) |
| `description` | string | auto | Internal Paddle description |
| `amount` | decimal string, major units | required | `"4.99"`, `"700"` (JPY) |
| `currency` | ISO 4217 | top-level `currency` | |
| `interval` | `"day"` \| `"week"` \| `"month"` \| `"year"` \| `null` | `null` | `null` = one-time. Required for subscription products |
| `frequency` | int ≥1 | `1` | Every *n* intervals |
| `cycle` | string | derived: month→`monthly`, year→`yearly`, else `<frequency><interval>` | Subscription cycle label stored in DB |
| `trialDays` | int ≥1 \| `null` | `null` | Subscriptions only. Generates an extra `<key>_trial` price with `trial_period: {interval:"day", frequency:trialDays, requires_payment_method:true}` |
| `seat` | bool | `false` | Team/per-seat price. Quantity becomes 1..`maxSeats` |
| `maxSeats` | int | `999` | Only with `seat: true` |
| `allowQuantity` | bool | `false` | One-time goods: let the buyer buy several (quantity 1..`maxQuantity`) |
| `maxQuantity` | int | `100` | Only with `allowQuantity: true` |
| `overrides` | `[{ "countries": ["JP"], "amount": "700", "currency": "JPY" }]` | `[]` | Paddle `unit_price_overrides` |
| `archived` | bool | `false` | Archive this price. Existing subscribers stay on it |

Money-relevant fields (a change triggers the price-change policy): `amount`, `currency`,
`interval`, `frequency`, `trialDays`, `overrides`. Other fields (`name`, `description`,
quantity limits) are patched in place.

## Fulfillment (one-time goods)

```jsonc
"fulfillment": {
  "type": "file",                 // file | license_key | access | external_url | credits
  "files": [ { "path": "ebooks/rust-guide-v3.pdf", "label": "PDF" } ],   // type=file; storage-relative paths
  "maxDownloads": 5,              // per entitlement; null = unlimited
  "linkTtlMinutes": 60,           // lifetime of each issued signed URL
  "licensePrefix": "RUST",        // type=license_key
  "accessKey": "course_rust",     // type=access: the feature flag / role to grant
  "url": "https://…",             // type=external_url
  "credits": 1000                 // type=credits
}
```

Ebook products must use `type: "file"` with at least one `.pdf` file.

## Discount

| Field | Type | Default | Meaning |
|---|---|---|---|
| `key` | snake_case | required | Stable forever |
| `code` | `[A-Za-z0-9]{1,32}` | required | Promo code customers type. Stored upper-case. Case-insensitive in Paddle |
| `description` | string 1..500 | required | Internal |
| `type` | `"percentage"` \| `"flat"` \| `"flat_per_seat"` | required | |
| `amount` | decimal string | required | percentage: `"0.01"`–`"100"`; flat: major units (converted to minor for Paddle) |
| `currency` | ISO 4217 | top-level `currency` | Required for flat types |
| `recur` | bool | `false` | Subscriptions: apply on renewals too |
| `maxRecurringIntervals` | int \| `null` | `null` | With `recur: true`: how many billing periods. `null` = forever |
| `usageLimit` | int \| `null` | `null` | Total redemptions across all customers |
| `restrictTo` | string[] \| `null` | `null` | Product or price **keys** (resolved to IDs). `null` = everything |
| `expiresAt` | RFC 3339 \| `null` | `null` | |
| `enabled` | bool | `true` | `enabled_for_checkout` |
| `archived` | bool | `false` | Archive in Paddle |

## Full example (subscription + team + trial + promo)

See `templates/paddle.catalog.subscription.json`, `templates/paddle.catalog.digital-goods.json`
and `templates/paddle.catalog.ebook.json`.
