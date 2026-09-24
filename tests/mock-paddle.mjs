// Minimal in-memory Paddle API used to test paddle-sync.mjs / paddle_sync.py
// without touching a real account. Implements only what the scripts call.
//
//   node tests/mock-paddle.mjs <port> [state.json]
//   GET  /__state          dump state      POST /__seed   replace state
//   GET  /__log            request log     POST /__reset  clear everything
import http from "node:http";

const port = Number(process.argv[2] || 8787);
let state, log, seq;
const reset = () => { state = { products: [], prices: [], discounts: [], "notification-settings": [], subscriptions: [] }; log = []; seq = 0; };
reset();
const PREFIX = { products: "pro", prices: "pri", discounts: "dsc", "notification-settings": "ntfset", subscriptions: "sub" };
const newId = (res) => `${PREFIX[res]}_${String(++seq).padStart(26, "0")}`;
const now = () => new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString();

function send(res, status, body) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }
const err = (res, status, code, detail) => send(res, status, { error: { type: "request_error", code, detail }, meta: { request_id: "req_mock" } });

http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const url = new URL(req.url, `http://localhost:${port}`);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "__state") return send(res, 200, state);
  if (parts[0] === "__log") return send(res, 200, log);
  if (parts[0] === "__reset") { reset(); return send(res, 200, { ok: true }); }
  if (parts[0] === "__seed") { state = { ...state, ...JSON.parse(raw) }; return send(res, 200, { ok: true }); }

  if (!/^Bearer pdl_(sdbx|live)_apikey_/.test(req.headers.authorization || "")) return err(res, 403, "forbidden", "Authentication header included, but incorrectly formatted");
  if (req.headers["paddle-version"] !== "1") return err(res, 400, "bad_request", "Paddle-Version header missing");
  const body = raw ? JSON.parse(raw) : null;
  log.push({ method: req.method, path: url.pathname + url.search, body });
  const [resource, id] = parts;

  if (resource === "event-types" && req.method === "GET") return send(res, 200, { data: [{ name: "transaction.completed" }], meta: { request_id: "req_mock" } });
  if (!state[resource]) return err(res, 404, "not_found", `Unknown resource ${resource}`);
  const coll = state[resource];

  if (req.method === "GET" && !id) {
    let items = coll;
    const statuses = url.searchParams.get("status")?.split(",");
    if (statuses) items = items.filter((x) => statuses.includes(x.status));
    const priceId = url.searchParams.get("price_id");
    if (priceId) items = items.filter((x) => x.items?.some((it) => it.price.id === priceId));
    // Pagination: per_page forced to 2 so the scripts' paging is exercised.
    const perPage = 2;
    const after = url.searchParams.get("after");
    const start = after ? items.findIndex((x) => x.id === after) + 1 : 0;
    const page = items.slice(start, start + perPage);
    const hasMore = start + perPage < items.length;
    const next = new URL(url.href);
    if (page.length) next.searchParams.set("after", page[page.length - 1].id);
    if (resource === "notification-settings") return send(res, 200, { data: items, meta: { request_id: "req_mock" } });
    return send(res, 200, { data: page, meta: { request_id: "req_mock", pagination: { per_page: perPage, next: next.href, has_more: hasMore, estimated_total: items.length } } });
  }
  const found = id && coll.find((x) => x.id === id);
  if (req.method === "GET" && id) return found ? send(res, 200, { data: found }) : err(res, 404, "not_found", `${id} not found`);
  if (req.method === "POST" && !id) {
    const e = { id: newId(resource), status: "active", created_at: now(), updated_at: now(), custom_data: null, ...body };
    if (resource === "notification-settings") { e.endpoint_secret_key = `pdl_ntfset_${e.id}_secret`; e.active = true; e.subscribed_events = body.subscribed_events.map((name) => ({ name })); }
    if (resource === "discounts") e.times_used = 0;
    coll.push(e);
    return send(res, 201, { data: e });
  }
  if (req.method === "PATCH" && id) {
    if (!found) return err(res, 404, "not_found", `${id} not found`);
    if (resource === "subscriptions" && body.items) {
      found.items = body.items.map((it) => ({ price: state.prices.find((p) => p.id === it.price_id) || { id: it.price_id }, quantity: it.quantity }));
      found.last_proration = body.proration_billing_mode;
    } else if (resource === "notification-settings" && body.subscribed_events) {
      Object.assign(found, body, { subscribed_events: body.subscribed_events.map((name) => ({ name })) });
    } else Object.assign(found, body);
    found.updated_at = now();
    return send(res, 200, { data: found });
  }
  return err(res, 405, "method_not_allowed", req.method);
}).listen(port, () => console.log(`mock paddle on :${port}`));
