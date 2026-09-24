#!/usr/bin/env node
// paddle-sync — push paddle.catalog.json (products, prices, trial variants,
// discounts) and the webhook destination to Paddle, then write the resulting
// IDs into the .env file and paddle.<env>.lock.json.
//
// Contract v1 (paddle-billing plugin). Behaviour is identical to
// paddle_sync.py — keep the two in lockstep.
//
// Zero dependencies. Node 18+.
//
// Usage:
//   node paddle-sync.mjs [sync|check|plan] [options]
//     sync   (default) apply changes, write .env + lock file
//     plan   same as `sync --dry-run`
//     check  validate catalog + env and verify every ID in .env exists in
//            the current Paddle environment; never writes
//   --catalog <path>        default ./paddle.catalog.json
//   --env-file <path>       default ./.env   (PADDLE_ENV is read from THIS file)
//   --dry-run               print the plan, change nothing
//   --yes                   non-interactive (CI / servers)
//   --price-change <p>      grandfather | migrate — answer for every price change
//   --prune                 archive app-owned Paddle entities missing from the catalog
//   --only <list>           comma list of: products,discounts,webhook
//   --api-base <url>        override the Paddle API base URL (tests only)
//
// Exit codes: 0 ok · 1 error · 2 stopped because a decision was needed

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const CONTRACT_VERSION = 1;
const ZERO_DECIMAL = new Set(["JPY", "KRW", "CLP", "ISK", "VND", "HUF", "TWD", "UGX", "XAF", "XOF", "PYG", "RWF", "KMF", "GNF", "DJF", "BIF", "VUV", "XPF"]);
const DEFAULT_TAX = { subscription: "saas", digital_good: "standard", ebook: "ebooks" };
const TAX_CATEGORIES = ["standard", "saas", "digital-goods", "ebooks", "software-programming-services", "training-services", "professional-services", "implementation-services", "website-hosting"];
const EVENTS = {
  base: ["transaction.completed", "transaction.payment_failed", "adjustment.created", "adjustment.updated", "discount.created", "discount.updated", "customer.updated"],
  subscription: ["subscription.created", "subscription.updated", "subscription.activated", "subscription.trialing", "subscription.past_due", "subscription.paused", "subscription.resumed", "subscription.canceled"],
};

// ── CLI ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { command: "sync", catalog: "paddle.catalog.json", envFile: ".env", dryRun: false, yes: false, priceChange: null, prune: false, only: null, apiBase: null };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) o.command = rest.shift();
  while (rest.length) {
    const a = rest.shift();
    const val = () => { const v = rest.shift(); if (v === undefined) die(`${a} needs a value`); return v; };
    if (a === "--catalog") o.catalog = val();
    else if (a === "--env-file") o.envFile = val();
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--price-change") o.priceChange = val();
    else if (a === "--prune") o.prune = true;
    else if (a === "--only") o.only = new Set(val().split(",").map((s) => s.trim()));
    else if (a === "--api-base") o.apiBase = val();
    else if (a === "-h" || a === "--help") { printHelp(); process.exit(0); }
    else die(`Unknown option ${a}`);
  }
  if (!["sync", "plan", "check"].includes(o.command)) die(`Unknown command "${o.command}" (use sync, plan or check)`);
  if (o.command === "plan") { o.command = "sync"; o.dryRun = true; }
  if (o.priceChange && !["grandfather", "migrate"].includes(o.priceChange)) die("--price-change must be grandfather or migrate");
  if (o.only) for (const s of o.only) if (!["products", "discounts", "webhook"].includes(s)) die(`--only: unknown section "${s}"`);
  return o;
}
function printHelp() {
  const src = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n");
  console.log(src.slice(1, src.findIndex((l) => l.startsWith("import"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
function die(msg, code = 1) { console.error(`✖ ${msg}`); process.exit(code); }
const want = (opts, section) => !opts.only || opts.only.has(section);

// ── .env ─────────────────────────────────────────────────────────────────
function readEnv(file) {
  if (!fs.existsSync(file)) die(`Env file not found: ${file}`);
  const text = fs.readFileSync(file, "utf8");
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "").trim();
    env[m[1]] = v;
  }
  return { text, env };
}
const MANAGED_MARKER = "# ── paddle-sync managed values (do not edit by hand) ──";
function writeEnv(file, originalText, updates) {
  const lines = originalText.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const pending = new Map(Object.entries(updates));
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && pending.has(m[1])) { lines[i] = `${m[1]}=${pending.get(m[1])}`; pending.delete(m[1]); }
  }
  if (pending.size) {
    if (!lines.includes(MANAGED_MARKER)) lines.push("", MANAGED_MARKER);
    for (const [k, v] of pending) lines.push(`${k}=${v}`);
  }
  fs.copyFileSync(file, `${file}.paddle-backup`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
}
export const envKey = (prefix, key) => `${prefix}_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

// ── Money ────────────────────────────────────────────────────────────────
export function toMinor(amount, currency) {
  const s = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount "${amount}"`);
  const digits = ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > digits) throw new Error(`Amount "${amount}" has more decimals than ${currency} allows (${digits})`);
  return String(BigInt(whole + frac.padEnd(digits, "0")));
}

