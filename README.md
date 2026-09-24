# paddle-billing-skills

Claude Code plugin marketplace with one plugin, **paddle-billing**: standardised Paddle
Billing integrations for SaaS subscriptions, digital goods and ebooks. It has one contract
for every stack, sync scripts in Node and Python, and promo-code sync.

- **Read [GUIDE.md](GUIDE.md)** for installation and usage.
- Contract: `plugins/paddle-billing/skills/paddle-core/references/contract.md`
- Tests: `node tests/run-tests.mjs` (both sync scripts against a mock Paddle API; outputs must match)

```bash
claude plugin marketplace add ~/Developments/paddle-billing-skills
claude plugin install paddle-billing@paddle-billing-skills
```
