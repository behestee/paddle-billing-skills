# Stack: Next.js (App Router) — full-stack

The contract endpoints become **Route Handlers** with the same paths (`app/api/billing/checkout/route.ts`
→ `POST /api/billing/checkout`). Keep the HTTP contract even where a Server Action would
work: other frontends and mobile apps can then reuse it, and every project looks the same.
Server Actions may *call* the same `lib/billing/*` functions.

## Layout
```
lib/billing/        config.ts paddleClient.ts catalog.ts catalogSync.ts customers.ts discounts.ts
                    checkout.ts webhooks.ts subscriptions.ts teams.ts purchases.ts refunds.ts
                    reconciliation.ts audit.ts
lib/paddle-client.ts                     # browser module from frontend.md ("use client" callers only)
app/webhooks/paddle/route.ts             # POST, runtime = "nodejs"
app/api/billing/**/route.ts              # contract §7
app/api/store/**/route.ts
app/api/admin/billing/**/route.ts
app/billing/success/page.tsx             # polls status
app/pay/page.tsx                         # Default payment link page (loads Paddle.js)
scripts/paddle-sync.mjs
```
`paddleClient.ts` is the Node client from `node-express.md`, typed.

## Webhook route
```ts
export const runtime = "nodejs";          // node:crypto; not the edge runtime
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const raw = Buffer.from(await req.arrayBuffer());       // raw bytes; never req.json() first
  if (!verifyPaddleSignature(raw, req.headers.get("paddle-signature"), env.PADDLE_WEBHOOK_SECRET, Number(env.PADDLE_WEBHOOK_TOLERANCE_SEC ?? 5)))
    return new Response("bad signature", { status: 400 });
  return handlePaddleEvent(JSON.parse(raw.toString("utf8")));   // returns Response 200/500
}
```
(`verifyPaddleSignature` is identical to node-express.md.)

## Notes
- Middleware must not rewrite or block `/webhooks/paddle` (exclude it from auth middleware).
- Reconciliation / retry jobs: Vercel Cron → `GET /api/admin/billing/cron` protected by
  `CRON_SECRET`, or an external scheduler. There's no `setInterval` on serverless.
- Env: server-only vars never get the `NEXT_PUBLIC_` prefix. The browser receives the
  client token through `GET /api/billing/config`.
- DB: Prisma or Drizzle models named exactly after the canonical tables (`@@map("billing_subscriptions")`).
