#!/usr/bin/env python3
"""paddle-sync — push paddle.catalog.json (products, prices, trial variants,
discounts) and the webhook destination to Paddle, then write the resulting
IDs into the .env file and paddle.<env>.lock.json.

Contract v1 (paddle-billing plugin). Behaviour is identical to
paddle-sync.mjs — keep the two in lockstep.

Zero dependencies. Python 3.9+.

Usage:
  python3 paddle_sync.py [sync|check|plan] [options]
    sync   (default) apply changes, write .env + lock file
    plan   same as `sync --dry-run`
    check  validate catalog + env and verify every ID in .env exists in
           the current Paddle environment; never writes
  --catalog <path>        default ./paddle.catalog.json
  --env-file <path>       default ./.env   (PADDLE_ENV is read from THIS file)
  --dry-run               print the plan, change nothing
  --yes                   non-interactive (CI / servers)
  --price-change <p>      grandfather | migrate — answer for every price change
  --prune                 archive app-owned Paddle entities missing from the catalog
  --only <list>           comma list of: products,discounts,webhook
  --api-base <url>        override the Paddle API base URL (tests only)

Exit codes: 0 ok · 1 error · 2 stopped because a decision was needed
"""
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

CONTRACT_VERSION = 1
ZERO_DECIMAL = {"JPY", "KRW", "CLP", "ISK", "VND", "HUF", "TWD", "UGX", "XAF", "XOF", "PYG", "RWF", "KMF", "GNF", "DJF", "BIF", "VUV", "XPF"}
DEFAULT_TAX = {"subscription": "saas", "digital_good": "standard", "ebook": "ebooks"}
TAX_CATEGORIES = ["standard", "saas", "digital-goods", "ebooks", "software-programming-services", "training-services", "professional-services", "implementation-services", "website-hosting"]
EVENTS = {
    "base": ["transaction.completed", "transaction.payment_failed", "adjustment.created", "adjustment.updated", "discount.created", "discount.updated", "customer.updated"],
    "subscription": ["subscription.created", "subscription.updated", "subscription.activated", "subscription.trialing", "subscription.past_due", "subscription.paused", "subscription.resumed", "subscription.canceled"],
}
MANAGED_MARKER = "# ── paddle-sync managed values (do not edit by hand) ──"
KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def die(msg, code=1):
    print(f"✖ {msg}", file=sys.stderr)
    sys.exit(code)


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


# ── CLI ──────────────────────────────────────────────────────────────────
def parse_args(argv):
    o = {"command": "sync", "catalog": "paddle.catalog.json", "env_file": ".env", "dry_run": False, "yes": False,
         "price_change": None, "prune": False, "only": None, "api_base": None}
    rest = list(argv)
    if rest and not rest[0].startswith("-"):
        o["command"] = rest.pop(0)
    while rest:
        a = rest.pop(0)

        def val():
            if not rest:
                die(f"{a} needs a value")
            return rest.pop(0)
        if a == "--catalog": o["catalog"] = val()
        elif a == "--env-file": o["env_file"] = val()
        elif a == "--dry-run": o["dry_run"] = True
        elif a in ("--yes", "-y"): o["yes"] = True
        elif a == "--price-change": o["price_change"] = val()
        elif a == "--prune": o["prune"] = True
        elif a == "--only": o["only"] = {s.strip() for s in val().split(",")}
        elif a == "--api-base": o["api_base"] = val()
        elif a in ("-h", "--help"):
            print(__doc__)
            sys.exit(0)
        else:
            die(f"Unknown option {a}")
    if o["command"] not in ("sync", "plan", "check"):
        die(f'Unknown command "{o["command"]}" (use sync, plan or check)')
    if o["command"] == "plan":
        o["command"] = "sync"
        o["dry_run"] = True
    if o["price_change"] and o["price_change"] not in ("grandfather", "migrate"):
        die("--price-change must be grandfather or migrate")
    for s in o["only"] or []:
        if s not in ("products", "discounts", "webhook"):
            die(f'--only: unknown section "{s}"')
    return o


def want(opts, section):
    return not opts["only"] or section in opts["only"]


# ── .env ─────────────────────────────────────────────────────────────────
ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")


def read_env(path):
    if not os.path.exists(path):
        die(f"Env file not found: {path}")
    with open(path, encoding="utf-8") as f:
        text = f.read()
    env = {}
    for line in text.splitlines():
        m = ENV_LINE.match(line)
        if not m:
            continue
        v = m.group(2).strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        else:
            v = re.sub(r"\s+#.*$", "", v).strip()
        env[m.group(1)] = v
    return text, env


def write_env(path, original, updates):
    lines = original.splitlines()
    pending = dict(updates)
    for i, line in enumerate(lines):
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if m and m.group(1) in pending:
            lines[i] = f"{m.group(1)}={pending.pop(m.group(1))}"
    if pending:
        if MANAGED_MARKER not in lines:
            lines += ["", MANAGED_MARKER]
        lines += [f"{k}={v}" for k, v in pending.items()]
    shutil.copyfile(path, f"{path}.paddle-backup")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def env_key(prefix, key):
    return f"{prefix}_" + re.sub(r"[^A-Z0-9]", "_", key.upper())


# ── Money ────────────────────────────────────────────────────────────────
def to_minor(amount, currency):
    s = str(amount).strip()
    if not re.match(r"^\d+(\.\d+)?$", s):
        raise ValueError(f'Invalid amount "{amount}"')
    digits = 0 if currency.upper() in ZERO_DECIMAL else 2
    whole, _, frac = s.partition(".")
    if len(frac) > digits:
        raise ValueError(f'Amount "{amount}" has more decimals than {currency} allows ({digits})')
    return str(int(whole + frac.ljust(digits, "0")))