// ── Catalog validation ───────────────────────────────────────────────────
const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
function strict(obj, allowed, where, errors) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) { errors.push(`${where}: must be an object`); return false; }
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown field "${k}"`);
  return true;
}
export function loadCatalog(file) {
  if (!fs.existsSync(file)) die(`Catalog not found: ${file}`);
  let c;
  try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { die(`Catalog is not valid JSON: ${e.message}`); }
  const errors = [];
  strict(c, ["$schema", "contractVersion", "app", "mode", "skills", "project", "currency", "taxMode", "priceChangePolicy", "checkout", "products", "discounts"], "catalog", errors);
  if (c.contractVersion !== CONTRACT_VERSION) errors.push(`contractVersion must be ${CONTRACT_VERSION}`);
  if (!/^[a-z0-9_-]{2,40}$/.test(c.app || "")) errors.push("app must match [a-z0-9_-]{2,40}");
  if (!["fixed", "dynamic"].includes(c.mode)) errors.push('mode must be "fixed" or "dynamic"');
  if (!Array.isArray(c.skills) || !c.skills.length || c.skills.some((s) => !["subscription", "digital-goods", "ebook"].includes(s))) errors.push("skills must be a non-empty array of subscription|digital-goods|ebook");
  if (c.project) strict(c.project, ["backend", "frontend", "database"], "project", errors); else errors.push("project is required");
  c.currency = (c.currency || "USD").toUpperCase();
  c.taxMode = c.taxMode || "account_setting";
  if (!["account_setting", "internal", "external", "location"].includes(c.taxMode)) errors.push("taxMode invalid");
  c.priceChangePolicy = c.priceChangePolicy || "ask";
  if (!["ask", "grandfather", "migrate"].includes(c.priceChangePolicy)) errors.push("priceChangePolicy must be ask|grandfather|migrate");
  if (c.checkout) strict(c.checkout, ["allowDiscountEntry", "displayMode", "successPath", "theme"], "checkout", errors);
  c.products = c.products || [];
  c.discounts = c.discounts || [];
  const seen = new Set();
  const uniq = (k, where) => { if (seen.has(k)) errors.push(`${where}: duplicate key "${k}"`); seen.add(k); };

  for (const [i, p] of c.products.entries()) {
    const w = `products[${i}]${p?.key ? ` (${p.key})` : ""}`;
    if (!strict(p, ["key", "kind", "name", "description", "taxCategory", "imageUrl", "features", "plan", "fulfillment", "prices", "archived"], w, errors)) continue;
    if (!KEY_RE.test(p.key || "")) errors.push(`${w}: key must be snake_case`); else uniq(p.key, w);
    if (!["subscription", "digital_good", "ebook"].includes(p.kind)) errors.push(`${w}: kind must be subscription|digital_good|ebook`);
    if (!p.name) errors.push(`${w}: name is required`);
    p.taxCategory = p.taxCategory || DEFAULT_TAX[p.kind];
    if (!TAX_CATEGORIES.includes(p.taxCategory)) errors.push(`${w}: taxCategory "${p.taxCategory}" is not a Paddle tax category`);
    p.plan = p.plan || p.key;
    if (p.kind === "ebook") {
      const files = p.fulfillment?.files || [];
      if (p.fulfillment?.type !== "file" || !files.some((f) => /\.pdf$/i.test(f.path || ""))) errors.push(`${w}: ebook products need fulfillment.type "file" with at least one .pdf`);
    }
    if (p.fulfillment) strict(p.fulfillment, ["type", "files", "maxDownloads", "linkTtlMinutes", "licensePrefix", "accessKey", "url", "credits"], `${w}.fulfillment`, errors);
    if (p.kind !== "subscription" && !p.fulfillment) errors.push(`${w}: one-time products need a fulfillment block`);
    if (!Array.isArray(p.prices) || !p.prices.length) { errors.push(`${w}: at least one price is required`); continue; }
    for (const [j, pr] of p.prices.entries()) {
      const pw = `${w}.prices[${j}]${pr?.key ? ` (${pr.key})` : ""}`;
      if (!strict(pr, ["key", "name", "description", "amount", "currency", "interval", "frequency", "cycle", "trialDays", "seat", "maxSeats", "allowQuantity", "maxQuantity", "overrides", "archived"], pw, errors)) continue;
      if (!KEY_RE.test(pr.key || "") || /_trial$/.test(pr.key)) errors.push(`${pw}: key must be snake_case and must not end in _trial`); else { uniq(pr.key, pw); uniq(`${pr.key}_trial`, pw); }
      pr.currency = (pr.currency || c.currency).toUpperCase();
      try { toMinor(pr.amount, pr.currency); } catch (e) { errors.push(`${pw}: ${e.message}`); }
      pr.interval = pr.interval ?? null;
      pr.frequency = pr.frequency ?? 1;
      if (p.kind === "subscription" && !pr.interval) errors.push(`${pw}: subscription prices need an interval`);
      if (p.kind !== "subscription" && (pr.interval || pr.trialDays || pr.seat)) errors.push(`${pw}: one-time prices can't have interval/trialDays/seat`);
      if (pr.interval && !["day", "week", "month", "year"].includes(pr.interval)) errors.push(`${pw}: interval must be day|week|month|year`);
      if (pr.trialDays != null && !(Number.isInteger(pr.trialDays) && pr.trialDays >= 1)) errors.push(`${pw}: trialDays must be a positive integer`);
      if (pr.seat && pr.trialDays) errors.push(`${pw}: seat prices can't have a trial (trials are per account, not per team)`);
      pr.cycle = pr.cycle || (pr.interval ? (pr.frequency === 1 && pr.interval === "month" ? "monthly" : pr.frequency === 1 && pr.interval === "year" ? "yearly" : `${pr.frequency}${pr.interval}`) : null);
      for (const [k, ov] of (pr.overrides || []).entries()) {
        if (!strict(ov, ["countries", "amount", "currency"], `${pw}.overrides[${k}]`, errors)) continue;
        ov.currency = (ov.currency || pr.currency).toUpperCase();
        try { toMinor(ov.amount, ov.currency); } catch (e) { errors.push(`${pw}.overrides[${k}]: ${e.message}`); }
        if (!Array.isArray(ov.countries) || !ov.countries.length) errors.push(`${pw}.overrides[${k}]: countries required`);
      }
    }
  }
  const allKeys = new Set([...c.products.map((p) => p.key), ...c.products.flatMap((p) => (p.prices || []).map((x) => x.key))]);
  for (const [i, d] of c.discounts.entries()) {
    const w = `discounts[${i}]${d?.key ? ` (${d.key})` : ""}`;
    if (!strict(d, ["key", "code", "description", "type", "amount", "currency", "recur", "maxRecurringIntervals", "usageLimit", "restrictTo", "expiresAt", "enabled", "archived"], w, errors)) continue;
    if (!KEY_RE.test(d.key || "")) errors.push(`${w}: key must be snake_case`); else uniq(`discount:${d.key}`, w);
    if (!/^[A-Za-z0-9]{1,32}$/.test(d.code || "")) errors.push(`${w}: code must be 1-32 letters/numbers`); else d.code = d.code.toUpperCase();
    if (!d.description) errors.push(`${w}: description is required`);
    if (!["percentage", "flat", "flat_per_seat"].includes(d.type)) errors.push(`${w}: type must be percentage|flat|flat_per_seat`);
    if (d.type === "percentage") { const n = Number(d.amount); if (!(n >= 0.01 && n <= 100)) errors.push(`${w}: percentage amount must be 0.01-100`); }
    else { d.currency = (d.currency || c.currency).toUpperCase(); try { toMinor(d.amount, d.currency); } catch (e) { errors.push(`${w}: ${e.message}`); } }
    if (d.maxRecurringIntervals != null && !d.recur) errors.push(`${w}: maxRecurringIntervals requires recur: true`);
    for (const k of d.restrictTo || []) if (!allKeys.has(k)) errors.push(`${w}: restrictTo references unknown key "${k}"`);
    if (d.expiresAt && Number.isNaN(Date.parse(d.expiresAt))) errors.push(`${w}: expiresAt must be RFC 3339`);
  }
  if (errors.length) die(`Catalog has ${errors.length} problem(s):\n  - ${errors.join("\n  - ")}`);
  return c;
}

