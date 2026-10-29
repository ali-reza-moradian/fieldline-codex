import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { HistoryPersistence } from "../src/history-persistence.js";
import { PriceHistory } from "../src/price-history.js";

const URL = "postgresql://test:secret-password@database.example.test/history?sslmode=require";
const BASE = 1793300000000;
const point = (at, american = -110) => ({ at, american, decimal: 1 + 100 / -american, line: -3.5 });
const checkpoint = (points = [point(BASE)]) => ({ schema: 1, series: [{
  book: "draftkings", gameId: "game", market: "spread", side: "away", period: "full_game", settlement: "including_overtime", points,
}] });
function fakeClient({ rows = [], fail, gate } = {}) {
  const client = new EventEmitter();
  Object.assign(client, { connects: 0, ends: 0, calls: [], active: 0, maxActive: 0 });
  let fetched = false;
  client.connect = async () => { client.connects++; if (gate) await gate; };
  client.query = async (sql, values) => {
    client.calls.push({ sql, values }); client.active++; client.maxActive = Math.max(client.maxActive, client.active);
    try {
      await Promise.resolve();
      if (fail?.(sql)) throw new Error(`Error connecting to ${URL}`);
      if (sql.startsWith("FETCH")) { const result = fetched ? [] : rows; fetched = true; return { rows: result }; }
      return { rows: [] };
    } finally { client.active--; }
  };
  client.end = async () => { client.ends++; };
  return client;
}
const history = () => new PriceHistory({ now: () => BASE + 1000 });

test("optional storage is memory-only when disabled and performs no network work", async () => {
  let calls = 0;
  const p = new HistoryPersistence({ history: history(), clientFactory: () => { calls++; } });
  p.start(); await p.save();
  assert.equal(calls, 0); assert.equal(p.status().state, "disabled"); assert.equal(p.status().enabled, false);
  await p.close(); assert.equal(p.status().state, "closed");
});

test("start is nonblocking, TLS stays verified, restore and save use one connection with bounded row payloads", async () => {
  const h = history(), client = fakeClient({ rows: [{ payload: JSON.stringify(checkpoint()) }] });
  let config, yields = 0;
  const p = new HistoryPersistence({ history: h, connectionString: URL, now: () => BASE + 1000,
    clientFactory: c => { config = c; return client; }, yieldControl: async () => { yields++; await Promise.resolve(); } });
  assert.equal(p.start(), p); assert.equal(client.connects, 0);
  await p.save();
  assert.equal(client.connects, 1); assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.equal(config.connectionTimeoutMillis, 5000); assert.equal(config.query_timeout, 5000);
  assert.ok(!config.connectionString.includes("sslmode=require")); assert.equal(client.maxActive, 1);
  assert.equal(p.status().state, "ready"); assert.equal(p.status().lastSavedAt, BASE + 1000);
  assert.equal(p.status().restoredSeries, 1); assert.equal(p.status().savedSeries, 1); assert.ok(yields >= 2);
  const insert = client.calls.find(c => c.sql.startsWith("INSERT"));
  assert.equal(JSON.parse(insert.values[1]).series.length, 1);
  const cursor = client.calls.find(c => c.sql.startsWith("DECLARE"));
  assert.match(cursor.sql, /payload::text/);
  assert.match(cursor.sql, /ORDER BY newest_observation_at DESC, series_key LIMIT 1024/);
  assert.match(cursor.sql, /retained ORDER BY newest_observation_at ASC, series_key/);
  assert.ok(client.calls.some(c => c.sql.startsWith("DELETE")));
  assert.ok(!JSON.stringify(p.status()).includes("secret-password"));
  await p.close({ save: false }); assert.equal(client.ends, 1);
});

test("overlapping save requests are single-flight and restore executes once", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }), client = fakeClient({ gate }), h = history();
  h.load(checkpoint());
  const p = new HistoryPersistence({ history: h, connectionString: URL, clientFactory: () => client });
  const a = p.save(), b = p.save(), c = p.save(); assert.equal(client.connects, 1);
  release(); await Promise.all([a, b, c]);
  assert.equal(client.calls.filter(c => c.sql.startsWith("INSERT")).length, 1);
  await p.save();
  assert.equal(client.calls.filter(c => c.sql.startsWith("DECLARE")).length, 1);
  assert.equal(client.calls.filter(c => c.sql.startsWith("INSERT")).length, 2);
  assert.equal(client.maxActive, 1); await p.close({ save: false });
});

