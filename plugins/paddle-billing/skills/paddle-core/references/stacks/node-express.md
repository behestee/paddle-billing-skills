# Stack: Node.js + Express (also Fastify / Koa / NestJS by analogy)

Reference stack: the approved Slaxify implementation was Express.

- Node ≥ 18 (global `fetch`, `crypto`). ESM (`"type": "module"`) or TypeScript.
- No Paddle SDK (contract §1). DB: whatever the project uses (pg / mysql2 / better-sqlite3 / Prisma / Drizzle / Knex).
- Scheduling: `setInterval` in-process for one instance, or `node-cron` / BullMQ with several instances.

## Layout
```
src/billing/
  config.js  paddleClient.js  catalog.js  catalogSync.js  customers.js  discounts.js
  checkout.js  webhooks.js  subscriptions.js  teams.js  purchases.js  refunds.js
  reconciliation.js  audit.js  routes.js
scripts/paddle-sync.mjs        # copied unmodified from the plugin
paddle.catalog.json
```

## paddleClient.js
```js
import { config } from "./config.js";
export class PaddleApiError extends Error {
  constructor(status, body) {
    const e = body?.error ?? {};
    super(`${status} ${e.code ?? ""}: ${e.detail ?? "request failed"} (request_id ${body?.meta?.request_id ?? "?"})`);
    Object.assign(this, { status, code: e.code, detail: e.detail, requestId: body?.meta?.request_id, errors: e.errors });
  }
}
export const isNotFound = (e) => e instanceof PaddleApiError && (e.code === "not_found" || e.status === 404);
const BASE = config.paddleEnv === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, pathOrUrl, body) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : BASE + pathOrUrl;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method, signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${config.paddleApiKey}`, "Content-Type": "application/json", "Paddle-Version": "1" },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (attempt < 3) { await sleep(500 * 2 ** attempt); continue; }
      throw e;
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
      continue;
    }
    throw new PaddleApiError(res.status, json);
  }
}
export const paddle = {
  get: async (p) => (await request("GET", p)).data,
  post: async (p, b) => (await request("POST", p, b)).data,
  patch: async (p, b) => (await request("PATCH", p, b)).data,
  async list(p) {
    const out = []; let next = p;
    while (next) { const j = await request("GET", next); out.push(...j.data); next = j.meta?.pagination?.has_more ? j.meta.pagination.next : null; }
    return out;
  },
};
```

## Webhook (raw body; mount BEFORE `express.json()`)
```js
import crypto from "node:crypto";
export function verifyPaddleSignature(rawBody, header, secret, toleranceSec = 5, nowSec = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = header.split(";").map((p) => p.split("="));
  const ts = parts.find(([k]) => k === "ts")?.[1];
  const sigs = parts.filter(([k]) => k === "h1").map(([, v]) => v);
  if (!ts || !sigs.length || Math.abs(nowSec - Number(ts)) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}:`).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  return sigs.some((s) => { const b = Buffer.from(s, "hex"); return b.length === a.length && crypto.timingSafeEqual(a, b); });
}
app.post("/webhooks/paddle", express.raw({ type: "*/*" }), handlePaddleWebhook);   // req.body is a Buffer
app.use(express.json());
```

## Notes
- NestJS: `NestFactory.create(AppModule, { rawBody: true })`, then read `req.rawBody` in the controller.
- Fastify: `addContentTypeParser('application/json', { parseAs: 'buffer' }, …)` scoped to the webhook route.
- Money: `BigInt`-safe string maths (reuse `toMinor` from the sync script).
- Tests: `node:test` or vitest, with `fetch` mocked (or the plugin's `tests/mock-paddle.mjs`).