// ── Paddle REST client (contract §5) ─────────────────────────────────────
class PaddleError extends Error {
  constructor(status, body) {
    const e = body?.error || {};
    super(`${status} ${e.code || ""}: ${e.detail || "request failed"}${body?.meta?.request_id ? ` (request_id ${body.meta.request_id})` : ""}${e.errors ? " " + JSON.stringify(e.errors) : ""}`);
    this.status = status; this.code = e.code; this.requestId = body?.meta?.request_id;
  }
}
function makeClient(base, apiKey) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function request(method, urlOrPath, body) {
    const url = urlOrPath.startsWith("http") ? urlOrPath : base + urlOrPath;
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      let res;
      try {
        res = await fetch(url, { method, signal: ctrl.signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Paddle-Version": "1" }, body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        clearTimeout(t);
        if (attempt < 3) { await sleep(500 * 2 ** attempt); continue; }
        throw new Error(`Network error calling Paddle ${method} ${url}: ${e.message}`);
      }
      clearTimeout(t);
      const json = await res.json().catch(() => ({}));
      if (res.ok) return json;
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
        continue;
      }
      throw new PaddleError(res.status, json);
    }
  }
  return {
    get: async (p) => (await request("GET", p)).data,
    post: async (p, b) => (await request("POST", p, b)).data,
    patch: async (p, b) => (await request("PATCH", p, b)).data,
    async list(p) {
      const out = [];
      let next = p;
      while (next) {
        const json = await request("GET", next);
        out.push(...(Array.isArray(json.data) ? json.data : []));
        next = json.meta?.pagination?.has_more ? json.meta.pagination.next : null;
      }
      return out;
    },
  };
}

