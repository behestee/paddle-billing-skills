---
name: paddle-digital-goods
description: Build or extend one-time Paddle Billing purchases of digital goods with lifetime access — code snippets, coding resources, templates/UI kits, media files, courses, credits, license-keyed software, and ebooks sold without the ebook tax category — in any stack (Node/Express, Next.js, FastAPI, Laravel, Spring, GeneXus) following the shared paddle-billing contract, so every project gets the identical implementation: server-created checkout, guest or logged-in buyers, secure expiring downloads with limits, license keys, access grants, promo codes synced app→Paddle, refunds that revoke access, webhooks and reconciliation, with a fixed (.env) or dynamic (admin-managed) catalog. Use for any non-subscription, no-shipping digital sale with Paddle.
---

# paddle-digital-goods

One-time purchases, lifetime access, nothing shipped physically. Load the core first.

**Digital goods vs ebook skill.** Digital goods covers *everything* digital, ebooks
included. Use `paddle-ebook` only when the seller wants Paddle's **`ebooks` tax
category** (lower VAT/GST in many regions), which needs Paddle's approval after a site
review. To sell PDFs without waiting for that approval, use this skill: products are
taxed as `standard`, which every Paddle account has from day one.

## Step 0 — Load the contract (mandatory)

Read `../paddle-core/SKILL.md`, `../paddle-core/references/contract.md`,
`../paddle-core/references/pitfalls.md`, `../paddle-core/references/one-time-purchases.md`,
then `references/fulfillment-types.md` (this skill).

## Step 1 — Discover, don't ask

Same discovery as `paddle-subscription` Step 1 (catalog file first, then detect backend /
frontend / DB / account entity / existing billing code / existing product list). Also detect:
- file storage: S3/R2/GCS/Azure SDK or config, Laravel `filesystems.php`, Spring/Boot storage
  props → use it; otherwise a private local directory `storage/private/goods/` (outside the web root);
- email sending (SMTP / Mailgun / SES / Laravel Mail / Spring Mail): needed for guest links;
- auth: whether guest checkout makes sense (a public storefront → yes).

## Step 2 — The question budget

At most one `AskUserQuestion` call, only for what Step 1 couldn't settle:

| # | Ask only if | Question | Recommended |
|---|---|---|---|
| 1 | no catalog | Products, prices and fulfillment type per product (show a drafted catalog) | the draft |
| 2 | no catalog | Catalog mode: fixed or dynamic (admin adds products) | fixed, unless non-developers add products |
| 3 | not detectable | File storage: S3-compatible bucket (presigned URLs) or private local disk | S3-compatible |
| 4 | not detectable | Allow guest checkout (buy with just an email)? | yes |

Fixed by the contract, never asked: tax category default (`standard`), download
limits/TTL defaults (5 downloads, 60-minute links, 30-day emailed tokens), license key
format, refund = revoke, checkout flow, promo-code direction, endpoints, tables.

## Step 3 — Manifest

Create/update `paddle.catalog.json` from `../paddle-core/templates/paddle.catalog.digital-goods.json`.
Add `"digital-goods"` to `skills`. One-time prices have no `interval`. Use
`allowQuantity` only for things that make sense in multiples (license seats, credit packs).

## Step 4 — Scaffold (order matters)

1. Copy the sync script to `scripts/`; env example (incl. `DOWNLOAD_SIGNING_SECRET`); gitignore the backup.
2. Migrations: `billing_customers`, `billing_purchases`, `billing_purchase_items`,
   `billing_entitlements`, `billing_discounts`, `billing_support_requests`,
   `paddle_webhook_events`, `billing_events` (+ catalog tables in dynamic mode).
3. Modules: `config`, `paddle_client`, `audit`, `catalog`, `customers`, `discounts`,
   `checkout`, `webhooks`, `purchases` (fulfil, downloads, tokens, library, resend,
   revoke), `refunds`, `reconciliation` (+ `catalog_sync`).
4. Routes: Shared + "Digital goods / ebook" rows of contract §7 (+ `/api/admin/store/products` in dynamic mode).
5. Frontend: storefront/product pages, buy button (guest email field when logged out),
   discount field, success page (polls purchases), "My library", resend-links form,
   admin: discounts, refunds queue, billing log, products (dynamic mode).
6. `/pay` page (Default payment link target). Purchase email template.
7. Jobs: reconciliation daily (one-time) + 6-hourly if the project also has subscriptions.
8. `claim_guest_purchases` on signup / email verification.

## Step 5 — Tests (must exist and pass)

Signature vector; idempotent fulfilment (same `transaction.completed` twice → one
purchase); quantity → N entitlements; license keys unique and correctly formatted; download
counter race (two parallel requests at the limit → one wins); token tamper/expiry → 410;
full and partial refund revocation; `already_owned`; guest claim on signup.

## Step 6 — Hand-off

As in `paddle-subscription` Step 6, plus: where to put the files (storage path per
`fulfillment.files[].path`), and a reminder that files must never be publicly readable.
