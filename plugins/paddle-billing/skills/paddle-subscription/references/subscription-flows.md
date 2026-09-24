# Subscription flows (contract v1)

All Paddle field names are raw REST `snake_case`. "Price lookup" means fixed-mode env/lock or
dynamic-mode DB (`catalog-sync.md`). "Audit" means write a `billing_events` row.

## 1. `GET /api/billing/plans`

From the catalog (fixed: the catalog file bundled with the app, or the lock file + env;
dynamic: DB rows with `status='active' AND sync_status='synced'`). Group prices by
product. Omit `_trial` variants from the list: expose `trialDays` on the base price
instead. `trialEligible` = §3 for the logged-in account (omitted for anonymous visitors).
Plans are ordered as in the catalog. **That order is the plan rank** used by §9
(first = lowest).

## 2. `POST /api/billing/checkout { priceKey, discountCode? }`

```
price = price lookup(priceKey); must be a subscription, non-seat, active price, else 400 unknown_price
if user holds a team seat on an entitled team subscription -> 409 covered_by_team
if the account has an entitled individual subscription      -> 409 already_subscribed (use change-plan)
customer_id = ensure_customer(account_id, verified_email)          # customers.md
trial = trial_eligible(account_id, email) and price has trialDays
price_id = trial ? id(priceKey + "_trial") : id(priceKey)
discount_id = discountCode ? validated discount (discounts.md) : null    # invalid -> 400 invalid_discount {reason}
txn = POST /transactions {
  items: [{ price_id, quantity: 1 }],
  customer_id,
  discount_id?,                      # omit the key when null
  collection_mode: "automatic",
  custom_data: { app, account_id, user_id, purchase: "subscription", trial }
}
audit checkout_created { priceKey, trial, discountCode, transactionId: txn.id }
return { transactionId: txn.id, clientToken, env, trial }
```

## 3. Trials: once per account, ever

```
trial_eligible(account_id, email):
  no billing_trial_usages row with account_id
  and no billing_trial_usages row with email_hash = sha256(lower(trim(email)))
  and no billing_subscriptions row for account_id (any status, individual or team-admin)
```
- Paddle trial prices require a payment method (`requires_payment_method: true`). The card
  is charged automatically when the trial ends unless the customer cancels.
- On the first sync of a subscription whose status is `trialing` (or whose item has
  `trial_dates`), insert `billing_trial_usages { account_id, email_hash (customer email),
  paddle_subscription_id, plan_key }` and audit `trial_started`.
- **Race guard**: if that insert conflicts (the account or email already used a trial
  on another subscription), call `POST /subscriptions/{id}/activate` (ends the trial,
  bills now), audit `trial_denied_repeat`, and show the user nothing special. They
  agreed to the price at checkout.
- Canceling during the trial (`effective_from: next_billing_period`) ends access at the trial end with no charge.

## 4. `sync_from_paddle(sub, occurred_at, source)`

Called by every `subscription.*` webhook, by reconciliation, and after every mutating call below.

```
if sub.custom_data?.app and sub.custom_data.app != APP: return
row = billing_subscriptions by paddle_subscription_id
if row and row.last_event_at and occurred_at < row.last_event_at: audit subscription_stale_event_ignored; return
account_id = attribution (webhooks.md §6)
item    = first item whose price.custom_data.app == APP, else items[0]
mapped  = map_price(item.price)                 # catalog-sync.md; None -> keep row's plan/price fields
upsert {
  paddle_subscription_id: sub.id, paddle_env, account_id, team_id: sub.custom_data?.team_id,
  paddle_customer_id: sub.customer_id,
  plan_key, price_key, billing_cycle  <- mapped (or previous),
  paddle_price_id: item.price.id,
  status: sub.status, quantity: item.quantity, currency_code: sub.currency_code,
  trial_ends_at: item.trial_dates?.ends_at,
  current_period_start: sub.current_billing_period?.starts_at,
  current_period_end:   sub.current_billing_period?.ends_at,
  cancel_at_period_end: sub.scheduled_change?.action == "cancel",
  scheduled_change: sub.scheduled_change, discount_id: sub.discount?.id,
  paused_at: sub.paused_at, canceled_at: sub.canceled_at,
  plan_started_at: (new row or plan_key changed) ? now : previous,
  last_event_at: occurred_at
}
trial bookkeeping (§3)
audit subscription_synced {source, from, to}   # reconciliation: only when status/plan/cancel flag changed
```

## 5. Change plan

`POST /api/billing/change-plan/preview { priceKey, quantity? }` and `POST /api/billing/change-plan { … }`:

