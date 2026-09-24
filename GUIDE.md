# Paddle Billing Skills — User Guide

A Claude Code plugin that makes every project's Paddle integration **the same**, whether
it's Express, Next.js, FastAPI, Laravel, Spring or GeneXus, and asks only a handful of
questions (usually none after the first time).

- [1. What's inside](#1-whats-inside)
- [2. Install](#2-install)
- [3. How the skills keep projects identical](#3-how-the-skills-keep-projects-identical)
- [4. Start a new project](#4-start-a-new-project)
- [5. The catalog file](#5-the-catalog-file-paddlecatalogjson)
- [6. Fixed vs dynamic plans](#6-fixed-vs-dynamic-plans)
- [7. The sync script (sandbox and live)](#7-the-sync-script-sandbox-and-live)
- [8. Discounts & promo codes](#8-discounts--promo-codes)
- [9. Changing prices](#9-changing-prices)
- [10. Ebook vs digital goods](#10-ebook-vs-digital-goods)
- [11. Going live](#11-going-live)
- [12. Migrating an existing Paddle project (e.g. Slaxify)](#12-migrating-an-existing-paddle-project-eg-slaxify)
- [13. Updating the skills](#13-updating-the-skills)
- [14. FAQ](#14-faq)

---

## 1. What's inside

| Skill | Use it for |
|---|---|
| `paddle-billing:paddle-subscription` | SaaS subscriptions: monthly/yearly plans, **one free trial per account**, team/per-seat plans, upgrade/downgrade with preview, cancel/resume, past-due, customer portal, invoices, admin refunds |
| `paddle-billing:paddle-digital-goods` | One-time, lifetime purchases: code snippets, templates, media, software licences, courses, credits, and PDFs sold without the ebook tax category |
| `paddle-billing:paddle-ebook` | PDF ebooks under Paddle's **ebooks** tax category (needs Paddle approval) |
| `paddle-billing:paddle-core` | The shared contract + sync scripts. Loaded automatically by the three above; call it directly for "sync my catalog" / "check my Paddle env" |

All of them include **discount/promo-code sync** (your app → Paddle) and use the same
**sync script** to create everything on sandbox or live.

```
paddle-billing-skills/
├── GUIDE.md                        ← this file
├── .claude-plugin/marketplace.json
├── tests/                          ← mock Paddle API + tests for both sync scripts
└── plugins/paddle-billing/
    ├── .claude-plugin/plugin.json
    └── skills/
        ├── paddle-core/            SKILL.md, references/ (contract, schema, webhooks, stacks/…),
        │                           scripts/ (paddle-sync.mjs, paddle_sync.py), templates/
        ├── paddle-subscription/    SKILL.md, references/subscription-flows.md
        ├── paddle-digital-goods/   SKILL.md, references/fulfillment-types.md
        └── paddle-ebook/           SKILL.md, references/ebook-specifics.md
```

## 2. Install

Once per machine:

```bash
claude plugin marketplace add behestee/paddle-billing-skills
claude plugin install paddle-billing@paddle-billing-skills
```

Or, inside Claude Code: `/plugin marketplace add behestee/paddle-billing-skills`, then `/plugin install paddle-billing@paddle-billing-skills`.

Start a new Claude Code session. The skills then show up in every project.

To get new versions later: `claude plugin marketplace update paddle-billing-skills`.

**VS Code:** the Claude Code extension shares plugin settings with the CLI (`~/.claude`).
Either run the two commands above in the integrated terminal, or type `/plugin` in the
Claude panel's chat input and add the marketplace `behestee/paddle-billing-skills`, then
install `paddle-billing`. Start a new conversation (or reload the window) afterwards.

**Enable for a whole team (per project):** commit this to the project's
`.claude/settings.json`. Teammates are asked to install the plugin when they trust the
folder, in both the CLI and VS Code:

```json
{
  "extraKnownMarketplaces": {
    "paddle-billing-skills": {
      "source": { "source": "github", "repo": "behestee/paddle-billing-skills" }
    }
  },
  "enabledPlugins": {
    "paddle-billing@paddle-billing-skills": true
  }
}
```

**Local development:** to try unpushed changes, add your clone instead:
`claude plugin marketplace add ~/Developments/paddle-billing-skills`.

**Official `paddle` plugin:** if it's also installed, the two plugins' skills can both
trigger. This plugin's contract says it takes precedence in projects that have a
`paddle.catalog.json`. To remove all doubt, invoke this plugin's skills explicitly
(`/paddle-billing:paddle-subscription`) or disable the official one
(`claude plugin disable paddle`).

## 3. How the skills keep projects identical

1. **One contract** (`paddle-core/references/contract.md`). Env var names, the catalog file,
   DB table/column names, endpoint paths and JSON, webhook handling, statuses and money
   rules are identical in every language. Code is idiomatic per stack; *names and
   behaviour* are not up for discussion.
2. **Decisions are pre-made.** Things that used to trigger questions (SDK or REST? overlay or
   redirect? which webhook events? proration? cancel now or at period end? how trials
   work? where promo codes live?) are fixed in the contract's "Fixed decisions" table.
3. **Decisions are remembered.** Each project's `paddle.catalog.json` records its stack,
   mode, skills and catalog. The skills read it and don't ask again.
4. **A question budget.** Each skill may ask at most one round of up to 4 questions, and
   only for what it can't detect (usually: confirm the drafted plans, fixed or dynamic,
   and trial length).
5. **One sync script, two runtimes.** `paddle-sync.mjs` (Node) and `paddle_sync.py`
   (Python) behave identically. The `tests/` folder proves it: both run the same scenarios
   against a mock Paddle, and the output and resulting state are compared byte for byte.

## 4. Start a new project

In the project folder, in Claude Code, just say what you want, for example:

> Add Paddle subscription billing with Starter and Pro plans, monthly and yearly, 14-day trial.

> Sell my three UI kits as one-time downloads with Paddle.

> Sell my PDF book with Paddle under the ebook tax category.

What happens:
1. The skill detects your stack, DB, auth/account model and any existing pricing.
2. It asks **one** short round of questions (with recommendations) only if needed.
3. It writes `paddle.catalog.json`, copies the sync script into `scripts/`, adds env
   keys to `.env.example`, creates migrations, backend modules, routes, frontend pieces,
   jobs and tests, all per the contract.
4. It gives you the commands for the sandbox sync and the dashboard steps.

## 5. The catalog file (`paddle.catalog.json`)

Committed in the project root. Templates are in `paddle-core/templates/`. The most
important fields:

```jsonc
{
  "contractVersion": 1,
  "app": "myapp",                 // namespace: several apps can share one Paddle account safely
  "mode": "fixed",                // fixed | dynamic (section 6)
  "skills": ["subscription"],
  "project": { "backend": "fastapi", "frontend": "react", "database": "postgres" },
  "currency": "USD",
  "priceChangePolicy": "ask",     // ask | grandfather | migrate (section 9)
  "products": [
    { "key": "pro", "kind": "subscription", "name": "MyApp Pro",
      "prices": [ { "key": "pro_monthly", "amount": "19.99", "interval": "month", "trialDays": 14 } ] }
  ],
  "discounts": [
    { "key": "launch50", "code": "LAUNCH50", "description": "50% off 3 months",
      "type": "percentage", "amount": "50", "recur": true, "maxRecurringIntervals": 3 }
  ]
}
```

Full field reference: `paddle-core/references/catalog-schema.md`. The script rejects
unknown fields, so typos are caught.

**Trials:** for each price with `trialDays`, the script also creates a `<key>_trial` price
(card required). The app gives the trial price only to accounts (and emails) that never
had a trial or a subscription before. Everyone else gets the normal price.

## 6. Fixed vs dynamic plans

| | **Fixed** | **Dynamic** |
|---|---|---|
| Plans defined in | `paddle.catalog.json` | the app's admin UI (DB) |
| Pushed to Paddle by | the sync script (you run it) | the app itself, when an admin saves a plan |
| IDs live in | `.env` (`PADDLE_PRICE_PRO_MONTHLY=pri_…`) + `paddle.<env>.lock.json` | DB columns |
| Choose when | plans change rarely, developers deploy changes | non-developers manage plans, or plans vary a lot |

In dynamic mode the script still sets up the webhook and checks the env. Products in the
catalog file become a **seed** that is imported into the DB on first boot.

## 7. The sync script (sandbox and live)

The skill copies it to `scripts/` in your project. The commands are the same in every
project (Python: replace `node scripts/paddle-sync.mjs` with `python3 scripts/paddle_sync.py`):

```bash
node scripts/paddle-sync.mjs plan      # dry run: shows what would change
node scripts/paddle-sync.mjs           # apply: creates/updates on Paddle, writes .env + lock file
node scripts/paddle-sync.mjs check     # verifies every ID in .env exists in this environment
```

**Which environment?** The script reads `PADDLE_ENV` from **the env file it writes to**.
That makes it impossible to put sandbox IDs into a live file:

```bash
# local, sandbox
node scripts/paddle-sync.mjs                               # uses ./.env (PADDLE_ENV=sandbox)
# production — run on the server, or locally against a production env file
node scripts/paddle-sync.mjs --env-file .env.production    # shows the plan, asks you to type "yes"
```

It refuses a live API key in a sandbox file (and the reverse), and flags a malformed key
(the "lost first character on paste" incident).

**What it creates:** products, prices (+ trial variants), discounts, and, when
`PADDLE_WEBHOOK_URL` is set, the webhook destination. It then writes
`PADDLE_WEBHOOK_SECRET` for you. Sandbox destinations also receive the webhook simulator's events.

**What it writes:** `PADDLE_PRODUCT_*`, `PADDLE_PRICE_*`, `PADDLE_PRICE_*_TRIAL`,
`PADDLE_DISCOUNT_*`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_NOTIFICATION_SETTING_ID`,
`PADDLE_CATALOG_MODE`, `PADDLE_SYNCED_AT`. Existing lines are updated in place, and new ones
go under a "managed" marker. A backup goes to `.env.paddle-backup`, which contains secrets
and must be gitignored (the skill does this). `paddle.sandbox.lock.json` /
`paddle.production.lock.json` contain IDs only and are safe to commit.

**Idempotent:** run it as often as you like. A second run says "No changes needed."

**Useful flags:** `--only products,discounts,webhook`, `--prune` (archive app-owned
entities you removed from the catalog), `--yes` (CI), `--price-change grandfather|migrate`.

**Exit codes:** `0` ok · `1` error · `2` a decision is needed (price-change policy or production confirmation).

## 8. Discounts & promo codes

- **Your app is the source of truth.** Fixed mode: define codes under `discounts` in the
  catalog and sync. Dynamic mode: admins create/edit/archive them in the app's admin UI,
  and the app pushes each change to Paddle (a "Not synced — Retry" badge shows if Paddle
  was unreachable).
- Customers can enter a code in **your** pricing page (validated by
  `POST /api/billing/discounts/validate`) or inside the **Paddle overlay** (if
  `checkout.allowDiscountEntry` is true). Both work because every code exists in Paddle.
- Supported: percentage / flat / flat-per-seat; recurring for N billing periods; usage
  limit; expiry; restricted to specific products or prices (a restriction to `pro_monthly`
  automatically covers its trial variant too).
- Usage counts flow back from Paddle webhooks (`times_used`).

## 9. Changing prices

Paddle prices are never edited in place. When `amount`, currency, interval, trial or
country overrides change, the script creates a **new** price and archives the old one.
For subscription prices you choose what happens to existing subscribers:

| Policy | Effect |
|---|---|
| `grandfather` | existing subscribers keep paying the old price; new buyers pay the new price |
| `migrate` | existing subscribers move to the new price at their **next renewal**, with nothing charged now. **Tell customers first** |
| `ask` (default) | the script asks you each time (`[g]randfather / [m]igrate / [a]bort`), before changing anything. In CI, pass `--price-change …` |

Names, descriptions and quantity limits are simply updated in place. Grandfathered
subscribers keep working because the app maps prices by their `custom_data.app_key`, not
only by ID.

In dynamic mode the admin's plan edit form shows the same choice.

## 10. Ebook vs digital goods

- **Digital goods** covers every digital item, ebooks included. It uses the `standard`
  tax category, which every Paddle account has from day one: **no approval wait**.
- **Ebook** uses Paddle's `ebooks` tax category (lower VAT/GST in many regions). Paddle has
  to **approve** this category after reviewing your site. The skill lists what the review
  looks for (book pages, author, format, refund policy, and so on).
- You can start with digital goods and switch later: change the book's `kind` to `ebook`
  and sync. Buyers and prices are untouched.
- `saas` (subscriptions) and `digital-goods` categories also need approval. Slaxify's
  `saas` approval is an example.

## 11. Going live

The full checklist is in `paddle-core/references/testing-and-go-live.md`. In short:
1. Paddle approves the live account, domain and tax categories.
2. Live dashboard: API key, client-side token, **Default payment link** (`https://<domain>/pay`).
3. Production env file: live keys, `PADDLE_ENV=production`, `PADDLE_WEBHOOK_URL=https://<domain>/webhooks/paddle`.
4. `node scripts/paddle-sync.mjs --env-file .env.production plan` → review → run without `plan` → type `yes`.
5. `… check` on the server.
6. One real purchase with a real card, then refund it from the admin screen.

## 12. Migrating an existing Paddle project (e.g. Slaxify)

Slaxify (the project these skills are based on) is built on the Node SDK, dual
Stripe/Paddle support, and name/amount matching in its setup script. To bring it (or
any older project) onto the contract, ask Claude in that project:

> Migrate our Paddle integration to the paddle-billing contract.

The skill produces a gap list first and asks before changing anything. The sync
script **adopts** existing Paddle products/prices/discounts (same product name, same
money fields, same code) by stamping them with `custom_data`, so live subscribers aren't
disturbed.

Main differences from the Slaxify code:

- the checkout transaction is created server-side (the browser no longer passes price IDs);
- customers are stored per environment;
- price mapping uses `custom_data.app_key`, and an unmapped price keeps the previous plan instead of falling back to Free;
- webhooks are deduplicated by `event_id` and guarded against stale events;
- trials are once per account;
- promo codes are synced.

## 13. Updating the skills

Edit the files in `~/Developments/paddle-billing-skills`, run the tests, bump
`version` in both `plugin.json` and `marketplace.json`, and commit:

```bash
cd ~/Developments/paddle-billing-skills
node tests/run-tests.mjs            # both sync scripts, same scenarios, outputs compared
claude plugin validate .
claude plugin marketplace update paddle-billing-skills
```

If you change the **contract** in a breaking way, bump `contractVersion` (and the scripts'
`CONTRACT_VERSION`), and note the migration steps in `CHANGELOG.md`. Existing projects stay
pinned to their version until you ask Claude to upgrade them.

**Rule:** any behaviour change in one sync script must be made in the other one too.
The tests fail if their outputs differ.

## 14. FAQ

**Can two apps share one Paddle account?** Yes. Everything is tagged `custom_data.app`, so
the scripts and webhooks only touch their own app's entities. Each app needs its own webhook URL.

**Where do I get the client token / API key?** Paddle Dashboard → Developer tools → Authentication.
The sandbox and live dashboards are separate.

**My tunnel URL changed.** Update `PADDLE_WEBHOOK_URL` in `.env` and run
`node scripts/paddle-sync.mjs --only webhook`. That creates a destination for the new URL
and writes its secret. Archive the old destination in the dashboard now and then.

**The overlay shows a generic error.** Set the Default payment link (section 11 step 2). It's the most common cause.

**A customer paid but the app shows no plan.** Check the admin billing log
(`billing_events`) for `price_mapping_failed` or `customer_id_repaired`, then run
`POST /api/admin/billing/reconcile`.

**Why no Paddle SDK?** SDKs differ per language (camelCase vs snake_case, different
helpers, different versions). A 60-line REST client per stack with Paddle's raw field names is
what makes the implementations identical.
