---
name: paddle-subscription
description: Build or extend Paddle Billing SaaS subscriptions in any stack (Node/Express, Next.js, FastAPI, Laravel, Spring, GeneXus; React/Angular/vanilla frontends) following the shared paddle-billing contract, so every project gets the identical implementation — plans with monthly/yearly prices, one-time-per-account free trials, team/per-seat plans, upgrade/downgrade with proration preview, cancel/resume, past_due handling, customer portal, invoice history with refunds, promo codes synced app→Paddle, admin refunds, webhooks and reconciliation, with fixed (.env) or dynamic (admin-managed) plans. Use when the user wants subscription billing, recurring plans, SaaS pricing, or trials with Paddle.
---

# paddle-subscription

Builds Paddle subscription billing **exactly** as the contract defines. Load the core first.

## Step 0 — Load the contract (mandatory)

Read `../paddle-core/SKILL.md`, then `../paddle-core/references/contract.md` and
`../paddle-core/references/pitfalls.md`. Then read `references/subscription-flows.md`
(this skill). Read the other core references when you reach the step that needs them.

## Step 1 — Discover, don't ask

1. If `paddle.catalog.json` exists → its `mode`, `project`, `skills`, products and
   discounts are **decided**. Don't ask about them again. Add `"subscription"` to `skills` if missing.
2. Otherwise detect:
   - backend: `package.json` (+ `next` → nextjs, else express), `pyproject.toml`/`requirements.txt` (fastapi/django/flask), `composer.json` (laravel), `pom.xml`/`build.gradle` (spring), `*.gx*`/KB folders (genexus);
   - frontend: react / next / @angular/core / blade / thymeleaf / none;
   - database: ORM config, migrations folder, `DATABASE_URL` scheme;
   - billing account entity: the model that owns data (User, Organization, Workspace, Team);
   - existing billing code (Stripe, Cashier, an old Paddle integration) → see Step 1b;
   - existing pricing (a pricing page, a plans constant) → pre-fill the catalog from it.
3. Map the stack to `../paddle-core/references/stacks/<stack>.md`.

**Step 1b: existing Paddle integration** (like the reference project): don't rewrite it
silently. Produce a short gap list against the contract and ask once: "migrate to the
contract (recommended) or extend in place?". The sync script adopts legacy
products/prices/discounts automatically (same name / same money fields / same code).

## Step 2 — The question budget

Ask **only** the items below that Step 1 couldn't settle, in **one** `AskUserQuestion`
call (max 4 questions), each with a recommended option first:

| # | Ask only if | Question | Recommended |
|---|---|---|---|
| 1 | no catalog | Plans & prices: show a drafted catalog (from the existing pricing, or the template) and ask to confirm/adjust | the draft |
| 2 | no catalog | Catalog mode: fixed (.env via script) or dynamic (admin UI creates plans on Paddle) | fixed, unless non-developers must edit plans |
| 3 | ambiguous | Which entity is billed (user vs organization/workspace)? | the entity that owns the data |
| 4 | no catalog | Trial length per plan (0 = none) | 7 or 14 days |

Everything else is **fixed** by the contract. Never ask about: SDK vs REST, checkout
style, webhook events, proration mode, cancel timing, trial rules, seat behaviour,
refund flow, table names, endpoint paths, the promo-code direction, or the price-change
policy (default `ask`, which is recorded in the catalog; the operator answers at sync time).

## Step 3 — Write the manifest

Create or update `paddle.catalog.json` from `../paddle-core/templates/paddle.catalog.subscription.json`
(schema: `catalog-schema.md`). Team seat prices are included by default (a separate
`team_<plan>` product sharing `plan` with the individual one). The user may delete them if
the app has no multi-user concept. The team module is still generated and simply stays unused.

## Step 4 — Scaffold (in this order; stack file shows the idioms)

1. Copy `../paddle-core/scripts/paddle-sync.mjs` (or `paddle_sync.py`) → `scripts/`. Append
   `../paddle-core/templates/env.example` to `.env.example` (not `.env`). Add `.env.paddle-backup` to `.gitignore`.
2. Migrations: the subscription tables from `database-schema.md`: `billing_customers`,
   `billing_subscriptions`, `billing_trial_usages`, `billing_team_seats`,
   `billing_discounts`, `billing_support_requests`, `paddle_webhook_events`, `billing_events`
   (+ `billing_catalog_products` / `billing_catalog_prices` in dynamic mode).
3. Modules from contract §6: `config`, `paddle_client`, `audit`, `catalog`, `customers`,
   `discounts`, `checkout`, `webhooks`, `subscriptions`, `teams`, `refunds`,
   `reconciliation` (+ `catalog_sync` in dynamic mode).
4. Routes: exactly the Shared + Subscription rows of contract §7 (+ admin plans in dynamic mode).
5. Frontend: `paddle-client` module (frontend.md), pricing page, checkout button, success
   page (polling), billing settings (status, change plan with preview, cancel/resume,
   portal, invoices, support request), past_due banner, team seats UI, admin screens
   (discounts, refunds queue, billing log, and plans in dynamic mode).
6. A `/pay` page that loads Paddle.js (the Default payment link target).
7. Jobs: reconciliation (60 s after boot, then every 6 h), and in dynamic mode the sync retry job (10 min).
8. Entitlement helper `effective_plan(user)` (subscription-flows.md §9), used by every feature gate.

## Step 5 — Tests (must exist and pass)

- Signature verifier with the fixed vector in `webhooks.md` §7.
- Webhook idempotency (same `event_id` twice → one effect) and the stale-event guard.
- `map_price`: custom_data key, `_trial` suffix, archived price in the lock/DB, unknown → previous plan kept.
- Trial eligibility (new account, same email on a new account, previously paid account).
- Checkout builds the correct transaction body (trial vs non-trial price, discount, custom_data).
- Change-plan items replacement keeps other items; seats can't drop below the assigned count.

## Step 6 — Hand-off

Tell the user, briefly: files created, the exact commands to run (`plan`, then `sync` on
sandbox, and `check`), the dashboard steps from `testing-and-go-live.md` (Default payment
link, client token, tunnel), and the test matrix to walk through. Don't run a sync against
production.
