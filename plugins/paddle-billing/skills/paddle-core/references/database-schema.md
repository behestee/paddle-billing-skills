# Canonical database schema (contract v1)

Table and column names are fixed. Types below are PostgreSQL; the mapping table at the end
gives MySQL / SQLite / SQL Server equivalents. Use the project's migration tool (Alembic,
Laravel migrations, Flyway/Liquibase, Prisma/Drizzle/Knex, GeneXus transactions) — but
produce exactly these tables and columns. Create only the tables the project's skills need:

| Table | Needed by |
|---|---|
| `billing_customers`, `billing_events`, `paddle_webhook_events`, `billing_discounts`, `billing_support_requests` | always |
| `billing_subscriptions`, `billing_trial_usages` | subscription |
| `billing_team_seats` | subscription with seat prices |
| `billing_purchases`, `billing_purchase_items`, `billing_entitlements` | digital-goods, ebook |
| `billing_catalog_products`, `billing_catalog_prices` | **dynamic** mode only (fixed mode reads env / lock file) |

`account_id` means "whatever owns billing in this app" — a user id, organisation id or
workspace id. Pick one per project and record it in the catalog `project` notes. It is
`TEXT` so it works with integer, UUID and external ids alike.

```sql
-- One row per (account, Paddle environment). Never reuse a sandbox ctm_ in production.
CREATE TABLE billing_customers (
  id                  BIGSERIAL PRIMARY KEY,
  account_id          TEXT        NOT NULL,
  paddle_env          TEXT        NOT NULL CHECK (paddle_env IN ('sandbox','production')),
  paddle_customer_id  TEXT        NOT NULL,            -- ctm_...
  email               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, paddle_env),
  UNIQUE (paddle_customer_id)
);

CREATE TABLE billing_subscriptions (
  id                     BIGSERIAL PRIMARY KEY,
  paddle_subscription_id TEXT        NOT NULL UNIQUE,   -- sub_...
  paddle_env             TEXT        NOT NULL,
  account_id             TEXT        NOT NULL,          -- buyer (team admin for team subs)
  team_id                TEXT,                          -- NULL = individual subscription
  paddle_customer_id     TEXT        NOT NULL,
  plan_key               TEXT        NOT NULL,          -- price.custom_data.plan
  price_key              TEXT        NOT NULL,          -- price.custom_data.app_key (may end in _trial)
  paddle_price_id        TEXT        NOT NULL,
  billing_cycle          TEXT,                          -- monthly | yearly | ...
  status                 TEXT        NOT NULL,          -- active|trialing|past_due|paused|canceled
  quantity               INTEGER     NOT NULL DEFAULT 1,-- seats for team subs
  currency_code          TEXT,
  trial_ends_at          TIMESTAMPTZ,
  current_period_start   TIMESTAMPTZ,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN     NOT NULL DEFAULT FALSE,
  scheduled_change       JSONB,                         -- Paddle scheduled_change verbatim
  discount_id            TEXT,                          -- dsc_... currently applied
  paused_at              TIMESTAMPTZ,
  canceled_at            TIMESTAMPTZ,
  plan_started_at        TIMESTAMPTZ,                   -- resets on plan change, not renewal
  last_event_at          TIMESTAMPTZ,                   -- occurred_at of the last applied event (ordering guard)
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_billing_subscriptions_account ON billing_subscriptions (account_id, status);
CREATE INDEX ix_billing_subscriptions_team    ON billing_subscriptions (team_id, status);

-- Trial is once per account, ever. email_hash also blocks "new account, same email".
CREATE TABLE billing_trial_usages (
  id                     BIGSERIAL PRIMARY KEY,
  account_id             TEXT        NOT NULL UNIQUE,
  email_hash             TEXT,                          -- sha256(lower(trim(email)))
  paddle_subscription_id TEXT,
  plan_key               TEXT,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_billing_trial_usages_email ON billing_trial_usages (email_hash);

CREATE TABLE billing_team_seats (
  id          BIGSERIAL PRIMARY KEY,
  team_id     TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);

-- One-time purchases (digital goods / ebooks). One row per completed transaction.
CREATE TABLE billing_purchases (
  id                    BIGSERIAL PRIMARY KEY,
  paddle_transaction_id TEXT        NOT NULL UNIQUE,    -- txn_...
  paddle_env            TEXT        NOT NULL,
  account_id            TEXT,                           -- NULL for guest purchases
  email                 TEXT        NOT NULL,           -- delivery address (customer email)
  paddle_customer_id    TEXT,
  status                TEXT        NOT NULL,           -- completed | partially_refunded | refunded | chargeback
  currency_code         TEXT        NOT NULL,
  subtotal_minor        BIGINT      NOT NULL,
  discount_minor        BIGINT      NOT NULL DEFAULT 0,
  tax_minor             BIGINT      NOT NULL DEFAULT 0,
  total_minor           BIGINT      NOT NULL,
  discount_id           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_billing_purchases_account ON billing_purchases (account_id);
CREATE INDEX ix_billing_purchases_email   ON billing_purchases (lower(email));

CREATE TABLE billing_purchase_items (
  id                 BIGSERIAL PRIMARY KEY,
  purchase_id        BIGINT      NOT NULL REFERENCES billing_purchases(id),
  paddle_item_id     TEXT,                              -- transaction line item id, for partial refunds
  product_key        TEXT        NOT NULL,
  price_key          TEXT        NOT NULL,
  paddle_price_id    TEXT        NOT NULL,
  quantity           INTEGER     NOT NULL DEFAULT 1,
  total_minor        BIGINT      NOT NULL,
  refunded           BOOLEAN     NOT NULL DEFAULT FALSE
);

-- What the buyer actually got. One row per unit (quantity 3 = 3 license keys).
CREATE TABLE billing_entitlements (
  id               BIGSERIAL PRIMARY KEY,
  purchase_item_id BIGINT      NOT NULL REFERENCES billing_purchase_items(id),
  account_id       TEXT,                                -- copied for fast "my library" queries
  email            TEXT        NOT NULL,
  product_key      TEXT        NOT NULL,
  kind             TEXT        NOT NULL,                -- file | license_key | access | external_url | credits
  license_key      TEXT UNIQUE,
  access_key       TEXT,
  download_count   INTEGER     NOT NULL DEFAULT 0,
  max_downloads    INTEGER,                             -- NULL = unlimited
  revoked_at       TIMESTAMPTZ,
  revoke_reason    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_billing_entitlements_account ON billing_entitlements (account_id);
CREATE INDEX ix_billing_entitlements_email   ON billing_entitlements (lower(email));

-- Promo codes. Same table in fixed mode (mirror of the catalog, filled on boot) and
-- dynamic mode (admin-owned).
CREATE TABLE billing_discounts (
  id                      BIGSERIAL PRIMARY KEY,
  key                     TEXT        NOT NULL UNIQUE,
  code                    TEXT        NOT NULL,         -- upper-case
  description             TEXT        NOT NULL,
  type                    TEXT        NOT NULL,         -- percentage | flat | flat_per_seat
  amount                  TEXT        NOT NULL,         -- percentage "50" or flat minor units "500"
  currency_code           TEXT,
  recur                   BOOLEAN     NOT NULL DEFAULT FALSE,
  max_recurring_intervals INTEGER,
  usage_limit             INTEGER,
  times_used              INTEGER     NOT NULL DEFAULT 0,  -- refreshed from discount.updated webhooks
  restrict_to             JSONB,                        -- array of product/price KEYS (not ids)
  expires_at              TIMESTAMPTZ,
  enabled                 BOOLEAN     NOT NULL DEFAULT TRUE,
  status                  TEXT        NOT NULL DEFAULT 'active',   -- active | archived
  paddle_env              TEXT        NOT NULL,
  paddle_discount_id      TEXT,                         -- dsc_...
  sync_status             TEXT        NOT NULL DEFAULT 'pending',  -- pending | synced | failed
  sync_error              TEXT,
  synced_at               TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_billing_discounts_active_code ON billing_discounts (code) WHERE status = 'active';

-- Dynamic mode only.
CREATE TABLE billing_catalog_products (
  id                BIGSERIAL PRIMARY KEY,
  key               TEXT        NOT NULL UNIQUE,
  kind              TEXT        NOT NULL,               -- subscription | digital_good | ebook
  plan_key          TEXT,                               -- subscriptions
  name              TEXT        NOT NULL,
  description       TEXT,
  tax_category      TEXT        NOT NULL,
  image_url         TEXT,
  features          JSONB,
  fulfillment       JSONB,                              -- one-time goods, same shape as the catalog file
  sort_order        INTEGER     NOT NULL DEFAULT 0,
  status            TEXT        NOT NULL DEFAULT 'active',
  paddle_env        TEXT        NOT NULL,
  paddle_product_id TEXT,
  sync_status       TEXT        NOT NULL DEFAULT 'pending',
  sync_error        TEXT,
  synced_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE billing_catalog_prices (
  id                BIGSERIAL PRIMARY KEY,
  product_id        BIGINT      NOT NULL REFERENCES billing_catalog_products(id),
  key               TEXT        NOT NULL,               -- NOT unique: superseded rows keep the key
  variant           TEXT        NOT NULL DEFAULT 'base',-- base | trial
  name              TEXT,
  amount_minor      BIGINT      NOT NULL,
  currency_code     TEXT        NOT NULL,
  interval          TEXT,                               -- NULL = one-time
  frequency         INTEGER     NOT NULL DEFAULT 1,
  trial_days        INTEGER,
  seat              BOOLEAN     NOT NULL DEFAULT FALSE,
  quantity_min      INTEGER     NOT NULL DEFAULT 1,
  quantity_max      INTEGER     NOT NULL DEFAULT 1,
  overrides         JSONB,
  status            TEXT        NOT NULL DEFAULT 'active',   -- active | archived
  superseded_by_id  BIGINT      REFERENCES billing_catalog_prices(id),
  paddle_env        TEXT        NOT NULL,
  paddle_price_id   TEXT        UNIQUE,
  sync_status       TEXT        NOT NULL DEFAULT 'pending',
  sync_error        TEXT,
  synced_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_billing_catalog_prices_active ON billing_catalog_prices (key, variant) WHERE status = 'active';

-- Webhook inbox: idempotency + debugging. Keep 90 days.
CREATE TABLE paddle_webhook_events (
  id            BIGSERIAL PRIMARY KEY,
  event_id      TEXT        NOT NULL UNIQUE,            -- evt_...
  event_type    TEXT        NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  paddle_env    TEXT        NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  status        TEXT        NOT NULL DEFAULT 'received',-- received | processed | ignored | failed
  attempts      INTEGER     NOT NULL DEFAULT 0,
  error         TEXT,
  payload       JSONB       NOT NULL
);

-- Append-only audit trail. Never UPDATE or DELETE rows.
CREATE TABLE billing_events (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type  TEXT        NOT NULL,                     -- contract §10
  paddle_env  TEXT,
  account_id  TEXT,
  team_id     TEXT,
  customer_id TEXT,
  entity_id   TEXT,                                     -- sub_/txn_/dsc_/pri_/adj_ the event is about
  actor       TEXT,                                     -- user id, admin id, 'webhook', 'reconciliation', 'system'
  detail      JSONB
);
CREATE INDEX ix_billing_events_time     ON billing_events (created_at);
CREATE INDEX ix_billing_events_customer ON billing_events (customer_id);
CREATE INDEX ix_billing_events_account  ON billing_events (account_id);

-- Customer help / refund requests: a mutable work queue (billing_events stays immutable).
CREATE TABLE billing_support_requests (
  id                    BIGSERIAL PRIMARY KEY,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  account_id            TEXT,
  email                 TEXT,
  topic                 TEXT        NOT NULL,           -- refund | paid_not_activated | other
  transaction_id        TEXT,
  subscription_id       TEXT,
  message               TEXT        NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'open',  -- open | in_progress | resolved | rejected
  admin_note            TEXT,
  refund_adjustment_id  TEXT,                           -- adj_...
  refund_status         TEXT,                           -- pending_approval | approved | rejected | reversed
  resolved_at           TIMESTAMPTZ
);
CREATE INDEX ix_billing_support_requests_status ON billing_support_requests (status, created_at);
```

## Type mapping

| PostgreSQL | MySQL 8 | SQLite | SQL Server |
|---|---|---|---|
| `BIGSERIAL PRIMARY KEY` | `BIGINT AUTO_INCREMENT PRIMARY KEY` | `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT IDENTITY PRIMARY KEY` |
| `TEXT` (indexed/unique) | `VARCHAR(191)` | `TEXT` | `NVARCHAR(191)` |
| `TEXT` (long) | `TEXT` | `TEXT` | `NVARCHAR(MAX)` |
| `TIMESTAMPTZ` | `DATETIME(3)` (store UTC) | `TEXT` ISO-8601 UTC | `DATETIMEOFFSET` |
| `BOOLEAN` | `TINYINT(1)` | `INTEGER` 0/1 | `BIT` |
| `JSONB` | `JSON` | `TEXT` (JSON) | `NVARCHAR(MAX)` |
| partial unique index `WHERE status='active'` | generated column `active_code = IF(status='active', code, NULL)` + unique index | supported as-is | filtered index `WHERE status='active'` |
| `lower(email)` index | generated column + index | expression index supported | computed column + index |
