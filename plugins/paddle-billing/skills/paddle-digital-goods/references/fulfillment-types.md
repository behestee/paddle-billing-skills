# Fulfillment types (contract v1)

Declared per product in `fulfillment.type`. Behaviour is fixed. `one-time-purchases.md`
covers the shared checkout / fulfil / download / revoke flow.

| type | What the buyer gets | Library UI | On revoke |
|---|---|---|---|
| `file` | 1..n private files, signed downloads | "Download" per file + remaining count | links → 410 |
| `license_key` | a unique key per unit (+ optional installer files) | the key with a copy button, plus downloads if `files` is set | the key is reported invalid |
| `access` | a feature flag / role (`accessKey`) while not revoked | "Open" → the gated area | access removed |
| `external_url` | a link to an external resource (a private repo invite form, Notion page, …) | "Open" | link hidden |
| `credits` | `credits` added to the account's credit ledger, once | the balance | credits removed (may go negative; the app decides what that blocks) |

## Files

- `files[].path` is relative to the storage root (bucket or private directory).
  `label` is shown to the buyer and used for the download filename.
- New version of a file: upload under a **new path**, update the catalog, and run sync
  (a non-money change, so the price stays the same). Existing buyers get the new path
  automatically, because entitlements reference the product, not the path.
- Very large files (> 100 MB): presigned URLs only; never stream through the app server.
- Serve with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.

## License keys

- Format: `<PREFIX>-XXXX-XXXX-XXXX-XXXX`. 16 characters from the Crockford base32
  alphabet (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), from a **CSPRNG**, unique index on
  `billing_entitlements.license_key`, regenerated on collision.
- Optional verification endpoint for desktop software (extension, not contract):
  `POST /api/store/licenses/verify { key, machineId? }` → `{ valid, productKey, revoked }`,
  rate limited. Activation limits per key go in an extension table.

## Access grants

`has_access(account, accessKey)` = there's a non-revoked entitlement with that `access_key`
for the account. Gate routes and UI with this helper only. Guests must sign up (and
claim their purchase) to use access-type products, and the purchase email says so.

## Credits

Credit ledger is app-specific, but the grant must be **idempotent per entitlement**:
insert a ledger row keyed by `entitlement_id` (unique), so a replayed webhook can't grant twice.
