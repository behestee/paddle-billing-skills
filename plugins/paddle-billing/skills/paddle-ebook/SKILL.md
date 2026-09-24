---
name: paddle-ebook
description: Build or extend Paddle Billing sales of PDF ebooks under Paddle's dedicated "ebooks" tax category (reduced VAT/GST in many regions; requires Paddle's category approval after a site review) in any stack (Node/Express, Next.js, FastAPI, Laravel, Spring, GeneXus), following the shared paddle-billing contract — server-created checkout, guest or logged-in readers, secure expiring PDF downloads with limits, optional buyer-stamped PDFs, sample chapters, promo codes synced app→Paddle, refunds that revoke access, webhooks and reconciliation. Use when the user sells ebooks/PDF books and wants the ebook tax treatment; to sell PDFs immediately without that approval, use paddle-digital-goods instead.
---

# paddle-ebook

A specialisation of `paddle-digital-goods`. The purchase, download and refund flow is the
same, but products use `kind: "ebook"` and `taxCategory: "ebooks"`, fulfilment is
**PDF files only**, and there are extra steps for Paddle's category approval.

## Step 0 — Load (mandatory)

Read `../paddle-core/SKILL.md`, `../paddle-core/references/contract.md`,
`../paddle-core/references/pitfalls.md`, `../paddle-core/references/one-time-purchases.md`,
`../paddle-digital-goods/SKILL.md` (you'll follow its steps), and
`references/ebook-specifics.md` (this skill).

## Step 1 — Decide the tax route first (the one ebook-specific decision)

If the catalog doesn't already record it (products with `kind: "ebook"` = decided), ask
this **as part of** the single question call from `paddle-digital-goods` Step 2:

> "Sell under Paddle's **ebooks** tax category (lower tax in many countries; Paddle must
> approve it after reviewing your site, which takes a while), or start selling now as
> **digital goods** (`standard` category, no approval)?"
> Recommended: *ebooks category, and keep `standard` until approved*. See ebook-specifics.md §1.

- ebooks category → continue with this skill (`kind: "ebook"`).
- digital goods → switch to `paddle-digital-goods` and model the books as
  `kind: "digital_good"`, `fulfillment.type: "file"`. You can move to this skill later: change
  `kind` to `ebook` and sync. It's a non-money change, so prices and buyers are untouched.

## Step 2 — Remaining questions

Use `paddle-digital-goods` Step 2's budget, plus at most one ebook-specific question if not already recorded:

| Ask only if | Question | Recommended |
|---|---|---|
| no catalog | Stamp each PDF with the buyer's email (a "licensed to" footer)? | yes, a light footer (deters sharing, no DRM hassle) |

## Step 3 onward

Follow `paddle-digital-goods` Steps 3–6 with:
- the template `../paddle-core/templates/paddle.catalog.ebook.json`; `skills` includes `"ebook"`;
- every ebook product: `kind: "ebook"`, `fulfillment.type: "file"`, at least one `.pdf`
  (the sync scripts refuse otherwise); EPUB/MOBI may be extra files in the same product;
- the extras in `references/ebook-specifics.md`: stamping (if chosen), sample chapter
  endpoint, book page requirements for approval, `Content-Type: application/pdf`.

Tests: everything from `paddle-digital-goods` Step 5, plus the stamped PDF containing the
buyer email, and the public sample endpoint serving only the configured `ebookSamples` path (never a full-book file).
