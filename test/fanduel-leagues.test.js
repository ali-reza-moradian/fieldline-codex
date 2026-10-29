import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FanDuel, FanDuelLeagues, FD_HEADERS, FD_PRICES, fanDuelDiscovery,
  selectFanDuelMarkets, normalizeFanDuel } from "../src/adapters/fanduel.js";
import { OddsStore } from "../src/store.js";
import { UpstreamError } from "../src/http.js";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const captured = fixture("fanduel-football-leagues");
const nfl = { discovery: fixture("fanduel-ontario-discovery"), prices: fixture("fanduel-ontario-prices") };
const raw = { nfl, ...captured.leagues };
const board = league => normalizeFanDuel(selectFanDuelMarkets(raw[league].discovery, { league }), raw[league].prices);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 3000) {
  const end = performance.now() + timeout;
  while (!predicate()) { if (performance.now() > end) assert.fail(label); await pause(5); }
}

test("Ontario college/FCS and CFL fixtures preserve every source side, line, price, availability and identity", () => {
  for (const league of ["ncaaf", "cfl"]) {
    const { discovery, prices } = raw[league], result = board(league);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.quotes.length, prices.reduce((sum, market) => sum + market.runnerDetails.length, 0));
    assert.ok(result.games.every(game => game.league === league && game.id.startsWith(league + ":")));
    const games = new Map(result.games.map(game => [game.sourceId, game]));
    const quotes = new Map(result.quotes.map(quote => [quote.sourceId, quote]));
    for (const price of prices) {
      const market = discovery.attachments.markets[price.marketId];
      const event = discovery.attachments.events[market.eventId];
      const game = games.get(String(event.eventId));
      assert.equal(game.startsAt, event.openDate);
      for (const runner of price.runnerDetails) {
        const definition = market.runners.find(row => row.selectionId === runner.selectionId);
        const quote = quotes.get(`${price.marketId}:${runner.selectionId}`);
        assert.equal(quote.gameId, game.id);
        assert.equal(quote.side, definition.result.type.toLowerCase());
        assert.equal(quote.line, market.marketType === "MONEY_LINE" ? null : runner.handicap);
        assert.equal(quote.american, runner.winRunnerOdds.americanDisplayOdds.americanOddsInt);
        assert.equal(quote.suspended, price.marketStatus !== "OPEN" || runner.runnerStatus !== "ACTIVE");
      }
    }
  }
});

test("league discovery rejects futures, a different competition and mismatched event metadata", () => {
  const data = structuredClone(raw.cfl.discovery);
  const originals = Object.keys(data.attachments.markets);
  const sample = data.attachments.markets[originals[0]];
  data.attachments.markets.foreign = { ...sample, marketId: "foreign", competitionId: 12529073 };
  data.attachments.markets.futures = { ...sample, marketId: "futures", competitionId: 11353530 };
  data.attachments.markets.wrongEvent = { ...sample, marketId: "wrongEvent", eventId: 999 };
  data.attachments.events[999] = { ...data.attachments.events[sample.eventId], eventId: 999, competitionId: 12529073 };
  assert.deepEqual(Object.keys(selectFanDuelMarkets(data, { league: "cfl" }).markets), originals);
  for (const league of ["nfl", "ncaaf", "cfl"]) {
    const url = new URL(fanDuelDiscovery(league));
    assert.equal(url.hostname, "sbapi.on.sportsbook.fanduel.ca");
    assert.equal(url.searchParams.get("customPageId"), league);
    assert.equal(url.searchParams.get("timezone"), "America/Toronto");
  }
  assert.throws(() => fanDuelDiscovery("unknown"), /Unsupported/);
});

test("college and CFL unknown runners and absent prices never inherit embedded discovery odds", () => {
  for (const league of ["ncaaf", "cfl"]) {
    const catalog = selectFanDuelMarkets(raw[league].discovery, { league });
    const prices = structuredClone(raw[league].prices);
    const missing = prices.shift();
    prices[0].runnerDetails[0].selectionId = 999999999;
    const result = normalizeFanDuel(catalog, prices);
    assert.ok(!result.quotes.some(quote => quote.sourceId.startsWith(missing.marketId + ":")));
    assert.equal(result.quotes.length, raw[league].prices.reduce((sum, market) => sum + market.runnerDetails.length, 0) - missing.runnerDetails.length - 1);
    assert.match(result.warnings.join(" "), /Unknown selection/);
  }
});

