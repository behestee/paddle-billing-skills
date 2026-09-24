---
name: paddle-core
description: Shared foundation for every Paddle Billing integration built with the paddle-billing plugin — the language-neutral contract (env vars, paddle.catalog.json, DB schema, endpoint paths, webhook rules), the catalog/discount sync scripts (Node + Python) that create products, prices, trial variants, promo codes and the webhook destination on Paddle sandbox or live and write the IDs into .env, and per-stack references (Express, Next.js, FastAPI, Laravel, Spring, GeneXus). Use directly to run/repair catalog sync, check a project's Paddle env, or answer "how does our Paddle contract say X"; it's loaded automatically by paddle-subscription, paddle-digital-goods and paddle-ebook.
---

# paddle-core

This skill is the **shared contract** behind `paddle-subscription`, `paddle-digital-goods`
and `paddle-ebook`. Its job is to make every project's Paddle integration **identical**
(same names, endpoints, tables, rules) whatever the stack, and to stop the "every
project asks different questions and builds it differently" problem.

## Precedence

For any project that has (or is getting) a `paddle.catalog.json`, this contract
**overrides** other Paddle guidance, including the official `paddle` plugin's skills
(which assume Next.js + the Node SDK). Don't mix approaches. If something is missing
from the contract, implement it as an extension *beside* contract code and tell the user.

## Files — read in this order when building

| File | When |
|---|---|
| `references/contract.md` | **Always, first.** Fixed decisions, env vars, keys/custom_data, REST client rules, module layout, endpoint contract, statuses, money, audit events |
| `references/pitfalls.md` | Always. Real production failures the contract prevents |
| `references/catalog-schema.md` | Writing or validating `paddle.catalog.json` |
| `references/catalog-sync.md` | Fixed vs dynamic mode, price-change policy, runtime sync algorithm |
| `references/database-schema.md` | Migrations |
| `references/customers.md` | Customer identity per environment, guest buyers, boot checks |
| `references/webhooks.md` | Webhook endpoint, signature, idempotency, routing, ordering, attribution |
| `references/discounts.md` | Promo codes: app → Paddle, validation, checkout, webhook feedback |
| `references/refunds-and-reconciliation.md` | Admin refunds, support requests, invoices, reconciliation job |
| `references/one-time-purchases.md` | Only for digital goods / ebooks |
| `references/frontend.md` | Paddle.js client for any JS frontend / GeneXus |
| `references/stacks/<stack>.md` | The project's backend stack (`node-express`, `nextjs`, `fastapi`, `laravel`, `spring`, `genexus`) |
| `references/testing-and-go-live.md` | Sandbox test matrix + production checklist |
| `scripts/paddle-sync.mjs`, `scripts/paddle_sync.py` | Catalog sync, identical behaviour (Node 18+ / Python 3.9+, no dependencies) |
| `templates/` | Catalog examples per skill, `env.example` |

Paths are relative to this skill's base directory. Sibling skills refer to it as `../paddle-core/`.

## Running the sync scripts

Always copy the script into the project first (`scripts/`), unmodified, so CI and
servers don't depend on the plugin:

```bash
cp <paddle-core>/scripts/paddle-sync.mjs scripts/      # or paddle_sync.py for Python-only projects
node scripts/paddle-sync.mjs plan                       # dry run against the env in ./.env
node scripts/paddle-sync.mjs                            # apply; writes .env + paddle.<env>.lock.json
node scripts/paddle-sync.mjs check                      # verify IDs exist in the current environment
node scripts/paddle-sync.mjs --env-file .env.production # production (asks for "yes")
```

Rules for you (Claude) when running them:
- Run `plan` and `check` freely. Run the applying `sync` against **sandbox** only when the
  user asked for it. **Never** run it against production (`PADDLE_ENV=production`)
  yourself. Give the user the command instead.
- Exit code 2 = a decision is needed (a price-change policy or production confirmation).
  Relay the question with the script's own wording. Don't pick for the user.
- Never print or echo `PADDLE_API_KEY` / `PADDLE_WEBHOOK_SECRET` values.
- `.env.paddle-backup` holds secrets: make sure `.gitignore` covers `.env*` backups.
  The `paddle.<env>.lock.json` files are safe to commit.

## Upgrading a project to a new contract version

`contractVersion` in the catalog pins the project. If this plugin's contract version is
newer, read the CHANGELOG in the plugin repo root, list the required changes, and ask
before applying them.