```
sub = the account's entitled individual subscription (team subs go through §8), else 400 no_subscription
target = price lookup(priceKey); same kind (individual vs seat) as the current one, else 400
if sub.status == "trialing": target_id = id(priceKey + "_trial") if it exists, else id(priceKey)
else:                        target_id = id(priceKey)
items = sub.items with the app item's price replaced by target_id, quantities kept   # items REPLACE: always send all
body  = { items, proration_billing_mode: "prorated_immediately", on_payment_failure: "prevent_change" }
preview: PATCH /subscriptions/{id}/preview body ->
   { immediateCharge: update_summary.charge / immediate_transaction totals, credit: update_summary.credit,
     nextBilledAt: next_billed_at, nextAmount: next_transaction.details.totals.total }  (amounts via from_minor)
   audit plan_change_previewed
apply:   PATCH /subscriptions/{id} body
   payment declined -> Paddle returns an error; map to 402 payment_failed (the change isn't applied)
   sync_from_paddle(response, now, "change_plan"); audit plan_changed {from, to}
```
Changes during a trial: **verify in sandbox** (test matrix). If Paddle rejects the item
swap on a trialing subscription, return `409 change_during_trial` with the message "You
can change plans once your trial ends, or cancel and pick another plan."

## 6. Cancel / resume

- `POST /api/billing/cancel` → `POST /subscriptions/{id}/cancel { effective_from: "next_billing_period" }`
  → sync; audit `cancel_scheduled`. If a cancel is already scheduled, return `{ ok, alreadyScheduled: true }`.
- `POST /api/billing/resume` → `PATCH /subscriptions/{id} { scheduled_change: null }` → sync; audit `cancel_removed`.
- Admin immediate cancel (refund flow only): `effective_from: "immediately"`.

## 7. Portal, invoices, status

- `POST /api/billing/portal { intent }` → `POST /customers/{ctm}/portal-sessions { subscription_ids: [sub.id] }`.
  URL choice: `update_payment` → `urls.subscriptions[0].update_subscription_payment_method`;
  `cancel` → `urls.subscriptions[0].cancel_subscription`; otherwise `urls.general.overview`.
  Fall back to overview when the specific one is missing.
- `GET /api/billing/status` → contract §7 shape from the local row, plus `invoices` built as in
  `refunds-and-reconciliation.md` (Paddle calls; on failure return `invoices: []` and
  `invoicesError: true`, never a 500 for the whole status).
- `entitled` = contract §8. `past_due` → the UI shows the update-payment banner.

## 8. Teams (per-seat)

The team is the app's own multi-user entity (`team_id`). The buyer must be allowed to
manage it (an app-specific hook `can_manage_billing(user, team)`).

```
POST /api/team/checkout { priceKey (a seat price), seats, discountCode? }
  409 if the team already has an entitled subscription
  seats >= max(1, current members who should get seats)  (1..maxSeats)
  customer = ensure_customer(buyer account)
  POST /transactions { items:[{price_id, quantity: seats}], customer_id, discount_id?,
                       custom_data:{ app, account_id: buyer, user_id, team_id, purchase:"team_subscription", trial:false } }
POST /api/team/seats/preview { seats }  -> PATCH /subscriptions/{id}/preview (quantity changed), same response shape as §5
POST /api/team/seats { seats }
  409 seats_in_use if seats < assigned count
  PATCH /subscriptions/{id} { items (quantity replaced), proration_billing_mode:"prorated_immediately", on_payment_failure:"prevent_change" }
  sync; audit seats_changed
POST /api/team/seats/assign { userId }    409 no_free_seat when assigned == quantity; insert billing_team_seats; audit seat_assigned
POST /api/team/seats/unassign { userId }  delete; audit seat_unassigned
```
Seat prices have no trial. A user who gets a seat keeps their own individual
subscription, if any (not auto-canceled). The billing UI tells them "You're covered
by your team's plan. You can cancel your personal plan," with a button to §6 cancel.

## 9. Entitlement: `effective_plan(user)`

```
candidates = []
if individual sub for user's account is entitled: candidates += sub.plan_key
if user has a billing_team_seats row and that team's sub is entitled: candidates += team_sub.plan_key
return highest-ranked candidate (catalog order, §1) or "free" (or the app's no-plan value)
```
Every feature gate calls this. Never read `status` directly in feature code.

## 10. Dynamic-mode admin: plans

`GET/POST/PATCH /api/admin/billing/plans[/:key]` edit a subscription product + its
prices (+ `trialDays`, `seat`) with the same validation as the catalog schema. On
money changes with policy `ask`, the admin form **must** show the choice: "Keep existing
subscribers on the old price (grandfather)" vs "Move them at their next renewal
(migrate). Notify customers first". It sends `priceChangePolicy` with the request.
Then run `catalog_sync.push` (catalog-sync.md). The list view shows a `syncStatus` badge
and a Retry button.

## 11. Webhook events handled by this skill

`subscription.created|updated|activated|trialing|past_due|paused|resumed|canceled` → §4.
`transaction.payment_failed` → audit only. `adjustment.*` → refunds. Everything else per `webhooks.md`.