function controlledGroup() {
  let now = Date.parse("2026-10-29T21:30:00Z");
  const targets = {}, options = {}, store = new OddsStore();
  const group = new FanDuelLeagues(store, {
    clock: () => now,
    collectorFactory: (sink, config) => {
      targets[config.league] = sink; options[config.league] = config;
      return { start() {}, stop() {} };
    },
  });
  group.start();
  return { group, store, targets, options, advance: ms => { now += ms; },
    update: league => targets[league].update("fanduel", board(league), { receivedAt: now, kind: "poll", durationMs: 5 }) };
}

test("league snapshots preserve siblings and NFL verification cannot refresh failed college data", () => {
  const f = controlledGroup();
  try {
    for (const league of ["nfl", "ncaaf", "cfl"]) f.update(league);
    assert.equal(f.store.datasets.fanduel.quotes.length, 204);
    const collegeTime = f.store.sources.fanduel.leagues.ncaaf.lastConfirmedAt;
    f.targets.ncaaf.failure("fanduel", new Error("college prices unavailable"));
    f.advance(2000); f.update("nfl");
    assert.equal(f.store.sources.fanduel.leagues.ncaaf.lastConfirmedAt, collegeTime);
    assert.equal(f.store.sources.fanduel.leagues.ncaaf.status, "stale");
    assert.equal(f.store.sources.fanduel.leagues.nfl.status, "healthy");
    assert.equal(f.store.sources.fanduel.status, "stale");
    assert.equal(f.store.datasets.fanduel.quotes.length, 204, "stale values remain displayable but the league status excludes them");
    f.targets.nfl.confirm("fanduel");
    assert.equal(f.store.sources.fanduel.leagues.ncaaf.lastConfirmedAt, collegeTime);
    f.update("ncaaf");
    assert.equal(f.store.sources.fanduel.leagues.ncaaf.status, "healthy");
  } finally { f.group.stop(); }
});

test("league expiry and restart do not certify old quotes via another league's fresh snapshot", () => {
  const f = controlledGroup();
  try {
    for (const league of ["nfl", "ncaaf", "cfl"]) f.update(league);
    f.advance(11000); f.update("nfl");
    assert.equal(f.store.sources.fanduel.leagues.ncaaf.status, "stale");
    assert.equal(f.store.sources.fanduel.leagues.cfl.status, "stale");
    f.group.stop();
    const revision = f.store.revision; f.update("ncaaf");
    assert.equal(f.store.revision, revision, "stopped wrapper ignores late callbacks");
    f.group.start(); f.update("nfl");
    assert.equal(f.store.datasets.fanduel.quotes.length, 174);
    assert.equal(f.store.sources.fanduel.leagues.ncaaf.status, "connecting");
    assert.equal(f.store.sources.fanduel.leagues.ncaaf.lastConfirmedAt, null);
  } finally { f.group.stop(); }
});

test("extra leagues share a bounded queue while NFL requests remain independent", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const configs = {}, calls = [], group = new FanDuelLeagues({ details() {} }, {
    fetcher: async (url, options) => { calls.push(options.name); if (options.name === "college") await gate; return { data: [] }; },
    collectorFactory: (sink, config) => { configs[config.league] = config; return { start() {}, stop() {} }; },
  });
  const controller = new AbortController();
  const first = configs.ncaaf.fetcher(FD_PRICES, { name: "college" });
  const queued = configs.cfl.fetcher(FD_PRICES, { name: "cfl", signal: controller.signal });
  const rejected = assert.rejects(queued, /aborted/i);
  await configs.nfl.fetcher(FD_PRICES, { name: "nfl" });
  assert.deepEqual([...calls].sort(), ["college", "nfl"]);
  controller.abort(); await rejected;
  release(); await first;
  await configs.cfl.fetcher(FD_PRICES, { name: "cfl-next" });
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1), "cfl-next");
  assert.equal(configs.ncaaf.priceConcurrency, 1);
  assert.equal(configs.cfl.pollMs, 2000);
  assert.equal(configs.ncaaf.livePollMs, 1000);
  group.stop();
});

test("a slow college discovery cannot delay the NFL complete baseline", async () => {
  const store = new OddsStore(); let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const group = new FanDuelLeagues(store, {
    fetcher: async (url, options) => {
      for (const [name, value] of Object.entries(FD_HEADERS)) assert.equal(options.headers[name], value);
      let data;
      if (url === FD_PRICES) {
        const ids = JSON.parse(options.body).marketIds;
        data = Object.values(raw).flatMap(row => row.prices).filter(row => ids.includes(row.marketId));
      } else {
        const league = new URL(url).searchParams.get("customPageId");
        if (league === "ncaaf") await gate;
        data = raw[league].discovery;
      }
      return { data, receivedAt: Date.now(), durationMs: 1, decodedBytes: 100 };
    },
    pushFactory: () => ({ start() {}, stop() {}, setMarketIds() {} }),
  });
  try {
    group.start();
    await until(() => store.sources.fanduel.leagues.nfl.quotes === 174, "NFL baseline delayed by college");
    assert.equal(store.sources.fanduel.leagues.ncaaf.status, "connecting");
    unblock();
    await until(() => store.datasets.fanduel.quotes.length === 204, "all league snapshots did not merge");
    assert.ok(Object.values(store.sources.fanduel.leagues).every(row => row.status === "healthy"));
  } finally { unblock(); group.stop(); }
});

