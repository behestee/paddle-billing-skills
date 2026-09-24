# Refunds, support requests & reconciliation (contract v1)

## Why refunds are admin-only

Paddle is the merchant of record. Refunds are *submitted* by the seller
(`POST /adjustments`) and **reviewed by Paddle**, so the initial status is usually
`pending_approval`. Customers can't refund themselves. They raise a support request, and an
admin decides.

## Customer: `POST /api/billing/support-request`

`{ topic: refund|paid_not_activated|other, message (1..4000 chars), transactionId? }`
→ insert `billing_support_requests` (status `open`), audit `support_request`, email
`SUPPORT_EMAIL` if configured. Return `{ ok, requestId }`. `transactionId` must belong to
the caller (check through `billing_purchases` or the subscription's transactions) or be null.

## Admin: `POST /api/admin/billing/refunds`

```
input: { transactionId, type: "full"|"partial", reason (required, shown in Paddle), items?: [{ itemId, type:"full"|"partial", amount? }],
         cancelSubscription?: bool, supportRequestId?, confirm: true }
require confirm == true (UI shows an "irreversible" dialog)
409 if billing_support_requests.refund_adjustment_id already set for this request
txn = GET /transactions/{id}          # ownership/app check: custom_data.app == APP
adj = POST /adjustments { action: "refund", type, transaction_id, reason, items? }
update support request: refund_adjustment_id, refund_status = adj.status, status = resolved (if linked)
audit refund_submitted { adjustmentId, status }
if cancelSubscription and txn.subscription_id: POST /subscriptions/{id}/cancel { effective_from: "immediately" }
return { adjustment: { id, status } }
```
The admin UI says: *"Submitted to Paddle. Paddle reviews refunds, so 'pending_approval'
is normal. The customer is paid back once approved."*

A subscription refund does **not** cancel the subscription by itself (hence
`cancelSubscription`). A one-time refund revokes entitlements, but only once the
adjustment is **approved** (one-time-purchases.md).

## Webhook: `adjustment.created` / `adjustment.updated`

```
support = billing_support_requests WHERE refund_adjustment_id = adj.id -> refund_status = adj.status
audit refund_status_changed { adjustmentId, action, status }
one-time purchase -> purchases.on_adjustment (revocation rules)
```

## Invoice history (shown to customers)

`GET /transactions?customer_id=<ctm>&status=completed,past_due&per_page=30&include=adjustments_totals`
(`include` returns `details.adjusted_totals` = net of refunds). Also
`GET /adjustments?customer_id=<ctm>&per_page=50`, so refunds are shown against each
transaction. Show only `refund`/`chargeback` actions whose status isn't `rejected` as
"Refunded". A refund does **not** change the transaction's own status. PDF via
`GET /transactions/{id}/invoice` → `data.url` (short-lived, so fetch on click through
`/api/billing/invoices/:transactionId/pdf`, never at list time).

## Reconciliation job

Runs 60 s after boot, then every `BILLING_RECONCILE_HOURS` (default 6). Also runs
on demand via `POST /api/admin/billing/reconcile`.

```
subscriptions: for each local row with status in (active, trialing, past_due, paused):
    live = GET /subscriptions/{id}
      not_found -> mark canceled (status canceled, canceled_at now)
      found     -> subscriptions.sync_from_paddle(live, occurred_at = live.updated_at, source="reconciliation")
      other error -> count, continue (never mark canceled on a transient error)
one-time: see one-time-purchases.md "Reconciliation"
discounts / dynamic catalog: re-push rows with sync_status in (pending, failed)
audit reconciliation_run { checked, changed, errors } (only write subscription_synced rows when something changed)
```
