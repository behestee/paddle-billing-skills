# Ebook specifics (contract v1)

## 1. Tax category approval

- Paddle enables only `standard` by default. `ebooks` (defined by Paddle as "digital books
  and educational material sold with permanent rights for use by the buyer") must be
  requested: **Paddle Dashboard → Catalog → Products → (a product) → Tax category → "Get
  approval for new category"**, choosing an example product. Paddle then reviews your site.
- Until approved, sync still works: the catalog says `ebooks`, and Paddle rejects the product
  create/update if the category isn't enabled. If `paddle-sync` fails with a tax-category
  error, temporarily set `"taxCategory": "standard"` on the ebook products, sync, and
  switch back after approval (a non-money change, no price replacement).
- Sandbox: enable the category in the sandbox dashboard too, or test with `standard`.

What reviewers look for (make the site ready **before** requesting):
- a product page per book: title, author, format (PDF), page count, a table of contents
  or description, a cover image, the price, and what the buyer receives (lifetime download,
  number of downloads);
- clear seller identity/contact, terms, a refund policy consistent with Paddle's buyer
  terms, a privacy policy;
- a working checkout on the approved domain (the Default payment link page).

## 2. Catalog extras

Ebooks use the normal product schema. Recommended fields:

```jsonc
{
  "key": "ebook_rust_guide",
  "kind": "ebook",
  "name": "The Practical Rust Guide (PDF)",
  "description": "320 pages · PDF + EPUB · edition 3",
  "imageUrl": "https://…/cover.png",
  "features": ["320 pages", "PDF + EPUB", "Free updates within edition 3"],
  "fulfillment": {
    "type": "file",
    "files": [ { "path": "ebooks/rust-guide-ed3.pdf", "label": "PDF" },
               { "path": "ebooks/rust-guide-ed3.epub", "label": "EPUB" } ],
    "maxDownloads": 5,
    "linkTtlMinutes": 30
  },
  "prices": [ { "key": "ebook_rust_guide_std", "amount": "24.00" } ]
}
```

Sample chapters are app-side configuration (not sent to Paddle). Keep them in the app's
own config, keyed by product key: `ebookSamples: { ebook_rust_guide: "ebooks/rust-guide-sample.pdf" }`,
served publicly by `GET /api/store/products/:key/sample` (302 to a presigned URL, or streamed
from local storage). Never reuse a full-book path as a sample.

## 3. Buyer-stamped PDFs (when chosen)

At download time (not at purchase), produce a stamped copy and cache it per entitlement
(`stamped/<entitlement_id>/<file>.pdf` in private storage), then serve that copy:

- Footer on every page, 7 pt grey: `Licensed to <email> · Order <txn_id>`; PDF metadata
  `Subject` set to the same string.
- Libraries: Node `pdf-lib`; Python `pypdf` + `reportlab` (overlay); PHP `setasign/fpdi`;
  Java `Apache PDFBox`. GeneXus: an external object around PDFBox.
- Stamping failure → log it and serve the unstamped original (never block a paying reader).
  Audit `download_issued` with `detail.stamped=false`.
- EPUB is not stamped (just served).

## 4. Delivery details

- `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="<Title> - <label>.pdf"`.
- Purchase email: the title, cover, a "Read now" library link, and guest download links (30-day tokens).
- Edition updates: new file path, sync, then optionally email existing buyers
  ("edition 3.1 is available in your library"). That's an app extension: query
  `billing_entitlements` by `product_key`.
