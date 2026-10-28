import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { FanDuel, FanDuelState, FD_DISCOVERY, FD_PRICES, selectFanDuelMarkets } from "../src/adapters/fanduel.js";
import { fetchJson } from "../src/http.js";
import { OddsStore } from "../src/store.js";
import { createApp } from "../src/server.js";
import { makeGame, makeQuote } from "../src/model.js";

const discovery = JSON.parse(readFileSync(new URL("./fixtures/fanduel-discovery.json", import.meta.url)));
const catalog = selectFanDuelMarkets(discovery);
const allPrices = Object.values(catalog.markets).map(market => ({
  marketId: market.marketId,
  marketStatus: "OPEN",
  inplay: false,
  runnerDetails: market.runners.map(runner => ({
    selectionId: runner.selectionId,
    handicap: runner.handicap,
    runnerStatus: "ACTIVE",
    winRunnerOdds: structuredClone(runner.winRunnerOdds),
  })),
}));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 2500) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) assert.fail(message);
    await pause(5);
  }
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function changedMarket(odds, updatedAt = "2026-10-28T23:00:00.000Z") {
  const market = structuredClone(allPrices[0]);
  market.updatedAt = updatedAt;
  market.runnerDetails[0].winRunnerOdds.americanDisplayOdds.americanOddsInt = odds;
  market.runnerDetails[0].winRunnerOdds.americanDisplayOdds.americanOdds = odds;
  return market;
}
const firstPrice = state => state.values().find(m => m.marketId === allPrices[0].marketId)
  ?.runnerDetails[0].winRunnerOdds.americanDisplayOdds.americanOddsInt;
const boardPrice = store => store.datasets.fanduel.quotes.find(q =>
  q.sourceId === `${allPrices[0].marketId}:${allPrices[0].runnerDetails[0].selectionId}`)?.american;
function pushState(f, status, generation = 1) {
  f.push.callbacks.onState({ status, generation, lastConfirmedAt: Date.now(), lastDataAt: Date.now(),
    error: status === "error" ? "fake connection lost" : null,
    subscribedMarkets: status === "subscribed" ? 87 : 0, counters: {} });
}
function sendPrice(f, odds, generation = 1) {
  f.push.callbacks.onMarkets([changedMarket(odds, new Date().toISOString())], {
    receivedAt: Date.now(), sourceUpdatedAt: Date.now(), decodedBytes: 500, generation,
  });
}
async function readyPush(f, generation = 1) {
  pushState(f, "subscribed", generation);
  await until(() => f.collector.pushReady(), "subscription needs a complete fresh HTTP baseline before verification");
}
function streamReader(response) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(type) {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!frame.includes(`event: ${type}\n`)) continue;
          return JSON.parse(frame.split("\n").find(line => line.startsWith("data: ")).slice(6));
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("viewer stream ended before the requested event");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel() { return reader.cancel().catch(() => {}); },
  };
}

test("FanDuel applies distinct same-second pushes in receive order and rejects strictly older prices", () => {
  let now = Date.parse("2026-10-28T23:00:00.100Z");
  const state = new FanDuelState({ now: () => now });
  state.applyPoll(allPrices, state.beginPoll(), { receivedAt: now, catalog, preserveRecentPush: false });
  state.applyPush([changedMarket(-111)], { receivedAt: now }, catalog);
  now += 100;
  state.applyPush([changedMarket(-112)], { receivedAt: now }, catalog);
  assert.equal(firstPrice(state), -112, "a second real price in the same source second must not be dropped");
  now += 100;
  state.applyPush([changedMarket(-120, "2026-10-28T22:59:59.000Z")], { receivedAt: now }, catalog);
  assert.equal(firstPrice(state), -112, "a delayed older source update must not overwrite the latest price");
});