def js_num_str(x):
    """String(Number(x)) as JavaScript renders it, for percentage amounts."""
    n = float(x)
    return str(int(n)) if n == int(n) else repr(n)


# ── Catalog validation ───────────────────────────────────────────────────
def strict(obj, allowed, where, errors):
    if not isinstance(obj, dict):
        errors.append(f"{where}: must be an object")
        return False
    for k in obj:
        if k not in allowed:
            errors.append(f'{where}: unknown field "{k}"')
    return True


def valid_rfc3339(s):
    try:
        datetime.fromisoformat(s.replace("Z", "+00:00"))
        return True
    except Exception:
        return False


def load_catalog(path):
    if not os.path.exists(path):
        die(f"Catalog not found: {path}")
    try:
        with open(path, encoding="utf-8") as f:
            c = json.load(f)
    except Exception as e:
        die(f"Catalog is not valid JSON: {e}")
    errors = []
    strict(c, ["$schema", "contractVersion", "app", "mode", "skills", "project", "currency", "taxMode", "priceChangePolicy", "checkout", "products", "discounts"], "catalog", errors)
    if c.get("contractVersion") != CONTRACT_VERSION:
        errors.append(f"contractVersion must be {CONTRACT_VERSION}")
    if not re.match(r"^[a-z0-9_-]{2,40}$", c.get("app") or ""):
        errors.append("app must match [a-z0-9_-]{2,40}")
    if c.get("mode") not in ("fixed", "dynamic"):
        errors.append('mode must be "fixed" or "dynamic"')
    sk = c.get("skills")
    if not isinstance(sk, list) or not sk or any(s not in ("subscription", "digital-goods", "ebook") for s in sk):
        errors.append("skills must be a non-empty array of subscription|digital-goods|ebook")
    if c.get("project"):
        strict(c["project"], ["backend", "frontend", "database"], "project", errors)
    else:
        errors.append("project is required")
    c["currency"] = (c.get("currency") or "USD").upper()
    c["taxMode"] = c.get("taxMode") or "account_setting"
    if c["taxMode"] not in ("account_setting", "internal", "external", "location"):
        errors.append("taxMode invalid")
    c["priceChangePolicy"] = c.get("priceChangePolicy") or "ask"
    if c["priceChangePolicy"] not in ("ask", "grandfather", "migrate"):
        errors.append("priceChangePolicy must be ask|grandfather|migrate")
    if c.get("checkout"):
        strict(c["checkout"], ["allowDiscountEntry", "displayMode", "successPath", "theme"], "checkout", errors)
    c["products"] = c.get("products") or []
    c["discounts"] = c.get("discounts") or []
    seen = set()

    def uniq(k, where):
        if k in seen:
            errors.append(f'{where}: duplicate key "{k}"')
        seen.add(k)

    for i, p in enumerate(c["products"]):
        w = f"products[{i}]" + (f" ({p.get('key')})" if isinstance(p, dict) and p.get("key") else "")
        if not strict(p, ["key", "kind", "name", "description", "taxCategory", "imageUrl", "features", "plan", "fulfillment", "prices", "archived"], w, errors):
            continue
        if not KEY_RE.match(p.get("key") or ""):
            errors.append(f"{w}: key must be snake_case")
        else:
            uniq(p["key"], w)
        if p.get("kind") not in ("subscription", "digital_good", "ebook"):
            errors.append(f"{w}: kind must be subscription|digital_good|ebook")
        if not p.get("name"):
            errors.append(f"{w}: name is required")
        p["taxCategory"] = p.get("taxCategory") or DEFAULT_TAX.get(p.get("kind"))
        if p["taxCategory"] not in TAX_CATEGORIES:
            errors.append(f'{w}: taxCategory "{p["taxCategory"]}" is not a Paddle tax category')
        p["plan"] = p.get("plan") or p.get("key")
        ful = p.get("fulfillment")
        if p.get("kind") == "ebook":
            files = (ful or {}).get("files") or []
            if (ful or {}).get("type") != "file" or not any(re.search(r"\.pdf$", f.get("path") or "", re.I) for f in files):
                errors.append(f'{w}: ebook products need fulfillment.type "file" with at least one .pdf')
        if ful:
            strict(ful, ["type", "files", "maxDownloads", "linkTtlMinutes", "licensePrefix", "accessKey", "url", "credits"], f"{w}.fulfillment", errors)
        if p.get("kind") != "subscription" and not ful:
            errors.append(f"{w}: one-time products need a fulfillment block")
        prices = p.get("prices")
        if not isinstance(prices, list) or not prices:
            errors.append(f"{w}: at least one price is required")
            continue
        for j, pr in enumerate(prices):
            pw = f"{w}.prices[{j}]" + (f" ({pr.get('key')})" if isinstance(pr, dict) and pr.get("key") else "")
            if not strict(pr, ["key", "name", "description", "amount", "currency", "interval", "frequency", "cycle", "trialDays", "seat", "maxSeats", "allowQuantity", "maxQuantity", "overrides", "archived"], pw, errors):
                continue
            k = pr.get("key") or ""
            if not KEY_RE.match(k) or k.endswith("_trial"):
                errors.append(f"{pw}: key must be snake_case and must not end in _trial")
            else:
                uniq(k, pw)
                uniq(f"{k}_trial", pw)
            pr["currency"] = (pr.get("currency") or c["currency"]).upper()
            try:
                to_minor(pr.get("amount"), pr["currency"])
            except ValueError as e:
                errors.append(f"{pw}: {e}")
            pr["interval"] = pr.get("interval")
            pr["frequency"] = pr.get("frequency") if pr.get("frequency") is not None else 1
            if p.get("kind") == "subscription" and not pr["interval"]:
                errors.append(f"{pw}: subscription prices need an interval")
            if p.get("kind") != "subscription" and (pr["interval"] or pr.get("trialDays") or pr.get("seat")):
                errors.append(f"{pw}: one-time prices can't have interval/trialDays/seat")
            if pr["interval"] and pr["interval"] not in ("day", "week", "month", "year"):
                errors.append(f"{pw}: interval must be day|week|month|year")
            td = pr.get("trialDays")
            if td is not None and not (isinstance(td, int) and not isinstance(td, bool) and td >= 1):
                errors.append(f"{pw}: trialDays must be a positive integer")
            if pr.get("seat") and td:
                errors.append(f"{pw}: seat prices can't have a trial (trials are per account, not per team)")
            if not pr.get("cycle"):
                if pr["interval"]:
                    if pr["frequency"] == 1 and pr["interval"] == "month": pr["cycle"] = "monthly"
                    elif pr["frequency"] == 1 and pr["interval"] == "year": pr["cycle"] = "yearly"
                    else: pr["cycle"] = f"{pr['frequency']}{pr['interval']}"
                else:
                    pr["cycle"] = None
            for kk, ov in enumerate(pr.get("overrides") or []):
                if not strict(ov, ["countries", "amount", "currency"], f"{pw}.overrides[{kk}]", errors):
                    continue
                ov["currency"] = (ov.get("currency") or pr["currency"]).upper()
                try:
                    to_minor(ov.get("amount"), ov["currency"])
                except ValueError as e:
                    errors.append(f"{pw}.overrides[{kk}]: {e}")
                if not isinstance(ov.get("countries"), list) or not ov["countries"]:
                    errors.append(f"{pw}.overrides[{kk}]: countries required")
    all_keys = {p.get("key") for p in c["products"] if isinstance(p, dict)} | {x.get("key") for p in c["products"] if isinstance(p, dict) for x in (p.get("prices") or []) if isinstance(x, dict)}
    for i, d in enumerate(c["discounts"]):
        w = f"discounts[{i}]" + (f" ({d.get('key')})" if isinstance(d, dict) and d.get("key") else "")
        if not strict(d, ["key", "code", "description", "type", "amount", "currency", "recur", "maxRecurringIntervals", "usageLimit", "restrictTo", "expiresAt", "enabled", "archived"], w, errors):
            continue
        if not KEY_RE.match(d.get("key") or ""):
            errors.append(f"{w}: key must be snake_case")
        else:
            uniq(f"discount:{d['key']}", w)
        if not re.match(r"^[A-Za-z0-9]{1,32}$", d.get("code") or ""):
            errors.append(f"{w}: code must be 1-32 letters/numbers")
        else:
            d["code"] = d["code"].upper()
        if not d.get("description"):
            errors.append(f"{w}: description is required")
        if d.get("type") not in ("percentage", "flat", "flat_per_seat"):
            errors.append(f"{w}: type must be percentage|flat|flat_per_seat")
        if d.get("type") == "percentage":
            try:
                n = float(d.get("amount"))
            except (TypeError, ValueError):
                n = -1
            if not (0.01 <= n <= 100):
                errors.append(f"{w}: percentage amount must be 0.01-100")
        else:
            d["currency"] = (d.get("currency") or c["currency"]).upper()
            try:
                to_minor(d.get("amount"), d["currency"])
            except ValueError as e:
                errors.append(f"{w}: {e}")
        if d.get("maxRecurringIntervals") is not None and not d.get("recur"):
            errors.append(f"{w}: maxRecurringIntervals requires recur: true")
        for k in d.get("restrictTo") or []:
            if k not in all_keys:
                errors.append(f'{w}: restrictTo references unknown key "{k}"')
        if d.get("expiresAt") and not valid_rfc3339(d["expiresAt"]):
            errors.append(f"{w}: expiresAt must be RFC 3339")
    if errors:
        die(f"Catalog has {len(errors)} problem(s):\n  - " + "\n  - ".join(errors))
    return c


