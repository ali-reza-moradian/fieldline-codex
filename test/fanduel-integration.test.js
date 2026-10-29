import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { FanDuel, FanDuelState, FD_DISCOVERY, FD_PRICES, selectFanDuelMarkets } from "../src/adapters/fanduel.js";
import { fetchJson, UpstreamError } from "../src/http.js";
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
  state.applyPoll(allPrices, state.beginPoll(), { receivedAt: now, catalog });
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
  state.applyPoll(allPrices, state.beginPoll(), { receivedAt: now, catalog });
  const pendingPoll = state.beginPoll();
  now += 100;
  state.applyPush([changedMarket(-123)], { receivedAt: now }, catalog);
  now += 5000;
  state.applyPoll(allPrices, pendingPoll, { receivedAt: now, catalog });
  assert.equal(firstPrice(state), -123, "receive ordering protects the push even if the older HTTP request takes five seconds");
});

test("FanDuel lets a later-started HTTP check advance a recent pushed price without an arbitrary hold", () => {
  let now = Date.parse("2026-10-28T23:00:00.100Z");
  const state = new FanDuelState({ now: () => now });
  state.applyPoll(allPrices, state.beginPoll(), { receivedAt: now, catalog });
  state.applyPush([changedMarket(-124)], { receivedAt: now }, catalog);
  now += 100;
  const recovered = structuredClone(allPrices);
  recovered[0] = changedMarket(-125);
  state.applyPoll(recovered, state.beginPoll(), { catalog });
  assert.equal(firstPrice(state), -125, "HTTP may lead a healthy push feed and must not wait for an invented two-second priority window");
});