test("extra-league live cadence accelerates only that collector and keeps the minimum backoff separate", () => {
  const collector = new FanDuel({ details() {} }, {
    league: "ncaaf", pollMs: 2000, livePollMs: 1000,
    pushFactory: () => ({ start() {}, stop() {}, setMarketIds() {} }),
  });
  assert.equal(collector.interval(), 2000);
  collector.hasLiveGames = true;
  assert.equal(collector.interval(), 1000);
  collector.hasLiveGames = false;
  assert.equal(collector.interval(), 2000);
});

test("a partial college baseline publishes its own incomplete coverage atomically with the prices", async () => {
  const store = new OddsStore(), seen = [];
  const missingId = raw.ncaaf.prices[0].marketId;
  store.on("message", packet => {
    if (packet.type === "delta" && packet.data.upsertGames.some(game => game.league === "ncaaf"))
      seen.push(structuredClone(packet.data.source));
  });
  const group = new FanDuelLeagues(store, {
    fetcher: async (url, options) => {
      const data = url === FD_PRICES
        ? Object.values(raw).flatMap(row => row.prices).filter(row =>
          JSON.parse(options.body).marketIds.includes(row.marketId) && row.marketId !== missingId)
        : raw[new URL(url).searchParams.get("customPageId")].discovery;
      return { data, receivedAt: Date.now(), durationMs: 1, decodedBytes: 100 };
    },
    pushFactory: () => ({ start() {}, stop() {}, setMarketIds() {} }),
  });
  try {
    group.start();
    await until(() => seen.length > 0, "partial college baseline not observed");
    for (const source of seen) {
      assert.equal(source.leagues.ncaaf.coverage.requested, 9);
      assert.equal(source.leagues.ncaaf.coverage.returned, 8);
      assert.deepEqual(source.leagues.ncaaf.coverage.missingIds, [missingId]);
    }
    assert.ok(!store.datasets.fanduel.quotes.some(quote => quote.sourceId.startsWith(missingId + ":")));
  } finally { group.stop(); }
});

test("simultaneous league push setup shares a public configuration read without caching later refreshes", async () => {
  const configs = []; let reads = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const group = new FanDuelLeagues({ details() {} }, {
    pushOptions: { fetchConfig: async () => { reads++; await gate; return { endpoint: "shared Ontario config" }; } },
    collectorFactory: (sink, options) => {
      configs.push(options.pushOptions);
      return { start() {}, stop() {} };
    },
  });
  group.start();
  try {
    const promises = configs.map(config => config.fetchConfig({ region: "on" }));
    assert.equal(reads, 1);
    release();
    assert.equal((await Promise.all(promises)).length, 3);
    await configs[0].fetchConfig({ region: "on" });
    assert.equal(reads, 2, "later auth/config refresh must not be trapped behind a stale cache");
  } finally { release(); group.stop(); }
});

test("an endpoint Retry-After applies across leagues while independent discovery remains available", async () => {
  let now = Date.now(), requests = 0, fail = true;
  const configs = {};
  new FanDuelLeagues({ details() {} }, {
    clock: () => now,
    fetcher: async url => {
      requests++;
      if (url === FD_PRICES && fail) throw new UpstreamError("rate limited", 429, 4000);
      return { data: [] };
    },
    collectorFactory: (sink, config) => { configs[config.league] = config; return { start() {}, stop() {} }; },
  });
  await assert.rejects(configs.ncaaf.fetcher(FD_PRICES, {}), /rate limited/);
  fail = false;
  await assert.rejects(configs.nfl.fetcher(FD_PRICES, {}), error => error.status === 429 && error.retryAfterMs === 4000);
  assert.equal(requests, 1, "the NFL queue must not bypass a rate limit observed by college polling");
  await configs.nfl.fetcher(fanDuelDiscovery("nfl"), {});
  assert.equal(requests, 2, "separate discovery endpoint remains independent");
  now += 4000;
  await configs.nfl.fetcher(FD_PRICES, {});
  assert.equal(requests, 3);
});
