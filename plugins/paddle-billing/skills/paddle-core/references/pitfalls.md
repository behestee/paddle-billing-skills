# Pitfalls learned in production (read before shipping)

Each one really happened in the reference project (Slaxify, approved by Paddle) or is a
documented Paddle behaviour. The contract already prevents each of them. Don't "simplify"
the prevention away.

| # | What happened | Prevention in the contract |
|---|---|---|
| 1 | Checkout overlay failed with a generic error | Set **Default payment link / checkout URL** in Paddle Dashboard → Checkout → Checkout settings, once per environment. It must be a page on an approved domain that loads Paddle.js. |
| 2 | The overlay showed an editable quantity stepper | Prices are created with `quantity {1,1}` (seats 1..N) by the scripts. |
| 3 | A **live** payment was charged but the app showed Free: a stale sandbox `ctm_` id was sent to live, and Paddle made its own customer | Customers stored per `paddle_env`; stored id verified with `GET /customers/{id}` before use; `custom_data.account_id` on every transaction; self-heal in the webhook (customers.md). |
| 4 | `PADDLE_API_KEY` lost its first character on paste; nothing failed until much later | Boot-time prefix validation, trimmed values, `paddle-sync check`. |
| 5 | An unmapped price id silently downgraded a paying customer to Free | Map via `price.custom_data.app_key`; unmapped → keep the previous plan and log `price_mapping_failed`. |
| 6 | Paddle.js `Initialize()` was called per checkout (invalid) | `paddle-client` initialises once and uses `Update()` afterwards. |
| 7 | A refund didn't show: the transaction still says `completed` | Invoices merge `adjustments`; revenue uses `adjusted_totals`. |
| 8 | Revenue counted refunded money | Use `include=adjustments_totals` and read `details.adjusted_totals` (both total and fee). |
| 9 | Placeholder emails (`user@app.local`) bounced receipts, and buyers changed them at checkout, which created a different customer | Never invent emails. Let checkout collect them and attribute by `custom_data`. |
| 10 | "Couldn't reach Paddle" treated as "customer doesn't exist" → duplicate customer | Only `error.code == "not_found"` means missing; everything else raises. |
| 11 | Scripts run as the login user couldn't write the service-owned SQLite DB | Scripts that write the DB check write access first and print the `sudo -u <service>` command. `paddle-sync` itself only writes `.env` and the lock file. |
| 12 | Grandfathered subscribers on an archived price → "unknown price" | Mapping via `custom_data.app_key`, and the lock file keeps history. |
| 13 | Tax category rejected / ebooks taxed at the standard rate | Categories other than `standard` need **Paddle approval** (they audit your site). Until approved, sell ebooks as `digital_good`/`standard`, or wait (ebook skill). |
| 14 | Webhook worked locally, failed in prod | Raw body before JSON middleware; reverse proxies must not re-encode the body; server clock synced (5 s tolerance). |
| 15 | Trial abused with new accounts | Trial once per account **and** per email hash (subscription skill). Paddle trials require a payment method. |
| 16 | The success page said "active" before the webhook landed | The success page polls the backend; the browser event never grants access. |
