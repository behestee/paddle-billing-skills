# Customers (contract v1)

Why this file exists: in the reference project a **live** payment was charged but
never showed as active. A sandbox `ctm_` id was still stored for the user. Live Paddle
didn't know it, silently created its own customer for the checkout, and the subscription
landed on an id the app had never recorded. Every rule below prevents part of that.

## `ensure_customer(account_id, email) -> paddle_customer_id`

Runs only from a billing action (checkout), never at login.

```
env = PADDLE_ENV
row = billing_customers WHERE account_id = ? AND paddle_env = env
if row:
    c = GET /customers/{row.paddle_customer_id}
        -> not_found (error.code == "not_found"): delete row, continue below
        -> network / 5xx / auth error: RAISE (never treat "couldn't check" as "doesn't exist",
           or a blip creates a duplicate customer for a paying user)
        -> found:
             if email is real and c.email is a placeholder/different-and-unverified: PATCH email, audit customer_email_corrected
             return c.id                                   (audit customer_reused only on first reuse per day, optional)
if email:
    existing = GET /customers?email=<email>   (first active result)
    if existing: insert row; audit customer_reused; return existing.id
c = POST /customers { email, custom_data: { app, account_id } }
insert row; audit customer_created; return c.id
```

- `email` must be the user's real address. If the app has no verified email, let the
  **checkout collect it**: create the draft transaction without `customer_id`, and adopt
  the customer from the `transaction.completed` / `subscription.created` webhook via
  attribution (webhooks.md §6). Never invent a placeholder email: Paddle receipts
  bounce, and the buyer "fixes" it at checkout, which creates a different customer.
- Unique `(account_id, paddle_env)`: switching `PADDLE_ENV` automatically gives each
  account a fresh customer in the new environment.
- `custom_data.account_id` on the customer is only a fallback for attribution. The
  transaction's `custom_data` is the primary link, because it survives Paddle swapping
  the customer.

## Guest buyers (one-time goods)

No account → no `billing_customers` row. The draft transaction carries
`custom_data.guest_email`, and Paddle collects the email at checkout. On
`transaction.completed`, `purchases.email` = the customer's email from
`GET /customers/{customer_id}`. If the guest later signs up with the same (verified)
email, `claim_guest_purchases(account_id, email)` sets `account_id` on matching
`billing_purchases` and `billing_entitlements` rows.

## Boot-time checks (config module)

- `PADDLE_API_KEY` trimmed, prefix matches `PADDLE_ENV` (`pdl_sdbx_apikey_` / `pdl_live_apikey_`).
  Mismatch → log an **error** naming the likely cause (wrong environment vs. malformed on paste). Don't crash the app.
- `PADDLE_CLIENT_TOKEN` prefix `test_` (sandbox) / `live_` (production). Warn if not.
- `PADDLE_WEBHOOK_SECRET` present, else log an error: webhooks will all fail.
- Fixed mode: every `PADDLE_PRICE_*` referenced by the app is non-empty, else error.
