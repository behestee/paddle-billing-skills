# Frontend: Paddle.js (contract v1)

The same flow in vanilla JS, React, Next.js, Angular, Blade, Thymeleaf and GeneXus web panels:

1. Load Paddle.js v2 **once**: `<script src="https://cdn.paddle.com/paddle/v2/paddle.js">`
   or the npm wrapper `@paddle/paddle-js` (`initializePaddle`). Don't use both.
2. `Paddle.Initialize()` **exactly once per page load** (a second call is invalid). Later
   changes go through `Paddle.Update()`.
3. Sandbox: call `Paddle.Environment.set("sandbox")` **before** Initialize, only when
   `env !== "production"`. Never set production explicitly (it's the default).
4. Checkout: ask **your backend** for a transaction, then open it:
   ```js
   const r = await api.post("/api/billing/checkout", { priceKey, discountCode });   // or /api/store/checkout
   Paddle.Checkout.open({
     transactionId: r.transactionId,
     settings: {
       displayMode: CATALOG.checkout.displayMode,        // "overlay" | "inline"
       theme: CATALOG.checkout.theme,
       showAddDiscounts: CATALOG.checkout.allowDiscountEntry,
       allowLogout: false,                               // customer identity comes from us
       successUrl: `${location.origin}${CATALOG.checkout.successPath}?txn=${r.transactionId}`,
     },
     // guests only: customer: { email }
   });
   ```
   Never pass `items`, `priceId`, `customData` or `discountId` from the browser.
5. `eventCallback`: on `checkout.completed`, go to `successPath?txn=<id>`. The success
   page **polls** `GET /api/billing/status` (subscriptions) or `GET /api/store/purchases`
   (one-time) every 2 s for up to 60 s until the webhook has landed. After that it shows
   "Payment received. Activation can take a minute; we'll email you", with a
   "paid but not activated" support link.
6. Retain / pwCustomer (optional, subscriptions): if the user has a `ctm_` id, pass
   `pwCustomer: { id }` at Initialize or via `Paddle.Update`. Customer ids only, never emails.

## Shared module: `paddle-client.(js|ts)`

Same file in every JS frontend; wrap it per framework.

```ts
let loading: Promise<any> | null = null;
let initialised = false;
let pwCustomerId: string | null = null;
let onCompleted: ((e: any) => void) | null = null;

function loadScript(): Promise<any> {
  if ((window as any).Paddle) return Promise.resolve((window as any).Paddle);
  return (loading ??= new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
    s.onload = () => res((window as any).Paddle);
    s.onerror = () => { loading = null; rej(new Error("Failed to load Paddle.js")); };
    document.head.appendChild(s);
  }));
}

export async function getPaddle(cfg: { env: string; clientToken: string; customerId?: string | null }) {
  const Paddle = await loadScript();
  if (!initialised) {
    if (cfg.env !== "production") Paddle.Environment.set("sandbox");
    Paddle.Initialize({
      token: cfg.clientToken,
      ...(cfg.customerId ? { pwCustomer: { id: cfg.customerId } } : {}),
      eventCallback: (e: any) => { if (e.name === "checkout.completed") onCompleted?.(e); },
    });
    initialised = true;
    pwCustomerId = cfg.customerId ?? null;
  } else if (cfg.customerId && cfg.customerId !== pwCustomerId) {
    Paddle.Update({ pwCustomer: { id: cfg.customerId } });
    pwCustomerId = cfg.customerId;
  }
  return Paddle;
}

export async function openCheckout(
  r: { transactionId: string; clientToken: string; env: string },
  settings: Record<string, unknown>,
  opts: { guestEmail?: string; onComplete?: (e: any) => void } = {},
) {
  onCompleted = opts.onComplete ?? ((e) => { location.href = String(settings.successUrl ?? "/"); });
  const Paddle = await getPaddle({ env: r.env, clientToken: r.clientToken });
  Paddle.Checkout.open({ transactionId: r.transactionId, settings, ...(opts.guestEmail ? { customer: { email: opts.guestEmail } } : {}) });
}
```

- **React / Next.js**: put `paddle-client.ts` in `lib/`; call it from a `"use client"`
  component's click handler. For SSR, only touch it inside `useEffect` or event handlers.
- **Angular**: wrap it in an `@Injectable({ providedIn: 'root' }) PaddleService` that
  calls the same functions. Run `openCheckout` inside `NgZone.run` for the completion
  callback so change detection fires.
- **Vanilla / Blade / Thymeleaf**: include the file as an ES module
  (`<script type="module">`).
- **GeneXus**: a User Control, or an external JS object, calling `openCheckout` with the
  values returned by the checkout REST procedure.

## Pricing page

`GET /api/billing/plans` (or `/api/store/products`) is the only data source. Show the
trial badge only when `trialEligible && price.trialDays`. For localized prices use
`Paddle.PricePreview({ items: [{ priceId, quantity: 1 }], address: { countryCode } })`.
This needs price IDs, so the plans endpoint may include `paddlePriceId` per price for
preview purposes only. The checkout still goes through the backend.
