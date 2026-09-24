# Stack: Python + FastAPI

- Python ≥ 3.10, `httpx` (sync or async client), SQLAlchemy 2 + Alembic (or the project's ORM), `pydantic` models for the contract bodies.
- No Paddle SDK (contract §1).
- Scheduling: APScheduler in the app for one instance, or Celery beat / RQ-scheduler / an external cron hitting the admin reconcile endpoint.

## Layout
```
app/billing/  config.py paddle_client.py catalog.py catalog_sync.py customers.py discounts.py
              checkout.py webhooks.py subscriptions.py teams.py purchases.py refunds.py
              reconciliation.py audit.py router.py        # APIRouter with contract §7 paths
scripts/paddle_sync.py                                     # copied unmodified from the plugin
alembic/versions/xxxx_billing.py                           # canonical tables
```

## paddle_client.py
```python
import time, httpx
from .config import settings

class PaddleApiError(Exception):
    def __init__(self, status: int, body: dict):
        e = (body or {}).get("error") or {}
        self.status, self.code, self.detail = status, e.get("code"), e.get("detail")
        self.request_id = ((body or {}).get("meta") or {}).get("request_id")
        self.errors = e.get("errors")
        super().__init__(f"{status} {self.code}: {self.detail} (request_id {self.request_id})")

def is_not_found(e: Exception) -> bool:
    return isinstance(e, PaddleApiError) and (e.code == "not_found" or e.status == 404)

BASE = "https://api.paddle.com" if settings.paddle_env == "production" else "https://sandbox-api.paddle.com"
_client = httpx.Client(timeout=15, headers={"Authorization": f"Bearer {settings.paddle_api_key}", "Paddle-Version": "1"})

def _request(method: str, path_or_url: str, body: dict | None = None) -> dict:
    url = path_or_url if path_or_url.startswith("http") else BASE + path_or_url
    for attempt in range(4):
        try:
            r = _client.request(method, url, json=body)
        except httpx.TransportError:
            if attempt < 3: time.sleep(0.5 * 2 ** attempt); continue
            raise
        if r.is_success: return r.json()
        if (r.status_code == 429 or r.status_code >= 500) and attempt < 3:
            ra = float(r.headers.get("retry-after") or 0)
            time.sleep(ra if ra > 0 else 0.5 * 2 ** attempt); continue
        try: body_json = r.json()
        except ValueError: body_json = {}
        raise PaddleApiError(r.status_code, body_json)

def get(p): return _request("GET", p)["data"]
def post(p, b): return _request("POST", p, b)["data"]
def patch(p, b): return _request("PATCH", p, b)["data"]
def list_all(p):
    out, nxt = [], p
    while nxt:
        j = _request("GET", nxt); out += j["data"]
        pag = (j.get("meta") or {}).get("pagination") or {}
        nxt = pag.get("next") if pag.get("has_more") else None
    return out
```
With `async def` routes, use `httpx.AsyncClient` with the same shape and `await asyncio.sleep`.

## Webhook
```python
import hmac, hashlib, time
from fastapi import APIRouter, Request, Response

def verify_paddle_signature(raw: bytes, header: str | None, secret: str, tolerance: int = 5, now: int | None = None) -> bool:
    if not header or not secret: return False
    pairs = [p.split("=", 1) for p in header.split(";") if "=" in p]
    ts = next((v for k, v in pairs if k == "ts"), None)
    sigs = [v for k, v in pairs if k == "h1"]
    now = int(time.time()) if now is None else now
    if not ts or not sigs or abs(now - int(ts)) > tolerance: return False
    expected = hmac.new(secret.encode(), ts.encode() + b":" + raw, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in sigs)

@router.post("/webhooks/paddle")
async def paddle_webhook(request: Request):
    raw = await request.body()                   # raw bytes, before any parsing
    if not verify_paddle_signature(raw, request.headers.get("paddle-signature"), settings.paddle_webhook_secret, settings.paddle_webhook_tolerance_sec):
        return Response("bad signature", status_code=400)
    return handle_event(json.loads(raw))          # 200 / 500 per webhooks.md
```

## Notes
- Money: `int` minor units, `Decimal` only for display. Reuse `to_minor` from `paddle_sync.py`.
- Django / Flask: same modules; the webhook view reads `request.body` / `request.get_data()`. Django needs `@csrf_exempt`.
- Tests: pytest + `respx` to mock httpx, or run the plugin's mock server.