# ── Paddle REST client (contract §5) ─────────────────────────────────────
class PaddleError(Exception):
    def __init__(self, status, body):
        e = (body or {}).get("error") or {}
        rid = ((body or {}).get("meta") or {}).get("request_id")
        msg = f"{status} {e.get('code') or ''}: {e.get('detail') or 'request failed'}"
        if rid:
            msg += f" (request_id {rid})"
        if e.get("errors"):
            msg += " " + json.dumps(e["errors"])
        super().__init__(msg)
        self.status, self.code, self.request_id = status, e.get("code"), rid


class Client:
    def __init__(self, base, api_key):
        self.base, self.api_key = base, api_key

    def request(self, method, url_or_path, body=None):
        url = url_or_path if url_or_path.startswith("http") else self.base + url_or_path
        data = json.dumps(body).encode() if body is not None else None
        attempt = 0
        while True:
            req = urllib.request.Request(url, data=data, method=method, headers={
                "Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json", "Paddle-Version": "1"})
            try:
                with urllib.request.urlopen(req, timeout=15) as res:
                    raw = res.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                raw = e.read()
                try:
                    parsed = json.loads(raw) if raw else {}
                except ValueError:
                    parsed = {}
                if (e.code == 429 or e.code >= 500) and attempt < 3:
                    try:
                        ra = float(e.headers.get("Retry-After") or 0)
                    except ValueError:
                        ra = 0
                    time.sleep(ra if ra > 0 else 0.5 * 2 ** attempt)
                    attempt += 1
                    continue
                raise PaddleError(e.code, parsed)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt < 3:
                    time.sleep(0.5 * 2 ** attempt)
                    attempt += 1
                    continue
                raise RuntimeError(f"Network error calling Paddle {method} {url}: {e}")

    def get(self, p): return self.request("GET", p).get("data")
    def post(self, p, b): return self.request("POST", p, b).get("data")
    def patch(self, p, b): return self.request("PATCH", p, b).get("data")

    def list(self, p):
        out, nxt = [], p
        while nxt:
            j = self.request("GET", nxt)
            d = j.get("data")
            out += d if isinstance(d, list) else []
            pag = (j.get("meta") or {}).get("pagination") or {}
            nxt = pag.get("next") if pag.get("has_more") else None
        return out


