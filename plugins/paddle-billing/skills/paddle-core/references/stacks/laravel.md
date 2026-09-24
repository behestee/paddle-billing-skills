# Stack: PHP + Laravel

- PHP ≥ 8.1, Laravel ≥ 10. HTTP via `Illuminate\Support\Facades\Http`. **Don't use Laravel
  Cashier-Paddle**: it has its own schema, webhooks and naming, which would break the contract.
  No Paddle SDK.
- Migrations: one migration per canonical table, exact names.
- Scheduling: `app/Console/Kernel.php` / `routes/console.php` → `Schedule::job(new ReconcileBilling)->everySixHours()`.
- Queues: send purchase emails via queued Mailables.

## Layout
```
app/Billing/  Config.php PaddleClient.php PaddleApiError.php Catalog.php CatalogSync.php Customers.php
              Discounts.php Checkout.php Webhooks.php Subscriptions.php Teams.php Purchases.php
              Refunds.php Reconciliation.php Audit.php
app/Http/Controllers/Billing/*Controller.php
routes/api.php            # contract §7 paths (the /api prefix is automatic)
routes/web.php            # POST /webhooks/paddle (outside /api), GET /d/{token}
scripts/paddle-sync.mjs or scripts/paddle_sync.py
config/paddle.php         # reads env
```

## PaddleClient.php
```php
final class PaddleClient {
    private function base(): string {
        return config('paddle.env') === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
    }
    private function request(string $method, string $pathOrUrl, ?array $body = null): array {
        $url = str_starts_with($pathOrUrl, 'http') ? $pathOrUrl : $this->base().$pathOrUrl;
        for ($attempt = 0; ; $attempt++) {
            try {
                $res = Http::timeout(15)->withToken(config('paddle.api_key'))
                    ->withHeaders(['Paddle-Version' => '1'])->acceptJson()
                    ->send($method, $url, $body !== null ? ['json' => $body] : []);
            } catch (\Illuminate\Http\Client\ConnectionException $e) {
                if ($attempt < 3) { usleep((int) (500000 * 2 ** $attempt)); continue; }
                throw $e;
            }
            if ($res->successful()) return $res->json();
            if (($res->status() === 429 || $res->status() >= 500) && $attempt < 3) {
                $ra = (float) $res->header('Retry-After');
                usleep((int) (($ra > 0 ? $ra : 0.5 * 2 ** $attempt) * 1000000)); continue;
            }
            throw new PaddleApiError($res->status(), $res->json() ?? []);
        }
    }
    public function get(string $p): array   { return $this->request('GET', $p)['data']; }
    public function post(string $p, array $b): array  { return $this->request('POST', $p, $b)['data']; }
    public function patch(string $p, array $b): array { return $this->request('PATCH', $p, $b)['data']; }
    public function list(string $p): array {
        $out = []; $next = $p;
        while ($next) { $j = $this->request('GET', $next); array_push($out, ...$j['data']);
            $next = ($j['meta']['pagination']['has_more'] ?? false) ? $j['meta']['pagination']['next'] : null; }
        return $out;
    }
}
```
Watch out: PHP's `json_encode` turns an empty array `[]` into `[]`, but an empty **object** must
be sent as `(object) []` (for example `custom_data`). Send `null` for "no value", as the contract does.

## Webhook (route in `web.php`; exclude it from CSRF)
```php
function verifyPaddleSignature(string $raw, ?string $header, string $secret, int $tolerance = 5, ?int $now = null): bool {
    if (!$header || !$secret) return false;
    $ts = null; $sigs = [];
    foreach (explode(';', $header) as $part) { [$k, $v] = array_pad(explode('=', $part, 2), 2, null);
        if ($k === 'ts') $ts = $v; elseif ($k === 'h1') $sigs[] = $v; }
    $now ??= time();
    if (!$ts || !$sigs || abs($now - (int) $ts) > $tolerance) return false;
    $expected = hash_hmac('sha256', $ts.':'.$raw, $secret);
    foreach ($sigs as $s) if (hash_equals($expected, $s)) return true;
    return false;
}
// Controller: $raw = $request->getContent();   // raw body
// bootstrap/app.php (L11): ->withMiddleware(fn ($m) => $m->validateCsrfTokens(except: ['webhooks/paddle']))
```

## Notes
- Money: minor units as `int`; use `brick/money` or `NumberFormatter` for display.
- Downloads: `Storage::disk('s3')->temporaryUrl($path, now()->addMinutes($ttl))`, or `Storage::download()` for a local private disk.
- Tests: Pest/PHPUnit with `Http::fake()`.