test("FanDuel push received during a price poll cannot be rolled back when that poll finishes", () => {
  let now = Date.parse("2026-10-28T23:00:00.100Z");
  const state = new FanDuelState({ now: () => now });
  state.applyPoll(allPrices, state.beginPoll(), { receivedAt: now, catalog, preserveRecentPush: false });
  const pendingPoll = state.beginPoll();
  now += 100;
  state.applyPush([changedMarket(-123)], { receivedAt: now }, catalog);
  now += 5000;
  state.applyPoll(allPrices, pendingPoll, { receivedAt: now, catalog, preserveRecentPush: false });
  assert.equal(firstPrice(state), -123, "receive ordering protects the push even after the short HTTP hold window expires");
});

test("FanDuel briefly protects recent push from an untimestamped HTTP snapshot, then permits fallback recovery", () => {
  let now = Date.parse("2026-10-28T23:00:00.100Z");
  const state = new FanDuelState({ now: () => now, holdMs: 2000 });
  state.applyPoll(allPrices, state.beginPoll(), { receivedAt: now, catalog, preserveRecentPush: false });
  state.applyPush([changedMarket(-124)], { receivedAt: now }, catalog);
  now += 100;
  state.applyPoll(allPrices, state.beginPoll(), { receivedAt: now, catalog, preserveRecentPush: true });
  assert.equal(firstPrice(state), -124);
  const recovered = structuredClone(allPrices);
  recovered[0] = changedMarket(-125);
  now += 100;
  state.applyPoll(recovered, state.beginPoll(), { receivedAt: now, catalog, preserveRecentPush: false });
  assert.equal(firstPrice(state), -125, "a fresh fallback poll must be allowed to recover after the stream disconnects");
});

test("FanDuel replaces an authoritative push runner list and quarantines unknown selection IDs", () => {
  const state = new FanDuelState();
  state.applyPoll(allPrices, state.beginPoll(), { catalog, preserveRecentPush: false });
  const row = changedMarket(-122);
  row.runnerDetails = row.runnerDetails.slice(0, 1);
  state.applyPush([row], { receivedAt: Date.now() }, catalog);
  assert.equal(state.values().find(m => m.marketId === row.marketId).runnerDetails.length, 1,
    "a removed runner must not remain offered through an old merged array");
  const unknown = structuredClone(row);
  unknown.runnerDetails[0].selectionId = 999999999;
  const result = state.applyPush([unknown], { receivedAt: Date.now() }, catalog);
  assert.equal(result.unknown, 1);
  assert.equal(firstPrice(state), -122, "unknown IDs wait for discovery instead of being assigned to a side");
});

