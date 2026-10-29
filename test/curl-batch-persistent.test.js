import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { CurlJsonBatchClient } from "../src/curl-batch-http.js";

const installed = existsSync(new URL("../.venv/bin/python", import.meta.url));
async function fixture(handler) {
  const server = createServer(handler);
  server.keepAliveTimeout = 10000;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}
const jobs = (url, count = 1, prefix = "quote") => Array.from({ length: count }, (_, i) => ({ id: String(i), url: `${url}/${prefix}/${i}` }));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
async function waitFor(predicate, message) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message);
    await delay(10);
  }
}

test("two full persistent batches reuse one Python process and one connection with fresh responses", { skip: !installed }, async () => {
  const ports = new Set(), paths = [];
  let revision = 0;
  const server = await fixture((req, res) => {
    ports.add(req.socket.remotePort); paths.push(req.url);
    res.end(JSON.stringify({ path: req.url, revision: ++revision, region: req.headers["x-region"] }));
  });
  const client = new CurlJsonBatchClient();
  try {
    const first = await client.fetch(jobs(server.url, 7), { headers: { "x-region": "ON" } });
    const pid = client.pid;
    assert.ok(Number.isInteger(pid) && pid > 0 && alive(pid));
    await delay(25);
    const second = await client.fetch(jobs(server.url, 7), { headers: { "x-region": "ON" } });
    assert.equal(client.pid, pid);
    assert.equal(ports.size, 1);
    assert.equal(paths.length, 14);
    assert.deepEqual(first.map(r => r.data.revision), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(second.map(r => r.data.revision), [8, 9, 10, 11, 12, 13, 14]);
    assert.ok(second[0].receivedAt >= first.at(-1).receivedAt);
    for (const [i, response] of second.entries()) {
      assert.equal(response.id, String(i));
      assert.equal(response.data.region, "ON");
      assert.ok(response.decodedBytes > 0 && response.durationMs >= 0);
    }
    client.close();
    await waitFor(() => !alive(pid), "closed persistent process should exit");
  } finally { client.close(); await server.close(); }
});

test("cancellation kills the active process and a later batch starts cleanly without old data", { skip: !installed }, async () => {
  const paths = [], slowStarted = Promise.withResolvers();
  const server = await fixture((req, res) => {
    paths.push(req.url);
    if (req.url === "/slow/0") { slowStarted.resolve(); return; }
    res.end(JSON.stringify({ path: req.url }));
  });
  const client = new CurlJsonBatchClient();
  try {
    const controller = new AbortController();
    const pending = client.fetch([...jobs(server.url, 1, "slow"), { id: "later", url: `${server.url}/must-not-run` }], { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await slowStarted.promise;
    const retiredPid = client.pid;
    controller.abort(); await rejected;
    const next = await client.fetch(jobs(server.url, 1, "fresh"));
    assert.notEqual(client.pid, retiredPid);
    assert.deepEqual(next[0].data, { path: "/fresh/0" });
    assert.deepEqual(paths, ["/slow/0", "/fresh/0"]);
    await waitFor(() => !alive(retiredPid), "canceled process should not survive a replacement");
  } finally { client.close(); await server.close(); }
});

test("a second in-flight batch is rejected without sending extra source traffic", { skip: !installed }, async () => {
  const paths = [], slowStarted = Promise.withResolvers();
  const server = await fixture((req, res) => { paths.push(req.url); slowStarted.resolve(); });
  const client = new CurlJsonBatchClient();
  try {
    const controller = new AbortController();
    const first = client.fetch(jobs(server.url, 1, "first"), { signal: controller.signal });
    const aborted = assert.rejects(first, { name: "AbortError" });
    await slowStarted.promise;
    await assert.rejects(client.fetch(jobs(server.url, 1, "second")), /in.flight|active|busy/i);
    assert.deepEqual(paths, ["/first/0"]);
    controller.abort(); await aborted;
  } finally { client.close(); await server.close(); }
});

test("idle cleanup releases the process and the next batch can restart it", { skip: !installed }, async () => {
  const ports = new Set();
  const server = await fixture((req, res) => { ports.add(req.socket.remotePort); res.end('{"ok":true}'); });
  const client = new CurlJsonBatchClient({ idleTimeoutMs: 100 });
  try {
    await client.fetch(jobs(server.url));
    const originalPid = client.pid;
    await waitFor(() => !alive(originalPid), "idle persistent process should exit");
    assert.ok(!client.pid);
    const next = await client.fetch(jobs(server.url));
    assert.deepEqual(next[0].data, { ok: true });
    assert.notEqual(client.pid, originalPid);
    assert.equal(ports.size, 2);
  } finally { client.close(); await server.close(); }
});

test("close aborts active work, is idempotent, and prevents any future restart", { skip: !installed }, async () => {
  const paths = [], started = Promise.withResolvers();
  const server = await fixture(req => { paths.push(req.url); started.resolve(); });
  const client = new CurlJsonBatchClient();
  try {
    const pending = client.fetch(jobs(server.url));
    const rejected = assert.rejects(pending, error => error.name === "AbortError" || /closed/i.test(error.message));
    await started.promise;
    const pid = client.pid;
    client.close(); client.close(); await rejected;
    await waitFor(() => !alive(pid), "close should terminate an active process");
    await assert.rejects(client.fetch(jobs(server.url, 1, "after-close")), /closed/i);
    assert.deepEqual(paths, ["/quote/0"]);
  } finally { client.close(); await server.close(); }
});

test("the batch deadline kills a hung process and permits a clean subsequent batch", { skip: !installed, timeout: 10000 }, async () => {
  const paths = [], slowStarted = Promise.withResolvers();
  const server = await fixture((req, res) => {
    paths.push(req.url);
    if (req.url === "/slow/0") { slowStarted.resolve(); return; }
    res.end('{"ok":true}');
  });
  const client = new CurlJsonBatchClient({ batchTimeoutMs: 1000 });
  try {
    await client.fetch(jobs(server.url));
    const originalPid = client.pid, began = performance.now();
    const pending = client.fetch(jobs(server.url, 1, "slow"));
    const rejected = assert.rejects(pending, /timeout|deadline|timed out/i);
    await slowStarted.promise; await rejected;
    assert.ok(performance.now() - began < 3000);
    const next = await client.fetch(jobs(server.url, 1, "recovered"));
    assert.deepEqual(next[0].data, { ok: true });
    assert.notEqual(client.pid, originalPid);
    await waitFor(() => !alive(originalPid), "timed-out process should exit");
    assert.deepEqual(paths, ["/quote/0", "/slow/0", "/recovered/0"]);
  } finally { client.close(); await server.close(); }
});

test("a rate-limited batch remains atomic and the valid session is reusable afterward", { skip: !installed }, async () => {
  const paths = [];
  const server = await fixture((req, res) => {
    paths.push(req.url);
    if (req.url === "/limited") return res.writeHead(429, { "Retry-After": "7" }).end();
    res.end('{"ok":true}');
  });
  const client = new CurlJsonBatchClient();
  try {
    await client.fetch(jobs(server.url)); const pid = client.pid;
    await assert.rejects(client.fetch([{ id: "one", url: `${server.url}/before-limit` }, { id: "rate", url: `${server.url}/limited` },
      { id: "never", url: `${server.url}/after-limit` }]), error => error.status === 429 && error.retryAfterMs === 7000);
    assert.equal(client.pid, pid);
    // This local fixture tests transport recovery. Production scheduling owns
    // and honors the returned Retry-After deadline before issuing another batch.
    const next = await client.fetch(jobs(server.url, 1, "recovered"));
    assert.equal(client.pid, pid); assert.deepEqual(next[0].data, { ok: true });
    assert.deepEqual(paths, ["/quote/0", "/before-limit", "/limited", "/recovered/0"]);
  } finally { client.close(); await server.close(); }
});

test("an unexpected child exit cannot leave a permanent in-flight lock", { skip: !installed }, async () => {
  const slowStarted = Promise.withResolvers();
  const server = await fixture((req, res) => { if (req.url === "/slow/0") slowStarted.resolve(); else res.end('{"ok":true}'); });
  const client = new CurlJsonBatchClient();
  try {
    const pending = client.fetch(jobs(server.url, 1, "slow"));
    const rejected = assert.rejects(pending, /exit|closed|disconnect|transport/i);
    await slowStarted.promise; const pid = client.pid;
    process.kill(pid, "SIGKILL"); await rejected;
    const next = await client.fetch(jobs(server.url, 1, "fresh"));
    assert.deepEqual(next[0].data, { ok: true }); assert.notEqual(client.pid, pid);
  } finally { client.close(); await server.close(); }
});
