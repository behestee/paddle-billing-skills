# Stack: GeneXus (Java generator), optional

GeneXus projects follow the same contract. Only the building blocks differ.

| Contract piece | GeneXus object |
|---|---|
| Canonical tables | **Transactions** named exactly as the tables (`BillingSubscriptions`, attributes `PaddleSubscriptionId`, …). Map to the physical names via the table name property, or accept GeneXus naming, **but keep the column meanings 1:1** |
| `paddle_client` | Procedure `PaddleRequest(in:&Method, in:&PathOrUrl, in:&BodyJson, out:&Status, out:&ResponseJson)` using the **HttpClient** data type: `&Http.Host` / `.Secure=1` / `.BaseUrl`, `AddHeader('Authorization','Bearer '+&ApiKey)`, `AddHeader('Paddle-Version','1')`, `AddHeader('Content-Type','application/json')`, `AddString(&BodyJson)`, `Execute(&Method, &Path)`. Implement the retry loop (429/5xx, 3 attempts, 0.5/1/2 s via `Sleep()`) and `PaddleList` (follow `meta.pagination.next`). Parse with SDTs or `JSONObject` |
| Env vars | Read with `GetEnv()` / an environment-specific config procedure; the same variable names as the contract |
| Webhook | **REST procedure** exposed at `/webhooks/paddle` (Procedure with `Expose as web service = True`, REST protocol, or an HTTP procedure `HttpRequest`/`HttpResponse`). Read the raw body with `&HttpRequest.ToString()`, **before** any SDT deserialization |
| Signature HMAC | GeneXus `Crypto` / `CryptoSign` doesn't cover HMAC-SHA256 hex directly in every version: add an **External Object** wrapping a small Java class `PaddleSignature.verify(String raw, String header, String secret, long tol)` (copy the Java from `spring.md`) |
| Endpoints (§7) | REST procedures or Data Providers exposed as REST, with the same paths via the API object (GeneXus 17+) or URL rewriting on the web server |
| Scheduling | Deploy a batch/command-line procedure `ReconcileBilling` run by OS cron / Windows Task Scheduler |
| Frontend | A web panel with a **User Control** (or external JS) that loads `paddle-client.js` (frontend.md) and calls `openCheckout` with the checkout procedure's response |
| Sync script | Use `paddle_sync.py` or `paddle-sync.mjs` unchanged. Read IDs from `paddle.<env>.lock.json` (a JSON file read with a File data type + SDT) or from env vars |

Keep the JSON field names exactly Paddle's (`snake_case`) in SDTs used for Paddle bodies.
GeneXus SDT JSON names can be set per element (`JSON property name`).