test("database failure leaves memory intact, exposes no credentials, and retries with a fresh client", async () => {
  const h = history(); h.load(checkpoint());
  const failed = fakeClient({ fail: sql => sql.startsWith("INSERT") }), recovered = fakeClient(); let attempts = 0;
  const p = new HistoryPersistence({ history: h, connectionString: URL, clientFactory: () => attempts++ ? recovered : failed });
  await p.save();
  assert.equal(p.status().state, "unavailable"); assert.equal(p.status().lastSavedAt, null);
  assert.equal(h.totalPoints, 1); assert.equal(failed.ends, 1);
  assert.ok(!JSON.stringify(p.status()).includes("database.example"));
  assert.ok(!failed.calls.some(c => c.sql.startsWith("DELETE"))); // failed transaction cannot erase checkpoint
  await p.save(); assert.equal(p.status().state, "ready"); assert.equal(recovered.connects, 1);
  await p.close({ save: false });
});

test("corrupt stored rows are skipped, late restore cannot overwrite a newer in-memory observation", async () => {
  const h = history(); h.process({ type: "snapshot", at: BASE + 500, data: {
    sources: { draftkings: { status: "healthy", lastConfirmedAt: BASE + 500, staleAfterMs: 10000 } },
    games: [{ id: "game", quotes: [{ book: "draftkings", gameId: "game", market: "spread", side: "away", period: "full_game", line: -3.5, american: -130 }] }],
  } });
  const client = fakeClient({ rows: [
    { payload: "not json" }, { payload: JSON.stringify({ schema: 1, series: [] }) },
    { payload: JSON.stringify(checkpoint([point(BASE), point(BASE + 700, -120)])) },
  ] });
  const p = new HistoryPersistence({ history: h, connectionString: URL, clientFactory: () => client });
  await p.save(); const points = h.query().series[0].points;
  assert.deepEqual(points.map(p => p.american), [-110, -130]);
  assert.equal(points.at(-1).breakBefore, true); assert.equal(p.status().rejectedRows, 2);
  await p.close({ save: false });
});

test("each series copy and load yields; returned durable rows contain no live source eligibility", async () => {
  const h = history(); h.load(checkpoint());
  let yielded = false, copies = 0;
  for await (const row of h.serializeRows({ yieldControl: async () => { yielded = true; } })) {
    assert.equal(yielded, true); assert.equal(row.checkpoint.sources, undefined);
    assert.equal(row.checkpoint.series.length, 1); row.checkpoint.series[0].points[0].american = 500;
    copies++;
  }
  assert.equal(copies, 1); assert.equal(h.query().series[0].points[0].american, -110);
});

test("idle database errors degrade only persistence and close is idempotent", async () => {
  const client = fakeClient(), p = new HistoryPersistence({ history: history(), connectionString: URL, clientFactory: () => client });
  await p.save(); client.emit("error", new Error(URL));
  assert.equal(p.status().state, "unavailable"); assert.equal(p.status().available, false);
  await p.close({ save: false }); await p.close();
  assert.equal(p.status().state, "closed"); assert.equal(client.ends, 1);
});

test("shutdown has a bounded wait when an optional database connection stalls", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; }), client = fakeClient({ gate });
  const p = new HistoryPersistence({ history: history(), connectionString: URL, clientFactory: () => client });
  const pending = p.save();
  await p.close({ timeoutMs: 10 });
  assert.equal(p.status().state, "closed"); assert.equal(client.ends, 1);
  release(); await pending;
  assert.equal(p.status().state, "closed");
});

test("checkpoint writes are monotonic by actual price, not a later shutdown gap; pruning only removes expired observations", async () => {
  const h = history();
  h.load(checkpoint([point(BASE), { at: BASE + 900, american: null, decimal: null, line: -3.5, gap: true }]));
  const client = fakeClient(), p = new HistoryPersistence({ history: h, connectionString: URL, clientFactory: () => client,
    now: () => BASE + 1000 });
  await p.save();
  const insert = client.calls.find(c => c.sql.startsWith("INSERT"));
  assert.equal(insert.values[3], BASE); assert.equal(insert.values[4], BASE + 900);
  assert.match(insert.sql, /EXCLUDED\.newest_price_at > fieldline_price_history\.newest_price_at/);
  const remove = client.calls.find(c => c.sql.startsWith("DELETE"));
  assert.match(remove.sql, /newest_observation_at < \$1/); assert.ok(!remove.sql.includes("generation"));
  assert.equal(remove.values[0], BASE + 1000 - h.retentionMs);
  await p.close({ save: false });
});