# ── Desired state from the catalog ───────────────────────────────────────
def desired_product(c, p):
    return {
        "name": p["name"],
        "description": p.get("description"),
        "tax_category": p["taxCategory"],
        "image_url": p.get("imageUrl"),
        "custom_data": {"app": c["app"], "app_key": p["key"], "kind": p["kind"]},
        "status": "archived" if p.get("archived") else "active",
    }


def desired_prices(c, p):
    out = []
    for pr in p["prices"]:
        seat = bool(pr.get("seat"))
        if seat:
            qty = {"minimum": 1, "maximum": pr.get("maxSeats") or 999}
        elif pr.get("allowQuantity"):
            qty = {"minimum": 1, "maximum": pr.get("maxQuantity") or 100}
        else:
            qty = {"minimum": 1, "maximum": 1}
        variants = [{"key": pr["key"], "trial": False, "removed": False}]
        variants.append({"key": f"{pr['key']}_trial", "trial": True, "removed": not pr.get("trialDays")})
        for v in variants:
            cd = {"app": c["app"], "app_key": v["key"], "product_key": p["key"]}
            if p["kind"] == "subscription":
                cd.update({"plan": p["plan"], "cycle": pr["cycle"]})
            cd.update({"seat": seat, "trial": v["trial"]})
            trial_label = f" ({pr['trialDays']}-day trial)" if v["trial"] and pr.get("trialDays") else ""
            out.append({
                "key": v["key"], "baseKey": pr["key"], "removed": v["removed"],
                "archived": bool(pr.get("archived")) or bool(p.get("archived")),
                "isSubscription": p["kind"] == "subscription",
                "body": {
                    "description": pr.get("description") or f"{p['name']} — {pr['cycle'] or 'one-time'}{trial_label}",
                    "name": pr.get("name") or p["name"],
                    "tax_mode": c["taxMode"],
                    "unit_price": {"amount": to_minor(pr["amount"], pr["currency"]), "currency_code": pr["currency"]},
                    "unit_price_overrides": [{"country_codes": [x.upper() for x in o["countries"]], "unit_price": {"amount": to_minor(o["amount"], o["currency"]), "currency_code": o["currency"]}} for o in (pr.get("overrides") or [])],
                    "billing_cycle": {"interval": pr["interval"], "frequency": pr["frequency"]} if pr["interval"] else None,
                    "trial_period": {"interval": "day", "frequency": pr["trialDays"], "requires_payment_method": True} if v["trial"] and pr.get("trialDays") else None,
                    "quantity": qty,
                    "custom_data": cd,
                },
            })
    return out


def sort_ov(arr):
    items = [json.dumps({"c": sorted(o.get("country_codes") or []), "a": str((o.get("unit_price") or {}).get("amount")), "cur": (o.get("unit_price") or {}).get("currency_code")}, sort_keys=True) for o in (arr or [])]
    return json.dumps(sorted(items))


def money_differs(existing, body):
    bc = lambda x: f"{x['interval']}:{x['frequency']}" if x else "none"
    tp = lambda x: f"{x['interval']}:{x['frequency']}:{x.get('requires_payment_method') is not False}".replace("True", "true").replace("False", "false") if x else "none"
    up = existing.get("unit_price") or {}
    return (str(up.get("amount")) != body["unit_price"]["amount"]
            or up.get("currency_code") != body["unit_price"]["currency_code"]
            or bc(existing.get("billing_cycle")) != bc(body["billing_cycle"])
            or tp(existing.get("trial_period")) != tp(body["trial_period"])
            or sort_ov(existing.get("unit_price_overrides")) != sort_ov(body["unit_price_overrides"]))


def eq(a, b):
    return json.dumps(a, sort_keys=False) == json.dumps(b, sort_keys=False)


def custom_eq(a, b):
    a, b = a or {}, b or {}
    return sorted(a) == sorted(b) and all(eq(a[k], b[k]) for k in a)


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() if s else None


def iso_z(s):
    d = datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)
    ms = d.microsecond // 1000
    return d.strftime("%Y-%m-%dT%H:%M:%S") + (f".{ms:03d}Z" if ms else "Z")


class Action:
    def __init__(self, label, run):
        self.label, self.run = label, run


def prompt(q):
    try:
        return input(q)
    except EOFError:
        return ""


def ask_policy():
    while True:
        a = prompt("  [g]randfather existing subscribers, [m]igrate them at next renewal, or [a]bort? ").strip().lower()
        if a in ("g", "grandfather"): return "grandfather"
        if a in ("m", "migrate"): return "migrate"
        if a in ("a", "abort"): die("Aborted — nothing was changed.", 2)