// A local fake source deliberately truncates an oversized request to 80 markets.
// A complete result requires the collector to ask in bounded batches, not to
// assume that an HTTP 200 contains every requested market.
async function fixture(options = {}) {
  const requests = [], releases = [];
  const store = new OddsStore();
  const push = { starts: 0, stops: 0, ids: [], callbacks: null };
  let onPrices;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/discovery") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(discovery));
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const ids = JSON.parse(body).marketIds;
      const entry = { ids, at: performance.now(), aborted: false };
      requests.push(entry);
      response.once("close", () => { entry.aborted = !response.writableEnded; });
      const fallback = () => ({ data: allPrices.filter(p => ids.slice(0, 80).includes(p.marketId)) });
      const result = onPrices ? await onPrices(entry, fallback) : fallback();
      if (response.destroyed) return;
      response.writeHead(result.status ?? 200, { "Content-Type": "application/json", ...(result.headers ?? {}) });
      response.end(JSON.stringify(result.data ?? {}));
    } catch (error) {
      if (!response.destroyed) response.writeHead(500).end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const collector = new FanDuel(store, {
    pollMs: 60000, verificationMs: 60000, discoveryMs: 60000,
    fetcher: (url, init) => {
      assert.ok(url === FD_DISCOVERY || url === FD_PRICES, "collector uses an injected HTTP source");
      return fetchJson(base + (url === FD_DISCOVERY ? "/discovery" : "/prices"), init);
    },
    pushFactory: callbacks => {
      push.callbacks = callbacks;
      return {
        start() { push.starts++; },
        stop() { push.stops++; },
        setMarketIds(ids) { push.ids = [...ids]; },
      };
    },
    ...options,
  });
  return {
    collector, store, push, requests, releases,
    setPrices(handler) { onPrices = handler; },
    async start() {
      collector.start();
      await until(() => store.datasets.fanduel.quotes.length === 174, "all 174 fake-source prices should arrive");
    },
    async close() {
      collector.stop();
      for (const release of releases) release();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test("FanDuel batches all 87 markets and publishes 174 prices across 29 games", async () => {
  const f = await fixture();
  try {
    await f.start();
    assert.equal(allPrices.length, 87);
    assert.equal(f.store.datasets.fanduel.games.length, 29);
    assert.equal(f.store.datasets.fanduel.quotes.length, 174);
    assert.deepEqual(f.requests.map(r => r.ids.length).sort((a, b) => b - a), [70, 17]);
    assert.equal(new Set(f.requests.flatMap(r => r.ids)).size, 87);
    assert.equal(new Set(f.push.ids).size, 87);
    assert.equal(f.push.starts, 1);
  } finally { await f.close(); }
});

test("FanDuel does not replace a complete board with one successful batch when another fails", async () => {
  const f = await fixture();
  try {
    await f.start();
    const previous = structuredClone(f.store.datasets.fanduel);
    f.setPrices((entry, fallback) => {
      if (entry.ids.length < 70) return { status: 503, data: { error: "temporarily unavailable" } };
      const result = structuredClone(fallback());
      for (const market of result.data) for (const runner of market.runnerDetails)
        runner.winRunnerOdds.americanDisplayOdds.americanOddsInt = -101;
      return result;
    });
    await f.collector.tick();
    assert.deepEqual(f.store.datasets.fanduel, previous, "partial HTTP success must not drop or rewrite the other batch");
    assert.equal(f.store.sources.fanduel.status, "stale");
  } finally { await f.close(); }
});

test("FanDuel cancels a hanging sibling batch when the other price request fails", async () => {
  const f = await fixture();
  const hold = deferred(); f.releases.push(hold.resolve);
  try {
    await f.start();
    const initial = f.requests.length;
    f.setPrices(async (entry, fallback) => {
      if (entry.ids.length < 70) return { status: 503, data: { error: "fake batch failure" } };
      await hold.promise;
      return fallback();
    });
    const poll = f.collector.tick();
    await until(() => f.requests.slice(initial).some(r => r.ids.length === 70 && r.aborted),
      "a failing batch should cancel the other in-flight request instead of leaving it alive");
    await poll;
    assert.equal(f.store.datasets.fanduel.quotes.length, 174);
    assert.equal(f.store.sources.fanduel.status, "stale");
  } finally { await f.close(); }
});

test("FanDuel stop aborts pending HTTP work and prevents late publication", async () => {
  const f = await fixture();
  const hold = deferred();
  f.releases.push(hold.resolve);
  f.setPrices(async (_entry, fallback) => { await hold.promise; return fallback(); });
  try {
    f.collector.start();
    await until(() => f.requests.length === 2, "both fake price requests should begin");
    f.collector.stop();
    await until(() => f.requests.every(r => r.aborted), "stop should cancel both pending HTTP requests");
    hold.resolve();
    await pause(50);
    assert.equal(f.store.datasets.fanduel.quotes.length, 0);
    assert.equal(f.store.history.length, 0);
    assert.equal(f.push.stops, 1);
    assert.equal(f.requests.length, 2);
  } finally { await f.close(); }
});

test("FanDuel honors an upstream Retry-After before retrying a failed batch", { timeout: 6000 }, async () => {
  const f = await fixture({ pollMs: 1000 });
  let failing = true;
  f.setPrices((_entry, fallback) => failing
    ? { status: 429, headers: { "Retry-After": "2" }, data: { error: "slow down" } }
    : fallback());
  try {
    f.collector.start();
    await until(() => f.store.sources.fanduel.status === "stale", "the initial rate limit should be visible");
    const before = f.requests.length;
    failing = false;
    await pause(1250);
    assert.equal(f.requests.length, before, "the one-second fallback interval cannot override two-second Retry-After");
    await until(() => f.store.datasets.fanduel.quotes.length === 174, "price polling should recover after Retry-After", 2500);
    assert.equal(f.store.sources.fanduel.status, "healthy");
  } finally { await f.close(); }
});

test("FanDuel keeps live push flowing through slow and failed HTTP reconciliation", async () => {
  const f = await fixture();
  try {
    await f.start();
    await readyPush(f);
    const hold = deferred(); f.releases.push(hold.resolve);
    f.setPrices(async (_entry, fallback) => { await hold.promise; return fallback(); });
    const before = f.requests.length, poll = f.collector.tick();
    await until(() => f.requests.length === before + 2, "reconciliation should have both batches in flight");
    sendPrice(f, -131);
    assert.equal(boardPrice(f.store), -131, "push reaches the shared board without waiting for HTTP");
    hold.resolve();
    await poll;
    assert.equal(boardPrice(f.store), -131, "the completed older snapshot cannot roll back the pushed price");
    f.setPrices(() => ({ status: 503, data: { error: "temporary HTTP outage" } }));
    await f.collector.tick();
    assert.equal(f.store.sources.fanduel.status, "healthy", "a verified active stream remains usable when its backup request fails");
    assert.match(f.collector.pollError, /503/);
    sendPrice(f, -132);
    assert.equal(boardPrice(f.store), -132);
  } finally { await f.close(); }
});

test("FanDuel disconnect falls back to HTTP and reconnect verifies a fresh baseline without reverting concurrent push", async () => {
  const f = await fixture({ pollMs: 1000 });
  try {
    await f.start();
    await readyPush(f);
    const recovery = changedMarket(-140);
    f.setPrices((_entry, fallback) => ({ data: fallback().data.map(m => m.marketId === recovery.marketId ? recovery : m) }));
    pushState(f, "error");
    assert.equal(f.collector.pushReady(), false);
    await until(() => boardPrice(f.store) === -140, "a disconnected stream should trigger fallback polling promptly");
    const hold = deferred(); f.releases.push(hold.resolve);
    f.setPrices(async (_entry, fallback) => { await hold.promise; return fallback(); });
    const before = f.requests.length;
    pushState(f, "subscribed", 2);
    assert.equal(f.collector.pushReady(), false, "a reconnect acknowledgement alone is not a fresh full board");
    await until(() => f.requests.length === before + 2, "reconnect must start a fresh baseline request");
    sendPrice(f, -150, 2);
    hold.resolve();
    await until(() => f.collector.pushReady(), "the reconnect should be verified after the full baseline returns");
    assert.equal(boardPrice(f.store), -150, "push arriving during the reconnect baseline must survive replacement");
    sendPrice(f, -999, 1);
    assert.equal(boardPrice(f.store), -150, "a delayed callback from the previous socket generation must be ignored");
  } finally { await f.close(); }
});

test("FanDuel cannot stay healthy on heartbeats forever when HTTP completeness checks keep failing", async () => {
  let now = Date.now();
  const f = await fixture({ clock: () => now, pollMs: 1000, verificationMs: 5000, reconcileMaxAgeMs: 30000 });
  try {
    await f.start();
    await readyPush(f);
    f.setPrices(() => ({ status: 503, data: { error: "persistent HTTP outage" } }));
    now += 1000;
    await f.collector.tick();
    assert.equal(f.store.sources.fanduel.status, "healthy", "a short HTTP interruption can use the verified stream");
    now += 31000;
    f.push.callbacks.onState({ status: "subscribed", generation: 1, lastConfirmedAt: now,
      lastDataAt: now, subscribedMarkets: 87, error: null, counters: {} });
    await f.collector.tick();
    assert.equal(f.collector.pushReady(), false, "a fresh heartbeat cannot renew the complete-board HTTP lease");
    assert.equal(f.store.sources.fanduel.status, "stale");
    assert.equal(f.collector.interval(), 1000);
    assert.equal(f.store.datasets.fanduel.quotes.length, 174, "retain the last board with an explicit stale indicator");
  } finally { await f.close(); }
});

test("a partial FanDuel reconciliation clears push verification without renewing the full-board lease", async () => {
  let now = Date.now();
  const f = await fixture({ clock: () => now, pollMs: 1000, verificationMs: 5000, reconcileMaxAgeMs: 30000 });
  const app = createApp({ store: f.store, ingest: false });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const healthUrl = `http://127.0.0.1:${app.server.address().port}/api/health`;
  try {
    await f.start();
    await readyPush(f);
    const game = makeGame("draftkings", "health-fixture", "Carolina Panthers", "Green Bay Packers", "2026-10-30T00:15:00Z");
    f.store.update("draftkings", { games: [game], quotes: [makeQuote(game, "moneyline", "home", null, -110, "health-quote")], warnings: [] },
      { receivedAt: Date.now(), kind: "poll", durationMs: 1, decodedBytes: 100 });
    assert.equal((await fetch(healthUrl)).status, 200);
    const lastComplete = f.collector.lastFullPollAt;
    now += 1000;
    f.setPrices((_entry, fallback) => ({ data: fallback().data.filter(m => m.marketId !== allPrices[0].marketId) }));
    await f.collector.tick();
    assert.equal(f.collector.pushReady(), false);
    assert.equal(f.collector.lastFullPollAt, lastComplete, "HTTP 200 with missing markets cannot renew the complete-board lease");
    assert.equal(f.collector.lastPollAt, now, "record the partial response separately from a complete response");
    assert.equal(f.store.sources.fanduel.channels.push.verified, false);
    const response = await fetch(healthUrl);
    const health = await response.json();
    assert.equal(response.status, 503);
    assert.equal(health.books.fanduel.complete, false);
  } finally { await app.shutdown(); await f.close(); }
});

test("FanDuel restart fences old non-cancellable HTTP success and failure without disturbing the new poll", { timeout: 8000 }, async () => {
  for (const outcome of ["success", "failure"]) {
    const oldHold = deferred(), newHold = deferred();
    let discoveries = 0, priceRequests = 0, phase = "normal", oldSignal;
    const fresh = allPrices.map(m => m.marketId === allPrices[0].marketId ? changedMarket(-170) : m);
    const result = data => ({ data, receivedAt: Date.now(), durationMs: 1, decodedBytes: 100 });
    const f = await fixture({ pollMs: 1000, verificationMs: 1000, fetcher: async (url, options) => {
      if (url === FD_DISCOVERY) {
        if (++discoveries === 1) {
          oldSignal = options.signal;
          await oldHold.promise; // Deliberately ignores abort to exercise the run fence.
          if (outcome === "failure") throw new Error("old run eventually failed");
        }
        return result(discovery);
      }
      priceRequests++;
      const ids = JSON.parse(options.body).marketIds;
      if (phase === "hold") await newHold.promise;
      return result(fresh.filter(m => ids.includes(m.marketId)));
    } });
    f.releases.push(oldHold.resolve, newHold.resolve);
    try {
      f.collector.start();
      const oldTask = f.collector.tick();
      await until(() => discoveries === 1, "the old discovery request should be held");
      f.collector.stop();
      assert.equal(oldSignal.aborted, true);
      f.collector.start();
      await until(() => boardPrice(f.store) === -170, "restart should establish a new complete baseline independently");
      phase = "hold";
      const before = priceRequests, newTask = f.collector.tick();
      await until(() => priceRequests === before + 2, "the restarted run should have a new poll in flight");
      oldHold.resolve();
      await oldTask;
      assert.equal(boardPrice(f.store), -170, `old ${outcome} must not replace the new board`);
      assert.equal(f.store.sources.fanduel.status, "healthy");
      assert.equal(f.collector.discoveryError, null);
      assert.equal(f.collector.tick(), newTask, "the old finally handler cannot clear the current in-flight promise");
      assert.equal(priceRequests, before + 2, "no overlapping poll may start after the old task finishes");
      phase = "normal";
      newHold.resolve();
      await newTask;
      const after = priceRequests;
      await until(() => priceRequests > after, "the restarted collector must keep scheduling its own polls", 2000);
      assert.equal(boardPrice(f.store), -170);
      assert.equal(f.push.starts, 2);
    } finally { await f.close(); }
  }
});

test("one FanDuel collector delivers the same pushed price to two HTTP viewers", async () => {
  const f = await fixture();
  const app = createApp({ store: f.store, ingest: false });
  const controller = new AbortController();
  let readers = [];
  try {
    await f.start();
    await readyPush(f);
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    const url = `http://127.0.0.1:${app.server.address().port}/api/events`;
    const requestsBeforeViewers = f.requests.length;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
    readers = (await Promise.all([fetch(url, { signal }), fetch(url, { signal })])).map(streamReader);
    const snapshots = await Promise.all(readers.map(reader => reader.next("snapshot")));
    assert.equal(snapshots[0].revision, snapshots[1].revision);
    sendPrice(f, -155);
    const events = await Promise.all(readers.map(reader => reader.next("delta")));
    assert.equal(events[0].revision, events[1].revision);
    for (const event of events) assert.ok(event.upsertGames.flatMap(g => g.quotes).some(q => q.american === -155));
    assert.equal(f.requests.length, requestsBeforeViewers, "adding viewers must not add bookmaker requests");
    assert.equal(f.push.starts, 1);
  } finally {
    controller.abort();
    await Promise.all(readers.map(reader => reader.cancel()));
    await app.shutdown();
    await f.close();
  }
});

test("readiness requires both populated fresh complete books while liveness remains independent", async () => {
  const app = createApp({ ingest: false });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const read = async path => {
    const response = await fetch(base + path);
    return { status: response.status, data: await response.json() };
  };
  const populate = book => {
    const game = makeGame(book, "health-fixture", "Carolina Panthers", "Green Bay Packers", "2026-10-30T00:15:00Z");
    app.store.update(book, { games: [game], quotes: [makeQuote(game, "moneyline", "home", null, -110, "health-quote")], warnings: [] },
      { receivedAt: Date.now(), kind: "poll", durationMs: 1, decodedBytes: 100 });
  };
  try {
    assert.equal((await read("/healthz")).status, 200);
    assert.equal((await read("/api/health")).status, 503, "a running empty process is not a ready odds board");
    populate("draftkings");
    populate("fanduel");
    assert.equal((await read("/api/health")).status, 503, "FanDuel completeness must be known before readiness succeeds");
    app.store.details("fanduel", { coverage: { requested: 1, returned: 1, batches: 1, missingIds: [] } });
    let result = await read("/api/health");
    assert.equal(result.status, 200);
    assert.equal(result.data.ready, true);
    app.store.sources.fanduel.lastConfirmedAt = Date.now() - app.store.sources.fanduel.staleAfterMs - 1;
    result = await read("/api/health");
    assert.equal(result.status, 503);
    assert.equal(result.data.books.fanduel.fresh, false);
    populate("fanduel");
    app.store.failure("draftkings", new Error("fake source outage"));
    result = await read("/api/health");
    assert.equal(result.status, 503);
    assert.equal(result.data.books.draftkings.fresh, false);
    assert.equal((await read("/healthz")).status, 200, "a book outage must not fail process liveness");
    populate("draftkings");
    app.store.details("fanduel", { coverage: { requested: 2, returned: 1, batches: 1, missingIds: ["missing-market"] } });
    result = await read("/api/health");
    assert.equal(result.status, 503);
    assert.equal(result.data.books.fanduel.complete, false);
    app.store.details("fanduel", { coverage: { requested: 2, returned: 1, batches: 1, missingIds: [] } });
    assert.equal((await read("/api/health")).status, 503, "inconsistent coverage counts cannot be hidden by an empty missing-ID list");
    app.store.details("fanduel", { coverage: { requested: 1, returned: 1, batches: 1, missingIds: [] } });
    assert.equal((await read("/api/health")).status, 200);
  } finally { await app.shutdown(); }
});
