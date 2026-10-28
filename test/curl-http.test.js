import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { fetchCurlJson } from "../src/curl-http.js";
import { parseRetryAfter } from "../src/http.js";

const installed = existsSync(new URL("../.venv/bin/python", import.meta.url));

test("Retry-After rejects malformed and negative values and accepts seconds/dates", () => {
  assert.equal(parseRetryAfter("bad"), 0);
  assert.equal(parseRetryAfter("-3"), 0);
  assert.equal(parseRetryAfter("2"), 2000);
  const delay = parseRetryAfter(new Date(Date.now() + 30000).toUTCString());
  assert.ok(delay > 28000 && delay <= 30000);
});

test("optional curl transport handles actual HTTP JSON, rate limits, malformed data and cancellation", { skip: !installed }, async () => {
  const server = createServer((req, res) => {
    if (req.url === "/slow") return;
    if (req.url === "/rate-limit") return res.writeHead(429, { "Retry-After": "7" }).end();
    if (req.url === "/bad-json") return res.end("not JSON");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ events: ["one"], header: req.headers["x-test"] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await fetchCurlJson(url, { headers: { "x-test": "passed" } });
    assert.deepEqual(result.data, { events: ["one"], header: "passed" });
    assert.ok(result.durationMs > 0 && result.decodedBytes > 0 && result.receivedAt <= Date.now());
    await assert.rejects(fetchCurlJson(url + "/rate-limit"), (error) => error.status === 429 && error.retryAfterMs === 7000);
    await assert.rejects(fetchCurlJson(url + "/bad-json"), /invalid JSON/);
    const controller = new AbortController();
    const pending = fetchCurlJson(url + "/slow", { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 150);
    await assert.rejects(pending, { name: "AbortError" });
    clearTimeout(timer);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
