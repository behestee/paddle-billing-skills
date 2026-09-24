// End-to-end tests for both sync scripts against tests/mock-paddle.mjs.
// Every scenario runs once with the Node script and once with the Python
// script; the resulting Paddle state and stdout must be identical.
//
//   node tests/run-tests.mjs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CORE = path.join(ROOT, "plugins/paddle-billing/skills/paddle-core");
const PORT = 18787;
const API = `http://localhost:${PORT}`;
const IMPLS = {
  node: ["node", [path.join(CORE, "scripts/paddle-sync.mjs")]],
  python: ["python3", [path.join(CORE, "scripts/paddle_sync.py")]],
};

const mock = spawn("node", [path.join(ROOT, "tests/mock-paddle.mjs"), String(PORT)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 400));
const call = async (p, body) => (await fetch(API + p, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined })).json();

function project(catalogTemplate, envExtra = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paddle-sync-test-"));
  fs.copyFileSync(path.join(CORE, "templates", catalogTemplate), path.join(dir, "paddle.catalog.json"));
  fs.writeFileSync(path.join(dir, ".env"), `# app env\nPADDLE_ENV=sandbox\nPADDLE_API_KEY=pdl_sdbx_apikey_test123\nPADDLE_CLIENT_TOKEN=test_abc\nPADDLE_WEBHOOK_URL=https://example.test/webhooks/paddle\nAPP_BASE_URL=http://localhost:3000\nDOWNLOAD_SIGNING_SECRET=x\n${envExtra}`);
  return dir;
}
function run(impl, dir, args) {
  const [cmd, base] = IMPLS[impl];
  const r = spawnSync(cmd, [...base, ...args, "--api-base", API], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const readEnv = (dir) => Object.fromEntries(fs.readFileSync(path.join(dir, ".env"), "utf8").split("\n").filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const editCatalog = (dir, fn) => { const f = path.join(dir, "paddle.catalog.json"); const c = JSON.parse(fs.readFileSync(f, "utf8")); fn(c); fs.writeFileSync(f, JSON.stringify(c, null, 2)); };
const norm = (s) => s.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<ts>").replace(/\/tmp\/[^\s)]+|\/var\/folders\/[^\s)]+/g, "<path>");
const strip = (st) => JSON.parse(JSON.stringify(st).replace(/"(created_at|updated_at)":"[^"]*"/g, '"$1":"<ts>"'));

const results = {};
let failures = 0;
async function scenario(name, fn) {
  for (const impl of Object.keys(IMPLS)) {
    await call("/__reset", {});
    try {
      const transcript = await fn(impl);
      results[name] ??= {};
      results[name][impl] = { transcript: norm(transcript || ""), state: strip(await call("/__state")) };
      console.log(`  ✔ ${name} [${impl}]`);
    } catch (e) {
      failures++;
      console.log(`  ✖ ${name} [${impl}]: ${e.message}`);
    }
  }
  const r = results[name];
  if (r?.node && r?.python) {
    try {
      assert.deepEqual(r.python.state, r.node.state, "Paddle state differs between node and python");
      assert.equal(r.python.transcript, r.node.transcript, "stdout differs between node and python");
      console.log(`  ✔ ${name} [node ≡ python]`);
    } catch (e) {
      failures++;
      console.log(`  ✖ ${name} [node ≡ python]: ${e.message.split("\n").slice(0, 30).join("\n")}`);
    }
  }
}

console.log("paddle-sync tests");

await scenario("fresh sync creates everything, re-sync is a no-op", async (impl) => {
  const dir = project("paddle.catalog.subscription.json");
  const a = run(impl, dir, []);
  assert.equal(a.code, 0, a.err);
  const st = await call("/__state");
  assert.equal(st.products.length, 3);
  assert.equal(st.prices.length, 10, "4 starter (2 + 2 trial) + 4 pro + 2 team");
  assert.equal(st.discounts.length, 2);
  assert.equal(st["notification-settings"].length, 1);
  assert.ok(st.prices.every((p) => p.custom_data.app === "myapp"));
  const trial = st.prices.find((p) => p.custom_data.app_key === "pro_monthly_trial");
  assert.deepEqual(trial.trial_period, { interval: "day", frequency: 14, requires_payment_method: true });
  assert.deepEqual(st.prices.find((p) => p.custom_data.app_key === "team_pro_monthly").quantity, { minimum: 1, maximum: 500 });
  assert.deepEqual(st.prices.find((p) => p.custom_data.app_key === "starter_monthly").quantity, { minimum: 1, maximum: 1 });
  assert.equal(st.prices.find((p) => p.custom_data.app_key === "pro_monthly").unit_price_overrides[0].unit_price.amount, "2900");
  const launch = st.discounts.find((d) => d.code === "LAUNCH50");
  assert.equal(launch.restrict_to.length, 4, "starter_monthly + trial, pro_monthly + trial");
  assert.equal(st.discounts.find((d) => d.code === "WELCOME5").amount, "500");
  const env = readEnv(dir);
  assert.match(env.PADDLE_PRICE_PRO_MONTHLY, /^pri_/);
  assert.match(env.PADDLE_PRICE_PRO_MONTHLY_TRIAL, /^pri_/);
  assert.match(env.PADDLE_DISCOUNT_LAUNCH50, /^dsc_/);
  assert.match(env.PADDLE_WEBHOOK_SECRET, /^pdl_ntfset_/);
  assert.equal(env.PADDLE_CATALOG_MODE, "fixed");
  assert.ok(fs.existsSync(path.join(dir, "paddle.sandbox.lock.json")));
  assert.ok(fs.existsSync(path.join(dir, ".env.paddle-backup")));
  const b = run(impl, dir, []);
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /No changes needed/);
  const c = run(impl, dir, ["check"]);
  assert.equal(c.code, 0, c.out + c.err);
  return a.out + b.out + c.out;
});

await scenario("price change: --yes without policy stops before changing anything; migrate moves subscribers", async (impl) => {
  const dir = project("paddle.catalog.subscription.json");
  assert.equal(run(impl, dir, []).code, 0);
  let st = await call("/__state");
  const old = st.prices.find((p) => p.custom_data.app_key === "pro_monthly");
  await call("/__seed", { subscriptions: [{ id: "sub_1", status: "active", items: [{ price: old, quantity: 1 }] }, { id: "sub_2", status: "canceled", items: [{ price: old, quantity: 1 }] }] });
  editCatalog(dir, (c) => { c.products.find((p) => p.key === "pro").prices[0].amount = "24.99"; });
  const before = (await call("/__state")).prices.length;
  const a = run(impl, dir, ["--yes"]);
  assert.equal(a.code, 2, a.out + a.err);
  assert.equal((await call("/__state")).prices.length, before, "nothing created before the decision");
  const b = run(impl, dir, ["--yes", "--price-change", "migrate"]);
  assert.equal(b.code, 0, b.err);
  st = await call("/__state");
  const active = st.prices.filter((p) => p.custom_data.app_key === "pro_monthly" && p.status === "active");
  assert.equal(active.length, 1);
  assert.equal(active[0].unit_price.amount, "2499");
  assert.equal(st.prices.find((p) => p.id === old.id).status, "archived");
  const trialNew = st.prices.find((p) => p.custom_data.app_key === "pro_monthly_trial" && p.status === "active");
  assert.equal(trialNew.unit_price.amount, "2499", "trial variant follows the base price");
  const sub1 = st.subscriptions.find((s) => s.id === "sub_1");
  assert.equal(sub1.items[0].price.id, active[0].id);
  assert.equal(sub1.last_proration, "do_not_bill");
  assert.equal(st.subscriptions.find((s) => s.id === "sub_2").items[0].price.id, old.id, "canceled subs untouched");
  const launch = st.discounts.find((d) => d.code === "LAUNCH50");
  assert.ok(launch.restrict_to.includes(active[0].id) && !launch.restrict_to.includes(old.id), "promo follows the new price");
  assert.equal(readEnv(dir).PADDLE_PRICE_PRO_MONTHLY, active[0].id);
  const lock = JSON.parse(fs.readFileSync(path.join(dir, "paddle.sandbox.lock.json"), "utf8"));
  assert.equal(lock.prices.pro_monthly.history[0].id, old.id);
  return a.out + a.err + b.out;
});

await scenario("grandfather keeps subscribers; removing a trial archives the trial price", async (impl) => {
  const dir = project("paddle.catalog.subscription.json");
  assert.equal(run(impl, dir, []).code, 0);
  const old = (await call("/__state")).prices.find((p) => p.custom_data.app_key === "starter_yearly");
  await call("/__seed", { subscriptions: [{ id: "sub_9", status: "active", items: [{ price: old, quantity: 1 }] }] });
  editCatalog(dir, (c) => { const s = c.products.find((p) => p.key === "starter"); s.prices[1].amount = "59.99"; delete s.prices[0].trialDays; });
  const a = run(impl, dir, ["--price-change", "grandfather"]);
  assert.equal(a.code, 0, a.err);
  const st = await call("/__state");
  assert.equal(st.subscriptions[0].items[0].price.id, old.id);
  assert.equal(st.prices.find((p) => p.custom_data.app_key === "starter_monthly_trial").status, "archived");
  const c = run(impl, dir, ["check"]);
  assert.equal(c.code, 0, c.out);
  return a.out + c.out;
});

await scenario("discount edits and archive", async (impl) => {
  const dir = project("paddle.catalog.subscription.json");
  assert.equal(run(impl, dir, []).code, 0);
  editCatalog(dir, (c) => { c.discounts[0].usageLimit = 500; c.discounts[0].expiresAt = "2027-01-31T00:00:00Z"; c.discounts[1].archived = true; });
  const a = run(impl, dir, []);
  assert.equal(a.code, 0, a.err);
  const st = await call("/__state");
  assert.equal(st.discounts.find((d) => d.code === "LAUNCH50").usage_limit, 500);
  assert.equal(st.discounts.find((d) => d.code === "WELCOME5").status, "archived");
  assert.match(a.out, /~ discount launch50 usage_limit, expires_at/);
  return a.out;
});

await scenario("adopts legacy entities created before the contract (e.g. en_slack)", async (impl) => {
  const dir = project("paddle.catalog.subscription.json");
  await call("/__seed", {
    products: [{ id: "pro_legacy", name: "MyApp Starter", status: "active", tax_category: "saas", description: "For individuals getting started", image_url: null, custom_data: null, created_at: "2025-01-01T00:00:00Z" }],
    prices: [{ id: "pri_legacy", product_id: "pro_legacy", status: "active", unit_price: { amount: "499", currency_code: "USD" }, billing_cycle: { interval: "month", frequency: 1 }, trial_period: null, unit_price_overrides: [], quantity: { minimum: 1, maximum: 1 }, custom_data: null, created_at: "2025-01-01T00:00:00Z" }],
  });
  const a = run(impl, dir, []);
  assert.equal(a.code, 0, a.err);
  const st = await call("/__state");
  assert.equal(st.products.filter((p) => p.name === "MyApp Starter").length, 1);
  assert.equal(st.prices.find((p) => p.id === "pri_legacy").custom_data.app_key, "starter_monthly");
  assert.equal(readEnv(dir).PADDLE_PRICE_STARTER_MONTHLY, "pri_legacy");
  assert.match(a.out, /adopting legacy product/);
  return a.out;
});

await scenario("dry run changes nothing; wrong-environment key is refused", async (impl) => {
  const dir = project("paddle.catalog.ebook.json");
  const envBefore = fs.readFileSync(path.join(dir, ".env"), "utf8");
  const a = run(impl, dir, ["plan"]);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /Dry run/);
  const st = await call("/__state");
  assert.equal(st.products.length + st.prices.length + st.discounts.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), envBefore);
  fs.writeFileSync(path.join(dir, ".env"), envBefore.replace("pdl_sdbx_apikey_", "pdl_live_apikey_"));
  const b = run(impl, dir, []);
  assert.equal(b.code, 1);
  assert.match(b.err, /LIVE key but PADDLE_ENV=sandbox/);
  return a.out + b.err;
});

await scenario("ebook + digital goods templates sync; catalog validation rejects bad input", async (impl) => {
  const dir = project("paddle.catalog.ebook.json");
  const a = run(impl, dir, []);
  assert.equal(a.code, 0, a.err);
  const st = await call("/__state");
  assert.equal(st.products[0].tax_category, "ebooks");
  assert.equal(st.prices[0].billing_cycle, null);
  assert.equal(st.prices[0].unit_price_overrides[0].unit_price.amount, "3500");
  const ns = st["notification-settings"][0].subscribed_events.map((e) => e.name);
  assert.ok(!ns.includes("subscription.created"), "one-time apps don't subscribe to subscription events");
  const dg = project("paddle.catalog.digital-goods.json");
  const b = run(impl, dg, []);
  assert.equal(b.code, 0, b.err);
  const st2 = await call("/__state");
  assert.deepEqual(st2.prices.find((p) => p.custom_data?.app_key === "desktop_app_lifetime").quantity, { minimum: 1, maximum: 20 });
  assert.equal(st2.products.find((p) => p.custom_data?.app_key === "desktop_app").tax_category, "standard");
  editCatalog(dg, (c) => { c.products[0].prices[0].amount = "39.999"; c.products[0].bogus = 1; c.discounts[0].code = "BAD-CODE"; });
  const cErr = run(impl, dg, []);
  assert.equal(cErr.code, 1);
  assert.match(cErr.err, /3 problem\(s\)/);
  return a.out + b.out + cErr.err;
});

mock.kill();
console.log(failures ? `\n${failures} failure(s)` : "\nAll tests passed.");
process.exit(failures ? 1 : 0);
