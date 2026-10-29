import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fetchCurlJsonBatch } from "../src/curl-batch-http.js";

const installed = existsSync(new URL("../.venv/bin/python", import.meta.url));
const hasOpenSsl = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
async function fixture(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

test("batch input is bounded, uniquely identified and TLS-only outside loopback", async () => {
  await assert.rejects(fetchCurlJsonBatch([]), /1–7/);
  await assert.rejects(fetchCurlJsonBatch(Array.from({ length: 8 }, (_, i) => ({ id: String(i), url: "https://example.com" }))), /1–7/);
  await assert.rejects(fetchCurlJsonBatch([{ id: "x", url: "https://example.com" }, { id: "x", url: "https://example.com/other" }]), /unique/);
  await assert.rejects(fetchCurlJsonBatch([{ id: "x", url: "http://example.com" }]), /HTTPS/);
  await assert.rejects(fetchCurlJsonBatch([{ id: "x", url: "https://user:password@example.com" }]), /HTTPS/);
});

test("seven sequential responses reuse one connection and preserve individual receipt times", { skip: !installed }, async () => {
  const ports = new Set(), seen = [];
  let active = 0, maxActive = 0;
  const server = await fixture((req, res) => {
    ports.add(req.socket.remotePort); seen.push(req.url); active++; maxActive = Math.max(active, maxActive);
    setTimeout(() => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ path: req.url, header: req.headers["x-test"], unicode: "−115" })); active--;
    }, 20);
  });
  try {
    const start = Date.now(), jobs = Array.from({ length: 7 }, (_, i) => ({ id: String(i), url: `${server.url}/${i}` }));
    const results = await fetchCurlJsonBatch(jobs, { headers: { "x-test": "Ontario" } });
    assert.deepEqual(seen, Array.from({ length: 7 }, (_, i) => `/${i}`));
    assert.equal(maxActive, 1); assert.equal(ports.size, 1);
    assert.deepEqual(results.map(r => r.id), jobs.map(j => j.id));
    for (let i = 0; i < results.length; i++) {
      assert.deepEqual(results[i].data, { path: `/${i}`, header: "Ontario", unicode: "−115" });
      assert.ok(results[i].receivedAt >= (results[i - 1]?.receivedAt ?? start));
      assert.ok(results[i].receivedAt <= Date.now());
      assert.ok(results[i].durationMs >= 10);
      assert.equal(results[i].decodedBytes, Buffer.byteLength(JSON.stringify(results[i].data)));
    }
    assert.ok(results.at(-1).receivedAt - results[0].receivedAt >= 100);
  } finally { await server.close(); }
});

test("HTTP 429 stops the batch before later categories and preserves Retry-After", { skip: !installed }, async () => {
  const paths = [];
  const server = await fixture((req, res) => {
    paths.push(req.url);
    if (req.url === "/rate") return res.writeHead(429, { "Retry-After": "7" }).end();
    res.end('{"valid":true}');
  });
  try {
    await assert.rejects(fetchCurlJsonBatch(["first", "rate", "must-not-fetch"].map(id => ({ id, url: `${server.url}/${id}` }))),
      error => error.status === 429 && error.retryAfterMs === 7000);
    assert.deepEqual(paths, ["/first", "/rate"]);
  } finally { await server.close(); }
});

test("redirects cannot change the requested source endpoint", { skip: !installed }, async () => {
  const paths = [];
  const server = await fixture((req, res) => { paths.push(req.url); res.writeHead(302, { Location: "/redirect-target" }).end(); });
  try {
    await assert.rejects(fetchCurlJsonBatch([{ id: "one", url: `${server.url}/initial` }]), error => error.status === 302);
    assert.deepEqual(paths, ["/initial"]);
  } finally { await server.close(); }
});

test("malformed JSON fails the whole batch and avoids later requests", { skip: !installed }, async () => {
  const paths = [];
  const server = await fixture((req, res) => { paths.push(req.url); res.end(req.url === "/bad" ? "<html>Error</html>" : '{"ok":true}'); });
  try {
    await assert.rejects(fetchCurlJsonBatch(["ok", "bad", "later"].map(id => ({ id, url: `${server.url}/${id}` }))), /invalid JSON/);
    assert.deepEqual(paths, ["/ok", "/bad"]);
  } finally { await server.close(); }
});

test("aggregate response budget bounds combined category memory", { skip: !installed }, async () => {
  const paths = [];
  const body = JSON.stringify({ text: "x".repeat(5 * 1024 * 1024) });
  const server = await fixture((req, res) => { paths.push(req.url); res.end(body); });
  try {
    await assert.rejects(fetchCurlJsonBatch(["first", "second", "later"].map(id => ({ id, url: `${server.url}/${id}` }))), /8 MiB limit/);
    assert.deepEqual(paths, ["/first", "/second"]);
  } finally { await server.close(); }
});

test("an oversized single category is rejected without publishing prior categories", { skip: !installed }, async () => {
  const server = await fixture((req, res) => res.end('"' + "x".repeat(8 * 1024 * 1024) + '"'));
  try {
    await assert.rejects(fetchCurlJsonBatch([{ id: "large", url: server.url }]), /8 MiB limit/);
  } finally { await server.close(); }
});

test("cancellation kills an in-progress batch and suppresses remaining categories", { skip: !installed }, async () => {
  const paths = [], requested = Promise.withResolvers();
  const server = await fixture((req, res) => { paths.push(req.url); if (req.url === "/slow") requested.resolve(); else res.end('{"ok":true}'); });
  try {
    const controller = new AbortController();
    const promise = fetchCurlJsonBatch(["first", "slow", "later"].map(id => ({ id, url: `${server.url}/${id}` })), { signal: controller.signal });
    await requested.promise; controller.abort();
    await assert.rejects(promise, { name: "AbortError" });
    assert.deepEqual(paths, ["/first", "/slow"]);
    const canceled = new AbortController(); canceled.abort();
    await assert.rejects(fetchCurlJsonBatch([{ id: "canceled", url: server.url }], { signal: canceled.signal }), { name: "AbortError" });
    assert.deepEqual(paths, ["/first", "/slow"]);
  } finally { await server.close(); }
});

test("TLS verification rejects an untrusted self-signed source certificate", { skip: !installed || !hasOpenSsl }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "extras-tls-test-"));
  let server, reached = false;
  try {
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"),
      "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { timeout: 10000 });
    server = createHttpsServer({ key: await readFile(join(dir, "key.pem")), cert: await readFile(join(dir, "cert.pem")) },
      (req, res) => { reached = true; res.end('{"ok":true}'); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    await assert.rejects(fetchCurlJsonBatch([{ id: "tls", url: `https://127.0.0.1:${server.address().port}` }]), /SSL|certificate/i);
    assert.equal(reached, false);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hung source hits the per-request timeout and later categories are not requested", { skip: !installed, timeout: 15000 }, async () => {
  const paths = [], server = await fixture(req => { paths.push(req.url); });
  try {
    const began = performance.now();
    await assert.rejects(fetchCurlJsonBatch([{ id: "slow", url: `${server.url}/slow` }, { id: "later", url: `${server.url}/later` }]), /timeout|timed out/i);
    assert.ok(performance.now() - began < 13000);
    assert.deepEqual(paths, ["/slow"]);
  } finally { await server.close(); }
});
