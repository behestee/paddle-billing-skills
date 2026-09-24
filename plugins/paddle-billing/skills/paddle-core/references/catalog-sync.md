# Catalog sync (contract v1)

Two modes, one algorithm.

| | Fixed | Dynamic |
|---|---|---|
| Source of truth | `paddle.catalog.json` (committed) | `billing_catalog_products` / `billing_catalog_prices` (admin UI) |
| Who pushes to Paddle | `paddle-sync` script (Node or Python), run by a developer / deploy step | the app's `catalog_sync` module, on admin create/update + retry job |
| Where the app reads IDs | env vars `PADDLE_PRICE_<KEY>` etc. (or `paddle.<env>.lock.json`) | DB columns `paddle_product_id` / `paddle_price_id` |
| Price → plan in webhooks | `price.custom_data.app_key` → env/lock (incl. archived history) | `price.custom_data.app_key` → DB (incl. archived rows) |

**When to choose which** (the skill proposes one based on this and records it in the catalog):
- Plans rarely change and a developer deploys the change → **fixed**.
- Non-developers create or edit plans, or plans vary per customer/market → **dynamic**.

## Fixed mode workflow

```
# sandbox (local .env has PADDLE_ENV=sandbox)
node <core>/scripts/paddle-sync.mjs plan          # preview
node <core>/scripts/paddle-sync.mjs               # apply, writes .env + paddle.sandbox.lock.json
node <core>/scripts/paddle-sync.mjs check         # verify

# production (on the server, or locally against a production env file)
node <core>/scripts/paddle-sync.mjs --env-file .env.production plan
node <core>/scripts/paddle-sync.mjs --env-file .env.production          # asks "yes" before applying
```
Python is the same: `python3 <core>/scripts/paddle_sync.py …` with identical flags.

Copy the script into the project (`scripts/paddle-sync.mjs` or `scripts/paddle_sync.py`)
so CI and servers don't depend on the plugin being installed. Keep it unmodified: to
upgrade, re-copy it from the plugin.

## The algorithm (the script is the reference implementation)

For every product → price → trial variant → discount, match by
`custom_data.app == app && custom_data.app_key == key`:

1. **Missing** → try to adopt a legacy entity (same product name / same money fields /
   same discount code, and no `custom_data.app`) by patching `custom_data`. Otherwise
   create it.
2. **Present, non-money fields differ** (name, description, tax category, image,
   quantity limits, custom_data) → PATCH in place.
3. **Present, money fields differ** (amount, currency, interval, frequency, trial,
   country overrides) → **price change**:
   - create the new price with the same `app_key`, archive the old one;
   - subscription prices: apply the policy (`ask` → prompt the operator / admin;
     `grandfather`; `migrate`);
   - `migrate` = for every `active|trialing|past_due` subscription on the old price,
     `PATCH /subscriptions/{id}` with items replaced (same quantity) and
     `proration_billing_mode: "do_not_bill"`, so the next renewal bills the new price and
     nothing is charged now. **Legal note:** tell customers before migrating.
   - re-push discounts restricted to that price.
4. **Archived in the catalog / removed trial** → archive in Paddle. Existing subscribers
   stay on archived prices and keep working, because mapping uses `custom_data.app_key`.
5. `--prune` → archive app-owned entities no longer in the catalog.
6. Never delete, and never PATCH `unit_price`.

## Dynamic mode: runtime `catalog_sync`

Admin endpoints: `GET/POST/PATCH /api/admin/billing/plans[/:key]` (subscription skill),
`GET/POST/PATCH /api/admin/store/products[/:key]` (one-time skills),
`POST /api/admin/billing/catalog/resync`.

```
save_product(input):                       # admin create/update
  validate exactly like the catalog schema
  BEGIN
    upsert billing_catalog_products (sync_status='pending')
    for each price in input:
      active = billing_catalog_prices WHERE key=? AND variant=? AND status='active'
      if not active: insert (pending)
      elif money fields differ:
        if product.kind == 'subscription': require input.priceChangePolicy in (grandfather, migrate)
             (the admin UI shows the choice when the policy is "ask"; otherwise the configured policy applies)
        insert new row (pending); old.status='archived'; old.superseded_by_id=new.id
        audit price_superseded { key, oldPriceId, policy }
      elif other fields differ: update in place (pending)
    trial variants: maintained automatically from trial_days, exactly like the script
  COMMIT
  push(product)                            # outside the DB transaction

push(product):
  product: POST/PATCH /products          -> paddle_product_id
  prices:  POST new rows / PATCH changed rows / PATCH {status:"archived"} for archived rows with a paddle_price_id
  migrate policy: run the migration step (above) for each superseded price, audit subscriptions_migrated {count}
  discounts restricted to affected keys: re-push
  mark rows synced; on error mark failed + sync_error, audit catalog_sync_failed
```

- The pricing page and checkout only offer prices that are `status='active' AND
  sync_status='synced'`. A plan never shows before it exists in Paddle.
- A retry job (every 10 min) re-pushes `pending`/`failed` rows.
- **Seeding**: on first boot in dynamic mode, if `billing_catalog_products` is empty and
  the catalog file has products, import them as `pending` and push. That gives you a
  starting catalog without clicking through the admin UI.
- The env var `PADDLE_CATALOG_MODE=dynamic` (written by the script) tells runtime code which
  lookup to use.

## Price → plan mapping (both modes)

```
map_price(price):                          # price = subscription item price object from Paddle
  key = price.custom_data?.app_key
  if key and price.custom_data.app == APP:
      return lookup_by_key(strip_suffix(key, "_trial"))    # env/lock or DB, includes archived
  id match: env/lock (current + history) or DB (any status) by paddle_price_id
  none: audit price_mapping_failed { priceId, subscriptionId }; return None  -> caller keeps the previous plan
```
