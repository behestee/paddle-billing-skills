# Stack: Java + Spring Boot

- Java ≥ 17, Spring Boot ≥ 3. HTTP via `java.net.http.HttpClient` (or `RestClient`), Jackson
  with `PropertyNamingStrategies.SNAKE_CASE` **only** on the DTOs that talk to Paddle. There's no
  official Paddle Java SDK, which suits the contract.
- Migrations: Flyway (`V1__billing.sql` with the canonical DDL) or Liquibase.
- Scheduling: `@EnableScheduling` + `@Scheduled(fixedDelayString = "${billing.reconcile-ms:21600000}", initialDelay = 60000)`.
  Use ShedLock when there are several instances.

## Layout
```
src/main/java/<pkg>/billing/
  BillingConfig.java PaddleClient.java PaddleApiException.java Catalog.java CatalogSync.java
  Customers.java Discounts.java Checkout.java Webhooks.java Subscriptions.java Teams.java
  Purchases.java Refunds.java Reconciliation.java Audit.java
  web/BillingController.java StoreController.java AdminBillingController.java PaddleWebhookController.java
src/main/resources/db/migration/V1__billing.sql
scripts/paddle-sync.mjs or scripts/paddle_sync.py
```

## PaddleClient.java (essentials)
```java
public final class PaddleClient {
  private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
  private final ObjectMapper om; private final String base; private final String apiKey;
  public PaddleClient(ObjectMapper om, BillingConfig cfg) {
    this.om = om; this.apiKey = cfg.apiKey();
    this.base = "production".equals(cfg.env()) ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
  }
  private JsonNode request(String method, String pathOrUrl, Object body) throws IOException, InterruptedException {
    String url = pathOrUrl.startsWith("http") ? pathOrUrl : base + pathOrUrl;
    for (int attempt = 0; ; attempt++) {
      var b = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(15))
          .header("Authorization", "Bearer " + apiKey).header("Content-Type", "application/json").header("Paddle-Version", "1")
          .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(om.writeValueAsString(body)));
      HttpResponse<String> res;
      try { res = http.send(b.build(), HttpResponse.BodyHandlers.ofString()); }
      catch (IOException e) { if (attempt < 3) { Thread.sleep((long) (500 * Math.pow(2, attempt))); continue; } throw e; }
      JsonNode json = res.body().isBlank() ? om.createObjectNode() : om.readTree(res.body());
      int s = res.statusCode();
      if (s >= 200 && s < 300) return json;
      if ((s == 429 || s >= 500) && attempt < 3) {
        long ra = res.headers().firstValue("retry-after").map(Long::parseLong).orElse(0L);
        Thread.sleep(ra > 0 ? ra * 1000 : (long) (500 * Math.pow(2, attempt))); continue;
      }
      throw new PaddleApiException(s, json);   // keeps code, detail, request_id
    }
  }
  public JsonNode get(String p) throws Exception { return request("GET", p, null).get("data"); }
  public JsonNode post(String p, Object b) throws Exception { return request("POST", p, b).get("data"); }
  public JsonNode patch(String p, Object b) throws Exception { return request("PATCH", p, b).get("data"); }
  public List<JsonNode> list(String p) throws Exception {
    var out = new ArrayList<JsonNode>(); String next = p;
    while (next != null) { JsonNode j = request("GET", next, null); j.get("data").forEach(out::add);
      JsonNode pg = j.path("meta").path("pagination"); next = pg.path("has_more").asBoolean(false) ? pg.path("next").asText() : null; }
    return out;
  }
}
```
Serialize request bodies with `JsonInclude.Include.ALWAYS`, because explicit `null`s matter
(for example `"restrict_to": null` clears a restriction).

## Webhook
```java
@PostMapping(value = "/webhooks/paddle", consumes = MediaType.ALL_VALUE)
public ResponseEntity<String> webhook(@RequestBody byte[] raw, @RequestHeader(value = "Paddle-Signature", required = false) String sig) {
  if (!Signature.verify(raw, sig, cfg.webhookSecret(), cfg.webhookToleranceSec(), Instant.now().getEpochSecond()))
    return ResponseEntity.badRequest().body("bad signature");
  return webhooks.handle(om.readTree(raw));      // 200 / 500
}

static boolean verify(byte[] raw, String header, String secret, long tol, long now) throws Exception {
  if (header == null || secret == null || secret.isEmpty()) return false;
  String ts = null; var sigs = new ArrayList<String>();
  for (String part : header.split(";")) { String[] kv = part.split("=", 2); if (kv.length < 2) continue;
    if (kv[0].equals("ts")) ts = kv[1]; else if (kv[0].equals("h1")) sigs.add(kv[1]); }
  if (ts == null || sigs.isEmpty() || Math.abs(now - Long.parseLong(ts)) > tol) return false;
  Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(secret.getBytes(UTF_8), "HmacSHA256"));
  mac.update((ts + ":").getBytes(UTF_8)); byte[] expected = mac.doFinal(raw);
  for (String s : sigs) { byte[] got; try { got = HexFormat.of().parseHex(s); } catch (IllegalArgumentException e) { continue; }
    if (MessageDigest.isEqual(expected, got)) return true; }
  return false;
}
```
Spring Security: `permitAll()` and CSRF-ignore for `/webhooks/paddle` and `/d/**`.

## Notes
- Money: `long` minor units; `BigDecimal` for conversion; `NumberFormat.getCurrencyInstance` for display.
- JSONB: `@JdbcTypeCode(SqlTypes.JSON)` (Hibernate 6) or `String` columns.
- Tests: JUnit 5 + WireMock (or the plugin's mock server).