# ── Main ─────────────────────────────────────────────────────────────────
def main():
    opts = parse_args(sys.argv[1:])
    catalog_path = os.path.abspath(opts["catalog"])
    env_path = os.path.abspath(opts["env_file"])
    catalog = load_catalog(catalog_path)
    env_text, env = read_env(env_path)

    p_env = env.get("PADDLE_ENV")
    if p_env not in ("sandbox", "production"):
        die(f'PADDLE_ENV in {opts["env_file"]} must be "sandbox" or "production" (got "{p_env or ""}")')
    api_key = (env.get("PADDLE_API_KEY") or "").strip()
    expected = "pdl_live_apikey_" if p_env == "production" else "pdl_sdbx_apikey_"
    if not api_key:
        die(f"PADDLE_API_KEY is empty in {opts['env_file']}")
    if not api_key.startswith(expected):
        other = "pdl_sdbx_apikey_" if p_env == "production" else "pdl_live_apikey_"
        if api_key.startswith(other):
            die(f"PADDLE_API_KEY is a {'SANDBOX' if p_env == 'production' else 'LIVE'} key but PADDLE_ENV={p_env}. Refusing to continue.")
        die(f'PADDLE_API_KEY is malformed — expected it to start with "{expected}" (a character lost on paste?)')
    ct = env.get("PADDLE_CLIENT_TOKEN") or ""
    ct_prefix = "live_" if p_env == "production" else "test_"
    if ct and not ct.startswith(ct_prefix):
        print(f'⚠ PADDLE_CLIENT_TOKEN doesn\'t look like a {p_env} token (expected prefix "{ct_prefix}")', file=sys.stderr)
    if not ct:
        print("⚠ PADDLE_CLIENT_TOKEN is empty — the browser checkout won't open until you set it.", file=sys.stderr)

    base = opts["api_base"] or ("https://api.paddle.com" if p_env == "production" else "https://sandbox-api.paddle.com")
    api = Client(base, api_key)
    print(f"paddle-sync · app={catalog['app']} · env={p_env} · mode={catalog['mode']}" + (" · DRY RUN" if opts["dry_run"] else ""))
    if p_env == "production":
        print("  ⚠ PRODUCTION — changes affect real customers.")

    if opts["command"] == "check":
        return check(api, catalog, env, p_env)

    lock_path = os.path.join(os.path.dirname(catalog_path), f"paddle.{p_env}.lock.json")
    prev_lock = {}
    if os.path.exists(lock_path):
        with open(lock_path, encoding="utf-8") as f:
            prev_lock = json.load(f)
    lock = {"contractVersion": CONTRACT_VERSION, "app": catalog["app"], "env": p_env, "syncedAt": None,
            "products": {}, "prices": {}, "discounts": {}, "webhook": prev_lock.get("webhook")}
    env_updates = {}
    actions = []
    ctx = {"productIds": {}, "priceIds": {}, "dry": opts["dry_run"]}
    pending = set()
    price_changes = []

    do_catalog = catalog["mode"] == "fixed" and want(opts, "products")
    do_discounts = catalog["mode"] == "fixed" and want(opts, "discounts")
    if catalog["mode"] == "dynamic" and (want(opts, "products") or want(opts, "discounts")):
        print("  dynamic mode: products/prices/discounts are pushed by the app at runtime (admin UI / catalog resync). Syncing webhook + env only.")

    def add_a(a):
        if do_catalog:
            actions.append(a)

    # ── Products & prices ──
    if do_catalog or do_discounts:
        all_products = api.list("/products?per_page=200&status=active,archived")
        all_prices = api.list("/prices?per_page=200&status=active,archived")
        mine = lambda x: (x.get("custom_data") or {}).get("app") == catalog["app"]
        app_key = lambda x: (x.get("custom_data") or {}).get("app_key")
        catalog_product_keys = {p["key"] for p in catalog["products"]}
        catalog_price_keys = set()

        for p in catalog["products"]:
            want_ = desired_product(catalog, p)
            existing = next((x for x in all_products if mine(x) and app_key(x) == p["key"]), None)
            adopt = False
            if not existing:
                existing = next((x for x in all_products if not (x.get("custom_data") or {}).get("app") and x.get("status") == "active" and x.get("name") == p["name"]), None)
                adopt = existing is not None
            if not existing:
                pending.add(p["key"])

                def run_create_product(p=p, want_=want_):
                    if ctx["dry"]:
                        ctx["productIds"][p["key"]] = f"(new:{p['key']})"
                        return
                    body = {k: v for k, v in want_.items() if k != "status"}
                    created = api.post("/products", body)
                    ctx["productIds"][p["key"]] = created["id"]
                    if want_["status"] == "archived":
                        api.patch(f"/products/{created['id']}", {"status": "archived"})
                add_a(Action(f'+ product {p["key"]} "{p["name"]}" ({p["taxCategory"]})', run_create_product))
            else:
                ctx["productIds"][p["key"]] = existing["id"]
                diff = {k: want_[k] for k in ("name", "description", "tax_category", "image_url", "status") if not eq(existing.get(k), want_[k])}
                if not custom_eq(existing.get("custom_data"), want_["custom_data"]):
                    diff["custom_data"] = want_["custom_data"]
                if diff:
                    add_a(Action(f"~ product {p['key']} " + ("(adopting legacy product) " if adopt else "") + ", ".join(diff),
                                 lambda eid=existing["id"], diff=diff: None if ctx["dry"] else api.patch(f"/products/{eid}", diff)))
            lock["products"][p["key"]] = {"id": existing["id"] if existing else None, "status": want_["status"]}

            for d in desired_prices(catalog, p):
                if not d["removed"]:
                    catalog_price_keys.add(d["key"])
                cands = [x for x in all_prices if mine(x) and app_key(x) == d["key"] and x.get("status") == "active" and (not existing or x.get("product_id") == existing["id"])]
                cands.sort(key=lambda x: str(x.get("created_at")), reverse=True)
                cur = cands[0] if cands else None
                for extra in cands[1:]:
                    add_a(Action(f"- price {d['key']} duplicate {extra['id']} → archive",
                                 lambda xid=extra["id"]: None if ctx["dry"] else api.patch(f"/prices/{xid}", {"status": "archived"})))
                adopt_price = False
                if not cur and existing and not d["removed"]:
                    cur = next((x for x in all_prices if not (x.get("custom_data") or {}).get("app") and x.get("status") == "active" and x.get("product_id") == existing["id"] and not money_differs(x, d["body"])), None)
                    adopt_price = cur is not None
                history = ((prev_lock.get("prices") or {}).get(d["key"]) or {}).get("history") or []
                if d["removed"] or d["archived"]:
                    if cur:
                        add_a(Action(f"- price {d['key']} {cur['id']} → archive" + (" (trial removed from catalog)" if d["removed"] else ""),
                                     lambda cid=cur["id"]: None if ctx["dry"] else api.patch(f"/prices/{cid}", {"status": "archived"})))
                    if not d["removed"] or cur or history:
                        prev_id = ((prev_lock.get("prices") or {}).get(d["key"]) or {}).get("id")
                        lock["prices"][d["key"]] = {"id": cur["id"] if cur else prev_id, "productKey": p["key"], "status": "archived", "history": history}
                    continue

                def create(why=None, d=d, p=p):
                    pending.add(d["key"])
                    b = d["body"]
                    label = f"+ price {d['key']} {b['unit_price']['amount']} {b['unit_price']['currency_code']}"
                    if b["billing_cycle"]:
                        label += f" / {b['billing_cycle']['frequency']} {b['billing_cycle']['interval']}"
                    if b["trial_period"]:
                        label += f" · trial {b['trial_period']['frequency']}d"
                    if why:
                        label += f" ({why})"

                    def run():
                        if ctx["dry"]:
                            ctx["priceIds"][d["key"]] = f"(new:{d['key']})"
                            return
                        created = api.post("/prices", {**b, "product_id": ctx["productIds"][p["key"]]})
                        ctx["priceIds"][d["key"]] = created["id"]
                    add_a(Action(label, run))

                if not cur:
                    create()
                    lock["prices"][d["key"]] = {"id": None, "productKey": p["key"], "status": "active", "history": history}
                elif money_differs(cur, d["body"]):
                    create(f"replaces {cur['id']}")
                    add_a(Action(f"- price {d['key']} {cur['id']} → archive (superseded)",
                                 lambda cid=cur["id"]: None if ctx["dry"] else api.patch(f"/prices/{cid}", {"status": "archived"})))
                    if d["isSubscription"] and do_catalog:
                        price_changes.append({"key": d["key"], "oldId": cur["id"], "old": cur.get("unit_price"), "next": d["body"]["unit_price"]})
                    lock["prices"][d["key"]] = {"id": None, "productKey": p["key"], "status": "active", "history": history + [{"id": cur["id"], "archivedAt": now_iso()}]}
                else:
                    ctx["priceIds"][d["key"]] = cur["id"]
                    diff = {k: d["body"][k] for k in ("name", "description", "tax_mode", "quantity") if not eq(cur.get(k), d["body"][k])}
                    if not custom_eq(cur.get("custom_data"), d["body"]["custom_data"]):
                        diff["custom_data"] = d["body"]["custom_data"]
                    if diff:
                        add_a(Action(f"~ price {d['key']} " + ("(adopting legacy price) " if adopt_price else "") + ", ".join(diff),
                                     lambda cid=cur["id"], diff=diff: None if ctx["dry"] else api.patch(f"/prices/{cid}", diff)))
                    lock["prices"][d["key"]] = {"id": cur["id"], "productKey": p["key"], "status": "active", "history": history}

        if opts["prune"] and do_catalog:
            for x in all_products:
                if mine(x) and x.get("status") == "active" and app_key(x) not in catalog_product_keys:
                    add_a(Action(f"- product {app_key(x)} {x['id']} → archive (not in catalog)",
                                 lambda xid=x["id"]: None if ctx["dry"] else api.patch(f"/products/{xid}", {"status": "archived"})))
            for x in all_prices:
                if mine(x) and x.get("status") == "active" and app_key(x) not in catalog_price_keys and not any(x["id"] in (a.label or "") for a in actions):
                    add_a(Action(f"- price {app_key(x)} {x['id']} → archive (not in catalog)",
                                 lambda xid=x["id"]: None if ctx["dry"] else api.patch(f"/prices/{xid}", {"status": "archived"})))

    # ── Price-change policy (decided BEFORE anything is changed) ──
    policy = None
    if price_changes:
        print(f"\n{len(price_changes)} subscription price change(s):")
        for ch in price_changes:
            print(f"  • {ch['key']}: {(ch['old'] or {}).get('amount')} {(ch['old'] or {}).get('currency_code')} → {ch['next']['amount']} {ch['next']['currency_code']}")
        policy = opts["price_change"] or (catalog["priceChangePolicy"] if catalog["priceChangePolicy"] != "ask" else None)
        if not policy:
            if opts["yes"] or not sys.stdin.isatty():
                die("Price changes need a decision: re-run with --price-change grandfather|migrate (or set priceChangePolicy in the catalog).", 2)
            policy = ask_policy()
        print(f"  policy: {policy}" + (" (existing subscribers keep their current price)" if policy == "grandfather" else " (existing subscribers move to the new price at their next renewal, no immediate charge)"))
        if policy == "migrate":
            for ch in price_changes:
                def run_migrate(ch=ch):
                    if ctx["dry"]:
                        return
                    subs = api.list(f"/subscriptions?per_page=200&price_id={ch['oldId']}&status=active,trialing,past_due")
                    n = 0
                    for s in subs:
                        items = [{"price_id": ctx["priceIds"][ch["key"]] if it["price"]["id"] == ch["oldId"] else it["price"]["id"], "quantity": it["quantity"]} for it in s["items"]]
                        api.patch(f"/subscriptions/{s['id']}", {"items": items, "proration_billing_mode": "do_not_bill"})
                        n += 1
                    print(f"    migrated {n} subscription(s)")
                actions.append(Action(f"» migrate subscribers of {ch['key']} from {ch['oldId']}", run_migrate))

    # ── Discounts ──
    if do_discounts:
        all_discounts = api.list("/discounts?per_page=200&status=active,archived")
        mine = lambda x: (x.get("custom_data") or {}).get("app") == catalog["app"]
        keys_in_catalog = {d["key"] for d in catalog["discounts"]}
        product_keys = {p["key"] for p in catalog["products"]}
        all_price_defs = [pr for p in catalog["products"] for pr in p["prices"]]

        def expand(k):
            if k in product_keys:
                return [("product", k)]
            base = next((x for x in all_price_defs if x["key"] == k), None)
            keys = [k] + ([f"{k}_trial"] if base and base.get("trialDays") else [])
            return [("price", kk) for kk in keys]

        def resolve(ref):
            kind, key = ref
            v = (ctx["productIds"] if kind == "product" else ctx["priceIds"]).get(key)
            return v or (f"(new:{key})" if key in pending else None)

        def body_for(d):
            rt = None
            if d.get("restrictTo"):
                rt = [x for x in (resolve(r) for k in d["restrictTo"] for r in expand(k)) if x]
            return {
                "description": d["description"],
                "type": d["type"],
                "amount": js_num_str(d["amount"]) if d["type"] == "percentage" else to_minor(d["amount"], d["currency"]),
                "currency_code": None if d["type"] == "percentage" else d["currency"],
                "code": d["code"],
                "enabled_for_checkout": d.get("enabled") is not False,
                "recur": bool(d.get("recur")),
                "maximum_recurring_intervals": d.get("maxRecurringIntervals") if d.get("recur") else None,
                "usage_limit": d.get("usageLimit"),
                "restrict_to": rt,
                "expires_at": iso_z(d["expiresAt"]) if d.get("expiresAt") else None,
                "custom_data": {"app": catalog["app"], "app_key": d["key"]},
            }

        def set_eq(x, y):
            return (x is None and y is None) or (x is not None and y is not None and sorted(x) == sorted(y))

        for d in catalog["discounts"]:
            existing = next((x for x in all_discounts if mine(x) and (x.get("custom_data") or {}).get("app_key") == d["key"]), None)
            adopt = False
            if not existing:
                existing = next((x for x in all_discounts if not (x.get("custom_data") or {}).get("app") and (x.get("code") or "").upper() == d["code"]), None)
                adopt = existing is not None
            want_status = "archived" if d.get("archived") else "active"
            if not existing:
                if d.get("archived"):
                    continue
                lock["discounts"][d["key"]] = {"id": None, "code": d["code"], "status": "active"}

                def run_create_discount(d=d):
                    if ctx["dry"]:
                        return
                    created = api.post("/discounts", body_for(d))
                    lock["discounts"][d["key"]]["id"] = created["id"]
                amt = f"{d['amount']}%" if d["type"] == "percentage" else f"{d['amount']} {d['currency']}"
                actions.append(Action(f"+ discount {d['key']} code={d['code']} {d['type']} {amt}", run_create_discount))
                continue
            lock["discounts"][d["key"]] = {"id": existing["id"], "code": d["code"], "status": want_status}
            b = body_for(d)
            fields = [k for k in ("description", "type", "amount", "currency_code", "enabled_for_checkout", "recur", "maximum_recurring_intervals", "usage_limit") if not eq(existing.get(k), b[k])]
            if (existing.get("code") or "").upper() != b["code"]:
                fields.append("code")
            if not set_eq(existing.get("restrict_to"), b["restrict_to"]):
                fields.append("restrict_to")
            if parse_ts(existing.get("expires_at")) != parse_ts(b["expires_at"]):
                fields.append("expires_at")
            if not custom_eq(existing.get("custom_data"), b["custom_data"]):
                fields.append("custom_data")
            if existing.get("status") != want_status:
                fields.append("status")
            if not fields:
                continue

            def run_patch_discount(d=d, fields=fields, eid=existing["id"], want_status=want_status):
                if ctx["dry"]:
                    return
                fresh = body_for(d)
                api.patch(f"/discounts/{eid}", {k: (want_status if k == "status" else fresh[k]) for k in fields})
            actions.append(Action(f"~ discount {d['key']} " + ("(adopting legacy discount) " if adopt else "") + ", ".join(fields), run_patch_discount))
        if opts["prune"]:
            for x in all_discounts:
                if mine(x) and x.get("status") == "active" and (x.get("custom_data") or {}).get("app_key") not in keys_in_catalog:
                    actions.append(Action(f"- discount {(x.get('custom_data') or {}).get('app_key')} {x['id']} → archive (not in catalog)",
                                          lambda xid=x["id"]: None if ctx["dry"] else api.patch(f"/discounts/{xid}", {"status": "archived"})))

    # ── Webhook destination ──
    if want(opts, "webhook") and env.get("PADDLE_WEBHOOK_URL"):
        url = env["PADDLE_WEBHOOK_URL"].strip()
        events = sorted(EVENTS["base"] + (EVENTS["subscription"] if "subscription" in catalog["skills"] else []))
        settings = api.list("/notification-settings")
        existing = next((s for s in settings if s.get("destination") == url), None)
        traffic = "all" if p_env == "sandbox" else "platform"
        if not existing:
            def run_create_webhook():
                if ctx["dry"]:
                    return
                created = api.post("/notification-settings", {"description": f"{catalog['app']} ({p_env}) — paddle-sync", "type": "url", "destination": url,
                                                              "subscribed_events": events, "api_version": 1, "include_sensitive_fields": False, "traffic_source": traffic})
                env_updates["PADDLE_WEBHOOK_SECRET"] = created["endpoint_secret_key"]
                env_updates["PADDLE_NOTIFICATION_SETTING_ID"] = created["id"]
                lock["webhook"] = {"notificationSettingId": created["id"], "url": url}
            actions.append(Action(f"+ webhook destination {url} ({len(events)} events)", run_create_webhook))
        else:
            have = sorted((e.get("name") if isinstance(e, dict) else e) for e in (existing.get("subscribed_events") or []))
            diff = {}
            if have != events:
                diff["subscribed_events"] = events
            if existing.get("active") is False:
                diff["active"] = True
            if existing.get("traffic_source") and existing["traffic_source"] != traffic:
                diff["traffic_source"] = traffic
            if diff:
                actions.append(Action(f"~ webhook destination {url} " + ", ".join(diff),
                                      lambda eid=existing["id"], diff=diff: None if ctx["dry"] else api.patch(f"/notification-settings/{eid}", diff)))
            env_updates["PADDLE_NOTIFICATION_SETTING_ID"] = existing["id"]
            if existing.get("endpoint_secret_key") and existing["endpoint_secret_key"] != env.get("PADDLE_WEBHOOK_SECRET"):
                env_updates["PADDLE_WEBHOOK_SECRET"] = existing["endpoint_secret_key"]
            lock["webhook"] = {"notificationSettingId": existing["id"], "url": url}
    elif want(opts, "webhook") and not env.get("PADDLE_WEBHOOK_URL"):
        print("  (PADDLE_WEBHOOK_URL not set — skipping webhook destination; set it to have the secret filled in automatically)")

    # ── Execute ──
    print(f"\nPlan ({len(actions)} change(s)):" if actions else "\nNo changes needed.")
    for a in actions:
        print(f"  {a.label}")
    if opts["dry_run"]:
        print("\nDry run — nothing was changed.")
        return
    if p_env == "production" and actions and not opts["yes"]:
        if not sys.stdin.isatty():
            die("Production changes need confirmation: re-run with --yes.", 2)
        if prompt("\nApply these changes to PRODUCTION? Type 'yes': ").strip().lower() != "yes":
            die("Aborted.", 2)
    for a in actions:
        a.run()

    # ── Write .env + lock ──
    if catalog["mode"] == "fixed":
        for k, pid in ctx["productIds"].items():
            if k in lock["products"]:
                lock["products"][k]["id"] = pid
                if lock["products"][k]["status"] == "active":
                    env_updates[env_key("PADDLE_PRODUCT", k)] = pid
        for k, v in lock["prices"].items():
            if ctx["priceIds"].get(k):
                v["id"] = ctx["priceIds"][k]
            if v["status"] == "active" and v["id"]:
                env_updates[env_key("PADDLE_PRICE", k)] = v["id"]
        for k, v in lock["discounts"].items():
            if v["id"] and v["status"] == "active":
                env_updates[env_key("PADDLE_DISCOUNT", k)] = v["id"]
    env_updates["PADDLE_CATALOG_MODE"] = catalog["mode"]
    lock["syncedAt"] = env_updates["PADDLE_SYNCED_AT"] = now_iso()
    if opts["only"] and "products" not in opts["only"]:
        for sec in ("products", "prices", "discounts"):
            lock[sec] = {**(prev_lock.get(sec) or {}), **lock[sec]}
    write_env(env_path, env_text, env_updates)
    with open(lock_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(lock, indent=2, ensure_ascii=False) + "\n")
    rel_env = os.path.relpath(env_path) or env_path
    print(f"\n✔ Done. Updated {len(env_updates)} value(s) in {rel_env} (backup: {os.path.basename(env_path)}.paddle-backup) and wrote {os.path.relpath(lock_path)}.")
    if price_changes and policy == "grandfather":
        print("  Grandfathered prices stay mapped via price.custom_data.app_key — no app change needed.")
    print("  Restart the app so it picks up the new values.")