test("FanDuel replaces an authoritative push runner list and quarantines unknown selection IDs", () => {
  const state = new FanDuelState();
  state.applyPoll(allPrices, state.beginPoll(), { catalog });
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
  const f = await fixture({ pollMs: 250 });
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
    assert.equal(f.requests.length, before, "the 250ms fallback interval cannot override two-second Retry-After");
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

test("FanDuel catches HTTP-only changes on the default 250ms cadence while push stays verified", async () => {
  const f = await fixture({ pollMs: undefined, verificationMs: undefined });
  try {
    await f.start();
    await readyPush(f);
    sendPrice(f, -138);
    const leadingHttp = changedMarket(-139);
    f.setPrices((_entry, fallback) => ({ data: fallback().data.map(m => m.marketId === leadingHttp.marketId ? leadingHttp : m) }));
    await until(() => boardPrice(f.store) === -139,
      "a healthy but silent push feed must not delay an HTTP-only change for five seconds", 1700);
    assert.equal(f.collector.pushReady(), true, "HTTP continues even while push is verified");
    assert.equal(f.store.sources.fanduel.pollMs, 250);
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
    const successfulCycles = f.collector.pollingCounters.successfulCycles;
    now += 1000;
    f.setPrices((_entry, fallback) => ({ data: fallback().data.filter(m => m.marketId !== allPrices[0].marketId) }));
    await f.collector.tick();
    assert.equal(f.collector.pushReady(), false);
    assert.equal(f.collector.lastFullPollAt, lastComplete, "HTTP 200 with missing markets cannot renew the complete-board lease");
    assert.equal(f.collector.lastPollAt, now, "record the partial response separately from a complete response");
    assert.equal(f.collector.pollingCounters.partialCycles, 1);
    assert.equal(f.collector.pollingCounters.successfulCycles, successfulCycles);
    assert.equal(f.collector.pollingCounters.failedCycles, 0, "incomplete HTTP success is a partial cycle, not an HTTP failure");
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

// An injected monotonic scheduler makes the speed/rate tests independent of
// network timing and the host's event-loop load. Responses are recorded Ontario
// payloads; only the timing, failures and specified prices are simulated.
const ontarioDiscovery = JSON.parse(readFileSync(new URL("./fixtures/fanduel-ontario-discovery.json", import.meta.url)));
const ontarioPrices = JSON.parse(readFileSync(new URL("./fixtures/fanduel-ontario-prices.json", import.meta.url)));
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function pacedFixture(options = {}) {
  let now = 0, timerId = 0, active = 0, maxActive = 0, handler;
  const timers = new Map(), requests = [], discoveries = [], store = new OddsStore();
  const epoch = Date.parse("2026-10-29T00:30:00Z");
  const scheduler = {
    now: () => now,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await settle();
      }
      now = target; await settle();
    },
  };
  const collector = new FanDuel(store, {
    clock: () => epoch + now, scheduler,
    pushFactory: () => ({ start() {}, stop() {}, setMarketIds() {} }),
    fetcher: async (url, init) => {
      const result = data => ({ data, receivedAt: epoch + now, durationMs: 0, decodedBytes: 100 });
      if (url === FD_DISCOVERY) { discoveries.push(now); return result(ontarioDiscovery); }
      assert.equal(url, FD_PRICES);
      assert.equal(init.headers["X-Sportsbook-Region"], "ON");
      const ids = JSON.parse(init.body).marketIds;
      requests.push({ at: now, ids });
      active++; maxActive = Math.max(maxActive, active);
      try {
        const data = ontarioPrices.filter(m => ids.includes(m.marketId));
        return result(handler ? await handler(data, init) : data);
      } finally { active--; }
    },
    ...options,
  });
  return { collector, store, scheduler, requests, discoveries,
    clock: () => epoch + now,
    get active() { return active; }, get maxActive() { return maxActive; }, get timers() { return timers.size; },
    setPrices(next) { handler = next; },
    async start() { collector.start(); await settle(); },
  };
}

test("FanDuel defaults to 250ms and floors faster configurations without changing complete Ontario batching", async () => {
  for (const pollMs of [undefined, 1, 249, 250, 500, 1000]) {
    const f = pacedFixture({ pollMs });
    const interval = Math.max(250, pollMs ?? 250);
    try {
      await f.start();
      assert.equal(f.collector.pollMs, interval);
      assert.equal(f.collector.verificationMs, interval);
      assert.equal(f.store.datasets.fanduel.games.length, 29);
      assert.equal(f.store.datasets.fanduel.quotes.length, 174);
      assert.deepEqual(f.requests.map(r => r.ids.length), [70, 17]);
      assert.deepEqual(f.collector.coverage, { requested: 87, returned: 87, batches: 2, missingIds: [] });
      await f.scheduler.advance(interval - 1);
      assert.equal(f.requests.length, 2, "a normal successful cycle must not start before its configured floor");
      await f.scheduler.advance(1);
      assert.deepEqual(f.requests.map(r => r.at), [0, 0, interval, interval]);
      assert.ok(f.maxActive >= 1 && f.maxActive <= 2);
    } finally { f.collector.stop(); }
    assert.equal(f.timers, 0, "stop clears the faster recurring timer");
  }
});

test("FanDuel uses start-to-start 250ms pacing, not an additional 250ms after each response", async () => {
  const f = pacedFixture({ pollMs: 250 });
  f.setPrices(data => new Promise(resolve => f.scheduler.setTimeout(() => resolve(data), 90)));
  try {
    await f.start();
    await f.scheduler.advance(90);
    assert.equal(f.store.datasets.fanduel.quotes.length, 174);
    await f.scheduler.advance(159);
    assert.equal(f.requests.length, 2);
    await f.scheduler.advance(1);
    assert.deepEqual(f.requests.map(r => r.at), [0, 0, 250, 250]);
    await f.scheduler.advance(90);
  } finally { f.collector.stop(); }
});

test("FanDuel 250ms polling never overlaps slow batch cycles or catches up missed cycles in a burst", async () => {
  const f = pacedFixture({ pollMs: 250 });
  const hold = deferred();
  try {
    await f.start();
    f.setPrices(async data => { await hold.promise; return data; });
    await f.scheduler.advance(250);
    const task = f.collector.inFlight;
    assert.equal(f.active, 2);
    assert.equal(f.collector.pollingCounters.cyclesStarted, 2);
    assert.equal(f.collector.pollingCounters.successfulCycles, 1);
    for (let i = 0; i < 10; i++) assert.equal(f.collector.tick(), task);
    await f.scheduler.advance(1000);
    assert.equal(f.requests.length, 4, "four elapsed intervals cannot start another cycle while a response is pending");
    f.setPrices(undefined); hold.resolve(); await settle();
    await f.scheduler.advance(0);
    assert.equal(f.requests.length, 6, "one next cycle resumes after completion, without replaying missed intervals");
    assert.deepEqual(f.requests.map(r => r.at), [0, 0, 250, 250, 1250, 1250]);
    assert.equal(f.maxActive, 2);
    assert.equal(f.store.datasets.fanduel.quotes.length, 174);
    assert.equal(f.collector.pollingCounters.cyclesStarted, 3);
    assert.equal(f.collector.pollingCounters.successfulCycles, 3);
    assert.equal(f.collector.pollingCounters.failedCycles, 0);
  } finally { hold.resolve(); f.collector.stop(); await settle(); }
});

test("FanDuel 250ms cadence cannot shorten 429 Retry-After, even when push requests an immediate baseline", async () => {
  const f = pacedFixture({ pollMs: 250 });
  try {
    await f.start();
    f.setPrices(() => { throw new UpstreamError("HTTP429", 429, 2000); });
    await f.scheduler.advance(250);
    const before = f.requests.length;
    assert.equal(f.collector.nextAllowedPollAt, f.clock() + 2000);
    const failureAt = f.clock();
    assert.deepEqual(f.collector.pollingCounters, { cyclesStarted: 2, successfulCycles: 1,
      failedCycles: 1, partialCycles: 0, rateLimitedCycles: 1,
      lastFailureAt: failureAt, lastFailureStatus: 429 });
    f.setPrices(undefined);
    f.collector.onPushState({ status: "subscribed", generation: 1, subscribedMarkets: 87,
      lastConfirmedAt: f.clock(), error: null, counters: {} });
    f.collector.onPushMarkets([{ marketId: "unknown-market", runnerDetails: [] }], {
      generation: 1, receivedAt: f.clock(),
    });
    await f.scheduler.advance(1999);
    assert.equal(f.requests.length, before);
    await f.scheduler.advance(1);
    assert.equal(f.requests.length, before + 2);
    assert.equal(f.store.datasets.fanduel.quotes.length, 174);
    assert.equal(f.collector.pushReady(), true);
    const observed = f.store.sources.fanduel.channels.polling;
    assert.equal(observed.cyclesStarted, 3);
    assert.equal(observed.successfulCycles, 2);
    assert.equal(observed.failedCycles, 1, "a successful retry must not erase a transient failure");
    assert.equal(observed.rateLimitedCycles, 1, "a successful retry must not erase a transient429");
    assert.equal(observed.lastFailureAt, failureAt);
    assert.equal(observed.lastFailureStatus, 429);
    f.collector.stop();
    await f.start();
    assert.deepEqual(f.collector.pollingCounters, { cyclesStarted: 1, successfulCycles: 1,
      failedCycles: 0, partialCycles: 0, rateLimitedCycles: 0, lastFailureAt: null, lastFailureStatus: null });
  } finally { f.collector.stop(); }
});

test("FanDuel 250ms success cadence retains at least one-second ordinary failure backoff", async () => {
  const f = pacedFixture({ pollMs: 250 });
  try {
    await f.start();
    f.setPrices(() => { throw new UpstreamError("HTTP503", 503); });
    await f.scheduler.advance(250);
    const before = f.requests.length, delay = f.collector.nextAllowedPollAt - f.clock();
    assert.ok(delay >= 1000 && delay <= 1200);
    await f.scheduler.advance(999);
    assert.equal(f.requests.length, before);
  } finally { f.collector.stop(); }
});

test("FanDuel retains a discovery429 in cumulative counters even when current-catalogue prices succeed", async () => {
  let discoveries = 0;
  const f = pacedFixture({ pollMs: 250, discoveryMs: 250, fetcher: async (url, init) => {
    const result = data => ({ data, receivedAt: Date.now(), durationMs: 0, decodedBytes: 100 });
    if (url === FD_DISCOVERY) {
      if (++discoveries > 1) throw new UpstreamError("Discovery HTTP429", 429, 2000);
      return result(ontarioDiscovery);
    }
    const ids = JSON.parse(init.body).marketIds;
    return result(ontarioPrices.filter(m => ids.includes(m.marketId)));
  } });
  try {
    await f.start();
    await f.scheduler.advance(250);
    assert.equal(f.store.datasets.fanduel.quotes.length, 174);
    assert.equal(f.store.sources.fanduel.status, "healthy");
    const counters = f.store.sources.fanduel.channels.polling;
    assert.equal(counters.cyclesStarted, 2);
    assert.equal(counters.successfulCycles, 1);
    assert.equal(counters.failedCycles, 1);
    assert.equal(counters.rateLimitedCycles, 1);
    assert.equal(counters.lastFailureStatus, 429);
    assert.equal(counters.lastFailureAt, f.clock());
  } finally { f.collector.stop(); }
});

test("unknown FanDuel push markets cannot shorten the discovery endpoint Retry-After", async () => {
  let discoveries = 0;
  const f = pacedFixture({ pollMs: 250, discoveryMs: 250, fetcher: async (url, init) => {
    const result = data => ({ data, receivedAt: Date.now(), durationMs: 0, decodedBytes: 100 });
    if (url === FD_DISCOVERY) {
      if (++discoveries > 1) throw new UpstreamError("Discovery HTTP429", 429, 60000);
      return result(ontarioDiscovery);
    }
    const ids = JSON.parse(init.body).marketIds;
    return result(ontarioPrices.filter(m => ids.includes(m.marketId)));
  } });
  try {
    await f.start();
    f.collector.onPushState({ status: "subscribed", generation: 1, subscribedMarkets: 87,
      lastConfirmedAt: f.clock(), error: null, counters: {} });
    await f.scheduler.advance(0);
    await f.scheduler.advance(250);
    assert.equal(discoveries, 2);
    const allowedAt = f.clock() + 60000;
    assert.equal(f.collector.nextDiscoveryAt, allowedAt);
    f.collector.onPushMarkets([{ marketId: "unknown-market", runnerDetails: [] }], {
      generation: 1, receivedAt: f.clock(),
    });
    assert.equal(f.collector.nextDiscoveryAt, allowedAt, "a push cannot erase the source's explicit retry deadline");
    await f.scheduler.advance(59999);
    assert.equal(discoveries, 2);
    assert.equal(f.collector.coverage.returned, 87, "normal price requests continue using the existing catalogue");
    await f.scheduler.advance(1);
    assert.equal(discoveries, 3, "discovery resumes only when its own Retry-After expires");
    assert.equal(f.collector.pollingCounters.rateLimitedCycles, 2);
  } finally { f.collector.stop(); }
});

test("FanDuel startup waits for discovery backoff without replacing the source failure or polling an absent catalogue", async () => {
  let discoveries = 0, priceRequests = 0;
  const f = pacedFixture({ pollMs: 250, fetcher: async (url, init) => {
    const result = data => ({ data, receivedAt: Date.now(), durationMs: 0, decodedBytes: 100 });
    if (url === FD_DISCOVERY) {
      if (++discoveries === 1) throw new UpstreamError("Discovery HTTP503", 503);
      return result(ontarioDiscovery);
    }
    priceRequests++;
    const ids = JSON.parse(init.body).marketIds;
    return result(ontarioPrices.filter(m => ids.includes(m.marketId)));
  } });
  try {
    await f.start();
    assert.equal(discoveries, 1);
    assert.equal(priceRequests, 0);
    assert.equal(f.collector.pollError, "Discovery HTTP503");
    const delay = f.collector.discoveryRetryAt - f.clock();
    assert.ok(delay >= 10000);
    assert.ok(f.collector.nextAllowedPollAt >= f.collector.discoveryRetryAt);
    await f.collector.tick();
    await f.scheduler.advance(delay - 1);
    assert.equal(discoveries, 1);
    assert.equal(priceRequests, 0);
    await f.scheduler.advance(1);
    assert.equal(discoveries, 2);
    assert.equal(priceRequests, 2);
    assert.equal(f.collector.discoveryRetryAt, 0);
    assert.equal(f.store.datasets.fanduel.quotes.length, 174);
    assert.equal(f.collector.pollingCounters.cyclesStarted, 2);
    assert.equal(f.collector.pollingCounters.failedCycles, 1);
    assert.equal(f.collector.pollingCounters.successfulCycles, 1);
  } finally { f.collector.stop(); }
});

test("FanDuel publishes push immediately during a 250ms poll and prevents the older response rolling it back", async () => {
  const f = pacedFixture({ pollMs: 250 });
  const hold = deferred();
  try {
    await f.start();
    f.collector.onPushState({ status: "subscribed", generation: 1, subscribedMarkets: 87,
      lastConfirmedAt: f.clock(), error: null, counters: {} });
    await f.scheduler.advance(0);
    assert.equal(f.collector.pushReady(), true);
    f.setPrices(async data => { await hold.promise; return data; });
    await f.scheduler.advance(250);
    const row = structuredClone(ontarioPrices[0]);
    row.updatedAt = new Date(f.clock()).toISOString();
    row.runnerDetails[0].winRunnerOdds.americanDisplayOdds.americanOddsInt = -137;
    const sourceId = `${row.marketId}:${row.runnerDetails[0].selectionId}`;
    f.collector.onPushMarkets([row], { generation: 1, receivedAt: f.clock(), decodedBytes: 500 });
    assert.equal(f.store.datasets.fanduel.quotes.find(q => q.sourceId === sourceId).american, -137);
    assert.equal(f.active, 2, "push publication does not wait for either HTTP batch");
    hold.resolve(); await settle();
    assert.equal(f.store.datasets.fanduel.quotes.find(q => q.sourceId === sourceId).american, -137);
    assert.equal(f.collector.state.counters.pollOverwritesPrevented, 1);
  } finally { hold.resolve(); f.collector.stop(); await settle(); }
});

test("FanDuel rediscovery cannot publish stale embedded prices over the current price response", async () => {
  const f = pacedFixture({ pollMs: 250, discoveryMs: 250 });
  const row = structuredClone(ontarioPrices[0]);
  row.runnerDetails[0].winRunnerOdds.americanDisplayOdds.americanOddsInt = -143;
  const sourceId = `${row.marketId}:${row.runnerDetails[0].selectionId}`;
  f.setPrices(data => data.map(m => m.marketId === row.marketId ? row : m));
  try {
    await f.start();
    await f.scheduler.advance(1000);
    assert.equal(f.store.datasets.fanduel.quotes.find(q => q.sourceId === sourceId).american, -143);
    assert.equal(f.store.sources.fanduel.priceChanges, 0, "five metadata discoveries must not cause old-price/new-price flashes");
    assert.equal(f.requests.length, 10);
    assert.equal(f.collector.coverage.returned, 87);
  } finally { f.collector.stop(); }
});

test("unknown FanDuel push markets cannot postpone an already scheduled price poll until rediscovery", async () => {
  const f = pacedFixture({ pollMs: 250 });
  try {
    await f.start();
    f.collector.onPushState({ status: "subscribed", generation: 1, subscribedMarkets: 87,
      lastConfirmedAt: f.clock(), error: null, counters: {} });
    await f.scheduler.advance(0);
    const before = f.requests.length;
    f.collector.onPushMarkets([{ marketId: "unknown-market", runnerDetails: [] }], {
      generation: 1, receivedAt: f.clock(),
    });
    assert.equal(f.collector.nextDiscoveryAt, f.clock() + 10000);
    await f.scheduler.advance(249);
    assert.equal(f.requests.length, before);
    await f.scheduler.advance(1);
    assert.equal(f.requests.length, before + 2, "the ordinary 250ms price deadline must survive a later discovery request");
    await f.scheduler.advance(9750);
    assert.deepEqual(f.discoveries, [0, 10000], "the catalogue is refreshed at its own deadline while prices keep flowing");
    assert.equal(f.requests.length, before + 80);
    assert.equal(f.collector.coverage.returned, 87);
  } finally { f.collector.stop(); }
});

test("unknown FanDuel push markets during an in-flight poll cannot override the next ordinary deadline", async () => {
  const f = pacedFixture({ pollMs: 250 }), hold = deferred();
  try {
    await f.start();
    f.collector.onPushState({ status: "subscribed", generation: 1, subscribedMarkets: 87,
      lastConfirmedAt: f.clock(), error: null, counters: {} });
    await f.scheduler.advance(0);
    f.setPrices(async data => { await hold.promise; return data; });
    await f.scheduler.advance(250);
    const before = f.requests.length;
    f.collector.onPushMarkets([{ marketId: "unknown-market", runnerDetails: [] }], {
      generation: 1, receivedAt: f.clock(),
    });
    assert.equal(f.active, 2);
    assert.equal(f.collector.nextDiscoveryAt, f.clock() + 9750);
    f.setPrices(undefined); hold.resolve(); await settle();
    await f.scheduler.advance(249);
    assert.equal(f.requests.length, before);
    await f.scheduler.advance(1);
    assert.equal(f.requests.length, before + 2, "a pending ten-second rediscovery must not replace the next 250ms price cycle");
    assert.equal(f.maxActive, 2);
    assert.deepEqual(f.discoveries, [0]);
    assert.equal(f.collector.coverage.returned, 87);
  } finally { hold.resolve(); f.collector.stop(); await settle(); }
});
