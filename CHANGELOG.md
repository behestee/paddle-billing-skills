# Changelog

## 1.0.0 — 2026-09-24
- Contract v1: fixed decisions, env vars, catalog schema, canonical DB schema, endpoint contract.
- Skills: paddle-core, paddle-subscription, paddle-digital-goods, paddle-ebook.
- Sync scripts `paddle-sync.mjs` / `paddle_sync.py` (identical behaviour, zero dependencies):
  products, prices, one-time-per-account trial variants, discounts, webhook destination,
  price-change policy (ask / grandfather / migrate), legacy adoption, `.env` + lock file output.
- Stack references: Express, Next.js, FastAPI, Laravel, Spring Boot, GeneXus.
- Based on the Paddle-approved Slaxify (en_slack) integration and its production incidents.