// ── Desired state from the catalog ───────────────────────────────────────
function desiredProduct(c, p) {
  return {
    name: p.name,
    description: p.description ?? null,
    tax_category: p.taxCategory,
    image_url: p.imageUrl ?? null,
    custom_data: { app: c.app, app_key: p.key, kind: p.kind },
    status: p.archived ? "archived" : "active",
  };
}
function desiredPrices(c, p) {
  const out = [];
  for (const pr of p.prices) {
    const seat = !!pr.seat;
    const qty = seat ? { minimum: 1, maximum: pr.maxSeats ?? 999 } : pr.allowQuantity ? { minimum: 1, maximum: pr.maxQuantity ?? 100 } : { minimum: 1, maximum: 1 };
    const variants = [{ key: pr.key, trial: false }];
    if (pr.trialDays) variants.push({ key: `${pr.key}_trial`, trial: true });
    else variants.push({ key: `${pr.key}_trial`, trial: true, removed: true });
    for (const v of variants) {
      out.push({
        key: v.key,
        baseKey: pr.key,
        removed: !!v.removed,
        archived: !!pr.archived || !!p.archived,
        isSubscription: p.kind === "subscription",
        body: {
          description: pr.description || `${p.name} — ${pr.cycle || "one-time"}${v.trial ? ` (${pr.trialDays}-day trial)` : ""}`,
          name: pr.name || p.name,
          tax_mode: c.taxMode,
          unit_price: { amount: toMinor(pr.amount, pr.currency), currency_code: pr.currency },
          unit_price_overrides: (pr.overrides || []).map((o) => ({ country_codes: o.countries.map((x) => x.toUpperCase()), unit_price: { amount: toMinor(o.amount, o.currency), currency_code: o.currency } })),
          billing_cycle: pr.interval ? { interval: pr.interval, frequency: pr.frequency } : null,
          trial_period: v.trial && pr.trialDays ? { interval: "day", frequency: pr.trialDays, requires_payment_method: true } : null,
          quantity: qty,
          custom_data: {
            app: c.app, app_key: v.key, product_key: p.key,
            ...(p.kind === "subscription" ? { plan: p.plan, cycle: pr.cycle } : {}),
            seat, trial: v.trial,
          },
        },
      });
    }
  }
  return out;
}
const sortOv = (arr) => JSON.stringify((arr || []).map((o) => ({ c: [...(o.country_codes || [])].sort(), a: String(o.unit_price?.amount), cur: o.unit_price?.currency_code })).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))));
function moneyDiffers(existing, body) {
  const bc = (x) => (x ? `${x.interval}:${x.frequency}` : "none");
  const tp = (x) => (x ? `${x.interval}:${x.frequency}:${x.requires_payment_method !== false}` : "none");
  return String(existing.unit_price?.amount) !== body.unit_price.amount
    || existing.unit_price?.currency_code !== body.unit_price.currency_code
    || bc(existing.billing_cycle) !== bc(body.billing_cycle)
    || tp(existing.trial_period) !== tp(body.trial_period)
    || sortOv(existing.unit_price_overrides) !== sortOv(body.unit_price_overrides);
}
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function shallowCustomEq(a, b) {
  const ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
  return eq(ka, kb) && ka.every((k) => eq(a[k], b[k]));
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const catalogPath = path.resolve(opts.catalog);
  const envPath = path.resolve(opts.envFile);
  const catalog = loadCatalog(catalogPath);
  const { text: envText, env } = readEnv(envPath);

  const pEnv = env.PADDLE_ENV;
  if (!["sandbox", "production"].includes(pEnv)) die(`PADDLE_ENV in ${opts.envFile} must be "sandbox" or "production" (got "${pEnv ?? ""}")`);
  const apiKey = (env.PADDLE_API_KEY || "").trim();
  const expected = pEnv === "production" ? "pdl_live_apikey_" : "pdl_sdbx_apikey_";
  if (!apiKey) die(`PADDLE_API_KEY is empty in ${opts.envFile}`);
  if (!apiKey.startsWith(expected)) {
    const other = pEnv === "production" ? "pdl_sdbx_apikey_" : "pdl_live_apikey_";
    die(apiKey.startsWith(other)
      ? `PADDLE_API_KEY is a ${pEnv === "production" ? "SANDBOX" : "LIVE"} key but PADDLE_ENV=${pEnv}. Refusing to continue.`
      : `PADDLE_API_KEY is malformed — expected it to start with "${expected}" (a character lost on paste?)`);
  }
  const ct = env.PADDLE_CLIENT_TOKEN || "";
  if (ct && !ct.startsWith(pEnv === "production" ? "live_" : "test_")) console.warn(`⚠ PADDLE_CLIENT_TOKEN doesn't look like a ${pEnv} token (expected prefix "${pEnv === "production" ? "live_" : "test_"}")`);
  if (!ct) console.warn("⚠ PADDLE_CLIENT_TOKEN is empty — the browser checkout won't open until you set it.");

  const base = opts.apiBase || (pEnv === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com");
  const api = makeClient(base, apiKey);
  console.log(`paddle-sync · app=${catalog.app} · env=${pEnv} · mode=${catalog.mode}${opts.dryRun ? " · DRY RUN" : ""}`);
  if (pEnv === "production") console.log("  ⚠ PRODUCTION — changes affect real customers.");

  if (opts.command === "check") return check({ api, catalog, env, pEnv });

  const lockPath = path.join(path.dirname(catalogPath), `paddle.${pEnv}.lock.json`);
  const prevLock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : {};
  const lock = { contractVersion: CONTRACT_VERSION, app: catalog.app, env: pEnv, syncedAt: null, products: {}, prices: {}, discounts: {}, webhook: prevLock.webhook || null };
  const envUpdates = {};
  const actions = []; // { label, run(ctx) } — planned first, executed only after every decision is made
  const ctx = { productIds: {}, priceIds: {}, dry: opts.dryRun };
  const pending = new Set(); // product/price keys that will only get an ID when their create action runs
  const priceChanges = []; // subscription price changes needing a policy

  const doCatalog = catalog.mode === "fixed" && want(opts, "products");
  const doDiscounts = catalog.mode === "fixed" && want(opts, "discounts");
  if (catalog.mode === "dynamic" && (want(opts, "products") || want(opts, "discounts"))) {
    console.log("  dynamic mode: products/prices/discounts are pushed by the app at runtime (admin UI / catalog resync). Syncing webhook + env only.");
  }

  // ── Products & prices ──
  if (doCatalog || doDiscounts) {
    const allProducts = await api.list("/products?per_page=200&status=active,archived");
    const allPrices = await api.list("/prices?per_page=200&status=active,archived");
    const mine = (x) => x.custom_data?.app === catalog.app;
    const catalogProductKeys = new Set(catalog.products.map((p) => p.key));
    const catalogPriceKeys = new Set();

    // With --only discounts we still resolve existing IDs (restrict_to needs
    // them) but queue no product/price changes.
    const actionsRef = actions;
    const addA = (a) => { if (doCatalog) actionsRef.push(a); };
    for (const p of catalog.products) {
      const want_ = desiredProduct(catalog, p);
      let existing = allProducts.find((x) => mine(x) && x.custom_data?.app_key === p.key);
      let adopt = false;
      if (!existing) {
        existing = allProducts.find((x) => !x.custom_data?.app && x.status === "active" && x.name === p.name);
        adopt = !!existing;
      }
      if (!existing) {
        pending.add(p.key);
        addA({ label: `+ product ${p.key} "${p.name}" (${p.taxCategory})`, run: async () => {
          if (ctx.dry) { ctx.productIds[p.key] = `(new:${p.key})`; return; }
          const { status, ...body } = want_;
          const created = await api.post("/products", body);
          ctx.productIds[p.key] = created.id;
          if (status === "archived") await api.patch(`/products/${created.id}`, { status: "archived" });
        } });
      } else {
        ctx.productIds[p.key] = existing.id;
        const diff = {};
        for (const k of ["name", "description", "tax_category", "image_url", "status"]) if (!eq(existing[k], want_[k])) diff[k] = want_[k];
        if (!shallowCustomEq(existing.custom_data, want_.custom_data)) diff.custom_data = want_.custom_data;
        if (Object.keys(diff).length) {
          addA({ label: `~ product ${p.key} ${adopt ? "(adopting legacy product) " : ""}${Object.keys(diff).join(", ")}`, run: async () => { if (!ctx.dry) await api.patch(`/products/${existing.id}`, diff); } });
        }
      }
      lock.products[p.key] = { id: existing?.id ?? null, status: want_.status };

      for (const d of desiredPrices(catalog, p)) {
        if (!d.removed) catalogPriceKeys.add(d.key);
        const candidates = allPrices.filter((x) => mine(x) && x.custom_data?.app_key === d.key && x.status === "active" && (!existing || x.product_id === existing.id));
        candidates.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        let cur = candidates[0];
        for (const extra of candidates.slice(1)) {
          addA({ label: `- price ${d.key} duplicate ${extra.id} → archive`, run: async () => { if (!ctx.dry) await api.patch(`/prices/${extra.id}`, { status: "archived" }); } });
        }
        let adoptPrice = false;
        if (!cur && existing && !d.removed) {
          cur = allPrices.find((x) => !x.custom_data?.app && x.status === "active" && x.product_id === existing.id && !moneyDiffers(x, d.body));
          adoptPrice = !!cur;
        }
        const history = prevLock.prices?.[d.key]?.history || [];
        if (d.removed || d.archived) {
          if (cur) addA({ label: `- price ${d.key} ${cur.id} → archive${d.removed ? " (trial removed from catalog)" : ""}`, run: async () => { if (!ctx.dry) await api.patch(`/prices/${cur.id}`, { status: "archived" }); } });
          if (!d.removed || cur || history.length) lock.prices[d.key] = { id: cur?.id ?? prevLock.prices?.[d.key]?.id ?? null, productKey: p.key, status: "archived", history };
          continue;
        }
        const create = (why) => { pending.add(d.key); addA({ label: `+ price ${d.key} ${d.body.unit_price.amount} ${d.body.unit_price.currency_code}${d.body.billing_cycle ? ` / ${d.body.billing_cycle.frequency} ${d.body.billing_cycle.interval}` : ""}${d.body.trial_period ? ` · trial ${d.body.trial_period.frequency}d` : ""}${why ? ` (${why})` : ""}`, run: async () => {
          if (ctx.dry) { ctx.priceIds[d.key] = `(new:${d.key})`; return; }
          const created = await api.post("/prices", { ...d.body, product_id: ctx.productIds[p.key] });
          ctx.priceIds[d.key] = created.id;
        } }); };
        if (!cur) {
          create();
          lock.prices[d.key] = { id: null, productKey: p.key, status: "active", history };
        } else if (moneyDiffers(cur, d.body)) {
          create(`replaces ${cur.id}`);
          addA({ label: `- price ${d.key} ${cur.id} → archive (superseded)`, run: async () => { if (!ctx.dry) await api.patch(`/prices/${cur.id}`, { status: "archived" }); } });
          if (d.isSubscription && doCatalog) priceChanges.push({ key: d.key, oldId: cur.id, old: cur.unit_price, next: d.body.unit_price });
          lock.prices[d.key] = { id: null, productKey: p.key, status: "active", history: [...history, { id: cur.id, archivedAt: new Date().toISOString() }] };
        } else {
          ctx.priceIds[d.key] = cur.id;
          const diff = {};
          for (const k of ["name", "description", "tax_mode", "quantity"]) if (!eq(cur[k], d.body[k])) diff[k] = d.body[k];
          if (!shallowCustomEq(cur.custom_data, d.body.custom_data)) diff.custom_data = d.body.custom_data;
          if (Object.keys(diff).length) addA({ label: `~ price ${d.key} ${adoptPrice ? "(adopting legacy price) " : ""}${Object.keys(diff).join(", ")}`, run: async () => { if (!ctx.dry) await api.patch(`/prices/${cur.id}`, diff); } });
          lock.prices[d.key] = { id: cur.id, productKey: p.key, status: "active", history };
        }
      }
    }

    if (opts.prune && doCatalog) {
      for (const x of allProducts) if (mine(x) && x.status === "active" && !catalogProductKeys.has(x.custom_data?.app_key)) {
        addA({ label: `- product ${x.custom_data?.app_key} ${x.id} → archive (not in catalog)`, run: async () => { if (!ctx.dry) await api.patch(`/products/${x.id}`, { status: "archived" }); } });
      }
      for (const x of allPrices) if (mine(x) && x.status === "active" && !catalogPriceKeys.has(x.custom_data?.app_key) && !actions.some((a) => a.label?.includes(x.id))) {
        addA({ label: `- price ${x.custom_data?.app_key} ${x.id} → archive (not in catalog)`, run: async () => { if (!ctx.dry) await api.patch(`/prices/${x.id}`, { status: "archived" }); } });
      }
    }
  }

  // ── Price-change policy (decided BEFORE anything is changed) ──
  let policy = null;
  if (priceChanges.length) {
    console.log(`\n${priceChanges.length} subscription price change(s):`);
    for (const ch of priceChanges) console.log(`  • ${ch.key}: ${ch.old?.amount} ${ch.old?.currency_code} → ${ch.next.amount} ${ch.next.currency_code}`);
    policy = opts.priceChange || (catalog.priceChangePolicy !== "ask" ? catalog.priceChangePolicy : null);
    if (!policy) {
      if (opts.yes || !process.stdin.isTTY) die("Price changes need a decision: re-run with --price-change grandfather|migrate (or set priceChangePolicy in the catalog).", 2);
      policy = await askPolicy();
    }
    console.log(`  policy: ${policy}${policy === "grandfather" ? " (existing subscribers keep their current price)" : " (existing subscribers move to the new price at their next renewal, no immediate charge)"}`);
    if (policy === "migrate") {
      for (const ch of priceChanges) {
        actions.push({ label: `» migrate subscribers of ${ch.key} from ${ch.oldId}`, run: async () => {
          if (ctx.dry) return;
          const subs = await api.list(`/subscriptions?per_page=200&price_id=${ch.oldId}&status=active,trialing,past_due`);
          let n = 0;
          for (const s of subs) {
            const items = s.items.map((it) => ({ price_id: it.price.id === ch.oldId ? ctx.priceIds[ch.key] : it.price.id, quantity: it.quantity }));
            await api.patch(`/subscriptions/${s.id}`, { items, proration_billing_mode: "do_not_bill" });
            n++;
          }
          console.log(`    migrated ${n} subscription(s)`);
        } });
      }
    }
  }

  // ── Discounts ──
  if (doDiscounts) {
    const allDiscounts = await api.list("/discounts?per_page=200&status=active,archived");
    const mine = (x) => x.custom_data?.app === catalog.app;
    const keysInCatalog = new Set(catalog.discounts.map((d) => d.key));
    const productKeys = new Set(catalog.products.map((p) => p.key));
    const allPriceDefs = catalog.products.flatMap((p) => p.prices);
    // A price key in restrictTo covers its _trial variant too, so a promo
    // restricted to "pro_monthly" also works on a first-time trial checkout.
    const expand = (k) => (productKeys.has(k) ? [{ kind: "product", key: k }] : [k, ...(allPriceDefs.find((x) => x.key === k)?.trialDays ? [`${k}_trial`] : [])].map((key) => ({ kind: "price", key })));
    // At plan time, not-yet-created IDs resolve to "(new:<key>)"; at run time to the real ID.
    const resolve = ({ kind, key }) => (kind === "product" ? ctx.productIds[key] : ctx.priceIds[key]) || (pending.has(key) ? `(new:${key})` : null);
    const bodyFor = (d) => ({
      description: d.description,
      type: d.type,
      amount: d.type === "percentage" ? String(Number(d.amount)) : toMinor(d.amount, d.currency),
      currency_code: d.type === "percentage" ? null : d.currency,
      code: d.code,
      enabled_for_checkout: d.enabled !== false,
      recur: !!d.recur,
      maximum_recurring_intervals: d.recur ? d.maxRecurringIntervals ?? null : null,
      usage_limit: d.usageLimit ?? null,
      restrict_to: d.restrictTo ? d.restrictTo.flatMap(expand).map(resolve).filter(Boolean) : null,
      expires_at: d.expiresAt ? new Date(d.expiresAt).toISOString().replace(/\.000Z$/, "Z") : null,
      custom_data: { app: catalog.app, app_key: d.key },
    });
    const setEq = (x, y) => (x == null && y == null) || (x != null && y != null && eq([...x].sort(), [...y].sort()));
    for (const d of catalog.discounts) {
      let existing = allDiscounts.find((x) => mine(x) && x.custom_data?.app_key === d.key);
      let adopt = false;
      if (!existing) { existing = allDiscounts.find((x) => !x.custom_data?.app && (x.code || "").toUpperCase() === d.code); adopt = !!existing; }
      const wantStatus = d.archived ? "archived" : "active";
      if (!existing) {
        if (d.archived) continue;
        lock.discounts[d.key] = { id: null, code: d.code, status: "active" };
        actions.push({ label: `+ discount ${d.key} code=${d.code} ${d.type} ${d.amount}${d.type === "percentage" ? "%" : ` ${d.currency}`}`, run: async () => {
          if (ctx.dry) return;
          const created = await api.post("/discounts", bodyFor(d));
          lock.discounts[d.key].id = created.id;
        } });
        continue;
      }
      lock.discounts[d.key] = { id: existing.id, code: d.code, status: wantStatus };
      const b = bodyFor(d);
      const fields = [];
      for (const k of ["description", "type", "amount", "currency_code", "enabled_for_checkout", "recur", "maximum_recurring_intervals", "usage_limit"]) if (!eq(existing[k], b[k])) fields.push(k);
      if ((existing.code || "").toUpperCase() !== b.code) fields.push("code");
      if (!setEq(existing.restrict_to, b.restrict_to)) fields.push("restrict_to");
      if ((existing.expires_at ? Date.parse(existing.expires_at) : null) !== (b.expires_at ? Date.parse(b.expires_at) : null)) fields.push("expires_at");
      if (!shallowCustomEq(existing.custom_data, b.custom_data)) fields.push("custom_data");
      if (existing.status !== wantStatus) fields.push("status");
      if (!fields.length) continue;
      actions.push({ label: `~ discount ${d.key} ${adopt ? "(adopting legacy discount) " : ""}${fields.join(", ")}`, run: async () => {
        if (ctx.dry) return;
        const fresh = bodyFor(d); // re-resolve: restrict_to may reference prices created earlier in this run
        const patch = {};
        for (const k of fields) patch[k] = k === "status" ? wantStatus : fresh[k];
        await api.patch(`/discounts/${existing.id}`, patch);
      } });
    }
    if (opts.prune) for (const x of allDiscounts) if (mine(x) && x.status === "active" && !keysInCatalog.has(x.custom_data?.app_key)) {
      actions.push({ label: `- discount ${x.custom_data?.app_key} ${x.id} → archive (not in catalog)`, run: async () => { if (!ctx.dry) await api.patch(`/discounts/${x.id}`, { status: "archived" }); } });
    }
  }

  // ── Webhook destination ──
  if (want(opts, "webhook") && env.PADDLE_WEBHOOK_URL) {
    const url = env.PADDLE_WEBHOOK_URL.trim();
    const events = [...EVENTS.base, ...(catalog.skills.includes("subscription") ? EVENTS.subscription : [])].sort();
    const settings = await api.list("/notification-settings");
    const existing = settings.find((s) => s.destination === url);
    const traffic = pEnv === "sandbox" ? "all" : "platform";
    if (!existing) {
      actions.push({ label: `+ webhook destination ${url} (${events.length} events)`, run: async () => {
        if (ctx.dry) return;
        const created = await api.post("/notification-settings", { description: `${catalog.app} (${pEnv}) — paddle-sync`, type: "url", destination: url, subscribed_events: events, api_version: 1, include_sensitive_fields: false, traffic_source: traffic });
        envUpdates.PADDLE_WEBHOOK_SECRET = created.endpoint_secret_key;
        envUpdates.PADDLE_NOTIFICATION_SETTING_ID = created.id;
        lock.webhook = { notificationSettingId: created.id, url };
      } });
    } else {
      const have = (existing.subscribed_events || []).map((e) => e.name || e).sort();
      const diff = {};
      if (!eq(have, events)) diff.subscribed_events = events;
      if (existing.active === false) diff.active = true;
      if (existing.traffic_source && existing.traffic_source !== traffic) diff.traffic_source = traffic;
      if (Object.keys(diff).length) actions.push({ label: `~ webhook destination ${url} ${Object.keys(diff).join(", ")}`, run: async () => { if (!ctx.dry) await api.patch(`/notification-settings/${existing.id}`, diff); } });
      envUpdates.PADDLE_NOTIFICATION_SETTING_ID = existing.id;
      if (existing.endpoint_secret_key && existing.endpoint_secret_key !== env.PADDLE_WEBHOOK_SECRET) envUpdates.PADDLE_WEBHOOK_SECRET = existing.endpoint_secret_key;
      lock.webhook = { notificationSettingId: existing.id, url };
    }
  } else if (want(opts, "webhook") && !env.PADDLE_WEBHOOK_URL) {
    console.log("  (PADDLE_WEBHOOK_URL not set — skipping webhook destination; set it to have the secret filled in automatically)");
  }

  // ── Execute ──
  const visible = actions;
  console.log(visible.length ? `\nPlan (${visible.length} change(s)):` : "\nNo changes needed.");
  for (const a of visible) console.log(`  ${a.label}`);
  if (opts.dryRun) {
    console.log("\nDry run — nothing was changed.");
    return;
  }
  if (pEnv === "production" && visible.length && !opts.yes) {
    if (!process.stdin.isTTY) die("Production changes need confirmation: re-run with --yes.", 2);
    const ok = await prompt("\nApply these changes to PRODUCTION? Type 'yes': ");
    if (ok.trim().toLowerCase() !== "yes") die("Aborted.", 2);
  }
  for (const a of actions) await a.run();

  // ── Write .env + lock ──
  if (catalog.mode === "fixed") {
    for (const [k, id] of Object.entries(ctx.productIds)) if (lock.products[k]) { lock.products[k].id = id; if (lock.products[k].status === "active") envUpdates[envKey("PADDLE_PRODUCT", k)] = id; }
    for (const [k, v] of Object.entries(lock.prices)) {
      if (ctx.priceIds[k]) v.id = ctx.priceIds[k];
      if (v.status === "active" && v.id) envUpdates[envKey("PADDLE_PRICE", k)] = v.id;
    }
    for (const [k, v] of Object.entries(lock.discounts)) if (v.id && v.status === "active") envUpdates[envKey("PADDLE_DISCOUNT", k)] = v.id;
  }
  envUpdates.PADDLE_CATALOG_MODE = catalog.mode;
  envUpdates.PADDLE_SYNCED_AT = lock.syncedAt = new Date().toISOString();
  if (!opts.only || opts.only.has("products")) { /* full lock */ } else {
    lock.products = { ...prevLock.products, ...lock.products };
    lock.prices = { ...prevLock.prices, ...lock.prices };
    lock.discounts = { ...prevLock.discounts, ...lock.discounts };
  }
  writeEnv(envPath, envText, envUpdates);
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  console.log(`\n✔ Done. Updated ${Object.keys(envUpdates).length} value(s) in ${path.relative(process.cwd(), envPath) || envPath} (backup: ${path.basename(envPath)}.paddle-backup) and wrote ${path.relative(process.cwd(), lockPath)}.`);
  if (priceChanges.length && policy === "grandfather") console.log("  Grandfathered prices stay mapped via price.custom_data.app_key — no app change needed.");
  console.log("  Restart the app so it picks up the new values.");
}

async function check({ api, catalog, env, pEnv }) {
  let problems = 0;
  const bad = (m) => { problems++; console.log(`  ✖ ${m}`); };
  const ok = (m) => console.log(`  ✔ ${m}`);
  for (const k of ["PADDLE_CLIENT_TOKEN", "PADDLE_WEBHOOK_SECRET", "APP_BASE_URL"]) env[k] ? ok(`${k} set`) : bad(`${k} is empty`);
  if (catalog.skills.some((s) => s !== "subscription") && !env.DOWNLOAD_SIGNING_SECRET) bad("DOWNLOAD_SIGNING_SECRET is empty (needed for one-time goods)");
  try { await api.list("/event-types"); ok("API key accepted by Paddle"); } catch (e) { bad(`API key rejected: ${e.message}`); return finish(); }
  if (catalog.mode === "fixed") {
    const expectKeys = [];
    for (const p of catalog.products) {
      if (p.archived) continue;
      expectKeys.push(["PADDLE_PRODUCT", p.key, "products"]);
      for (const pr of p.prices) { if (pr.archived) continue; expectKeys.push(["PADDLE_PRICE", pr.key, "prices"]); if (pr.trialDays) expectKeys.push(["PADDLE_PRICE", `${pr.key}_trial`, "prices"]); }
    }
    for (const d of catalog.discounts) if (!d.archived) expectKeys.push(["PADDLE_DISCOUNT", d.key, "discounts"]);
    for (const [prefix, key, res] of expectKeys) {
      const name = envKey(prefix, key);
      const id = env[name];
      if (!id) { bad(`${name} missing — run sync`); continue; }
      try {
        const e = await api.get(`/${res}/${id}`);
        if (e.status !== "active") bad(`${name}=${id} is ${e.status} in ${pEnv}`);
        else if (e.custom_data?.app !== catalog.app || e.custom_data?.app_key !== key) bad(`${name}=${id} belongs to ${e.custom_data?.app}/${e.custom_data?.app_key}, not ${catalog.app}/${key}`);
        else ok(`${name} ✓`);
      } catch (e) { bad(`${name}=${id} not found in ${pEnv} (${e.message}) — a ${pEnv === "production" ? "sandbox" : "live"} ID?`); }
    }
  }
  return finish();
  function finish() {
    console.log(problems ? `\n${problems} problem(s).` : "\nAll good.");
    process.exit(problems ? 1 : 0);
  }
}

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(q, (a) => { rl.close(); r(a); }));
}
async function askPolicy() {
  for (;;) {
    const a = (await prompt("  [g]randfather existing subscribers, [m]igrate them at next renewal, or [a]bort? ")).trim().toLowerCase();
    if (a === "g" || a === "grandfather") return "grandfather";
    if (a === "m" || a === "migrate") return "migrate";
    if (a === "a" || a === "abort") die("Aborted — nothing was changed.", 2);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("paddle-sync.mjs")) {
  main().catch((e) => die(e.stack && process.env.DEBUG ? e.stack : e.message));
}