def check(api, catalog, env, p_env):
    problems = 0

    def bad(m):
        nonlocal problems
        problems += 1
        print(f"  ✖ {m}")

    def ok(m):
        print(f"  ✔ {m}")

    def finish():
        print(f"\n{problems} problem(s)." if problems else "\nAll good.")
        sys.exit(1 if problems else 0)

    for k in ("PADDLE_CLIENT_TOKEN", "PADDLE_WEBHOOK_SECRET", "APP_BASE_URL"):
        ok(f"{k} set") if env.get(k) else bad(f"{k} is empty")
    if any(s != "subscription" for s in catalog["skills"]) and not env.get("DOWNLOAD_SIGNING_SECRET"):
        bad("DOWNLOAD_SIGNING_SECRET is empty (needed for one-time goods)")
    try:
        api.list("/event-types")
        ok("API key accepted by Paddle")
    except Exception as e:
        bad(f"API key rejected: {e}")
        finish()
    if catalog["mode"] == "fixed":
        expect = []
        for p in catalog["products"]:
            if p.get("archived"):
                continue
            expect.append(("PADDLE_PRODUCT", p["key"], "products"))
            for pr in p["prices"]:
                if pr.get("archived"):
                    continue
                expect.append(("PADDLE_PRICE", pr["key"], "prices"))
                if pr.get("trialDays"):
                    expect.append(("PADDLE_PRICE", f"{pr['key']}_trial", "prices"))
        for d in catalog["discounts"]:
            if not d.get("archived"):
                expect.append(("PADDLE_DISCOUNT", d["key"], "discounts"))
        for prefix, key, res in expect:
            name = env_key(prefix, key)
            eid = env.get(name)
            if not eid:
                bad(f"{name} missing — run sync")
                continue
            try:
                e = api.get(f"/{res}/{eid}")
                cd = e.get("custom_data") or {}
                if e.get("status") != "active":
                    bad(f"{name}={eid} is {e.get('status')} in {p_env}")
                elif cd.get("app") != catalog["app"] or cd.get("app_key") != key:
                    bad(f"{name}={eid} belongs to {cd.get('app')}/{cd.get('app_key')}, not {catalog['app']}/{key}")
                else:
                    ok(f"{name} ✓")
            except Exception as ex:
                bad(f"{name}={eid} not found in {p_env} ({ex}) — a {'sandbox' if p_env == 'production' else 'live'} ID?")
    finish()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        die(str(e))
