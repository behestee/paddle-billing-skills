# One-time purchases core (contract v1)

Shared by the **digital-goods** and **ebook** skills. The buyer pays once and gets
lifetime access. Paddle handles no physical shipping.

## Checkout: `POST /api/store/checkout`

```
input: { items: [{ priceKey, quantity? }], email?, discountCode? }
1. resolve each priceKey -> active, synced price (fixed: env; dynamic: DB). Unknown -> 400 unknown_price
2. quantity: 1 unless the price allowQuantity (then 1..maxQuantity)
3. buyer:
     logged in -> customer_id = ensure_customer(account_id, verified_email) (customers.md)
     guest     -> require email (basic format check); no customer_id
4. optional: already owns every requested non-quantity product -> 409 already_owned
   (with { downloadsUrl }) so people don't pay twice for the same ebook
5. discount: validate (discounts.md); valid -> discount_id; invalid -> 400 { error: "invalid_discount", reason }
6. POST /transactions {
     items: [{ price_id, quantity }],
     customer_id?,                                 # logged in only
     discount_id?,
     collection_mode: "automatic",
     custom_data: { app, account_id|null, user_id|null, purchase: "one_time", guest_email? }
   }
   -> { id: txn_…, status: "draft" }
7. audit checkout_created; return { transactionId, clientToken: PADDLE_CLIENT_TOKEN, env: PADDLE_ENV }
```
The browser opens `Paddle.Checkout.open({ transactionId, customer: guest ? { email } : undefined, settings })`
(frontend.md). Guests confirm their email inside Paddle.

## Fulfilment: `transaction.completed` without `subscription_id`

Idempotent. The unique `paddle_transaction_id` makes a replay a no-op.

```
fulfill(txn):
  if txn.custom_data?.app and txn.custom_data.app != APP: ignore
  if billing_purchases has txn.id: return                       # replay
  customer = GET /customers/{txn.customer_id}                   # email for delivery
  account  = txn.custom_data.account_id
             ?: billing_customers by customer_id (this env)
             ?: account whose verified email == customer.email (optional, configurable)
             ?: null (guest)
  BEGIN
    purchase = insert billing_purchases {
      paddle_transaction_id, paddle_env, account_id, email: customer.email, paddle_customer_id,
      status: "completed", currency_code: txn.currency_code,
      subtotal_minor: txn.details.totals.subtotal, discount_minor: txn.details.totals.discount,
      tax_minor: txn.details.totals.tax, total_minor: txn.details.totals.total, discount_id: txn.discount_id }
    for line in txn.details.line_items (and txn.items for quantity):
      price_key = line.price.custom_data?.app_key ?: lookup by price id
      product   = catalog product for price_key; unknown -> audit price_mapping_failed, still store the item
      item = insert billing_purchase_items { paddle_item_id: line.id, product_key, price_key, paddle_price_id, quantity, total_minor: line.totals.total }
      repeat quantity times: insert billing_entitlements per product.fulfillment:
        file         -> kind=file, max_downloads = fulfillment.maxDownloads
        license_key  -> kind=license_key, license_key = generate(prefix)   # e.g. RUST-7F3K-9QXM-2PLA-H8DE, crypto-random, Crockford base32
        access       -> kind=access, access_key = fulfillment.accessKey     # app grants role/flag while not revoked
        external_url -> kind=external_url
        credits      -> kind=credits; add fulfillment.credits to the account's credit balance (app-specific ledger)
  COMMIT
  audit purchase_fulfilled { transactionId, items, total }
  enqueue email "Your purchase" to customer.email with library link + guest download links (/d/<token>)
```

Use `txn.details.line_items[]` for per-line totals (`totals.total`, minor units) and
`id` (needed for partial refunds). Quantity comes from `txn.items[].quantity`, matched by price id.

## Downloads

Files live in **private** storage (S3 / R2 / GCS / Azure Blob, or a non-public disk
directory). Never under the web root.

Logged-in: `GET /api/store/entitlements/:id/download`
```
e = entitlement; require e.account_id == current account (else 404)
deny if revoked_at is set (410 revoked) or max_downloads reached (410 limit_reached)
file = fulfillment.files[i] (query ?file=<index>, default 0)
url  = storage.presign(file.path, ttl = linkTtlMinutes, content-disposition = attachment; filename="<label>.<ext>")
       (local disk: redirect to /d/<token> which streams the file)
UPDATE download_count = download_count + 1 WHERE id=? AND (max_downloads IS NULL OR download_count < max_downloads)
  -> 0 rows updated = race lost -> 410 limit_reached
audit download_issued; 302 url
```

Guest links: `GET /d/:token`
```
token = base64url(payload) + "." + base64url(HMAC_SHA256(DOWNLOAD_SIGNING_SECRET, payload))
payload = JSON { e: entitlement_id, f: file_index, x: expires_unix }   # emailed links: x = now + 30 days
verify signature (constant-time) and x > now, else 410 expired
then the same checks and counter as above; 302 to a fresh presigned URL (short TTL)
```
The emailed link is long-lived but only mints short-lived storage URLs, and every use
counts against `max_downloads`.

`POST /api/store/resend-links { email }`: always `200 {ok:true}` (no account
enumeration), rate limited (3/hour per email and per IP). If purchases exist for that
email, re-send links with fresh tokens.

## Refunds & chargebacks revoke access

`adjustment.updated` (and `.created`) with `action ∈ {refund, chargeback, chargeback_warning}`:
```
only act when status == "approved" (refund) or action == "chargeback"
purchase = billing_purchases by adjustment.transaction_id
if adjustment.type == "full" (or all items refunded): revoke every entitlement; purchase.status = refunded | chargeback
else (partial): for each adjustment.items[].item_id -> matching billing_purchase_items.paddle_item_id:
                item.refunded = true; revoke its entitlements; purchase.status = partially_refunded
revoked_at = now, revoke_reason = "refund" | "chargeback"; audit entitlement_revoked
license keys: mark revoked, so your license-check endpoint (if any) returns invalid
```
`chargeback_warning` → audit only.

## "My library": `GET /api/store/purchases`

Returns the account's purchases with items and non-revoked entitlements (contract §7
shape). Revoked entitlements are shown greyed out with the reason, not hidden.

## Reconciliation

Daily: `GET /transactions?status=completed&updated_at[GTE]=<now-3d>&per_page=30` (paginate).
For each with `subscription_id == null` and `custom_data.app == APP` that has no
`billing_purchases` row → run `fulfill` (source `reconciliation`). Also fetch
`GET /adjustments?status=approved&…` for the same window and replay `on_adjustment`.
This catches missed webhooks.
