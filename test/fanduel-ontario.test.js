import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FanDuel, FD_REGION, FD_ORIGIN, FD_HEADERS, FD_DISCOVERY, FD_PRICES,
  selectFanDuelMarkets, normalizeFanDuel, fetchFanDuelPrices,
} from "../src/adapters/fanduel.js";
import { OddsStore } from "../src/store.js";

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const discovery = fixture("fanduel-ontario-discovery");
const prices = fixture("fanduel-ontario-prices");
const catalog = selectFanDuelMarkets(discovery);
const normalize = (rows = prices) => normalizeFanDuel(catalog, rows);

test("all 174 recorded Ontario quotes retain the source event, market, side, line, price and availability", () => {
  const board = normalize();
  assert.equal(Object.keys(catalog.markets).length, 87);
  assert.equal(prices.length, 87);
  assert.equal(board.games.length, 29);
  assert.equal(board.quotes.length, 174);
  assert.deepEqual(board.warnings, []);
  assert.equal(new Set(board.quotes.map(q => q.sourceId)).size, 174);
  const games = new Map(board.games.map(g => [g.sourceId, g]));
  const quotes = new Map(board.quotes.map(q => [q.sourceId, q]));
  const expectedKinds = {
    MONEY_LINE: "moneyline",
    "MATCH_HANDICAP_(2-WAY)": "spread",
    "TOTAL_POINTS_(OVER/UNDER)": "total",
  };
  for (const rawMarket of prices) {
    const definition = catalog.markets[rawMarket.marketId];
    const event = catalog.events[definition.eventId];
    const game = games.get(String(event.eventId));
    assert.equal(`${game.away.name} @ ${game.home.name}`, event.name);
    assert.equal(game.startsAt, new Date(event.openDate).toISOString());
    for (const rawRunner of rawMarket.runnerDetails) {
      const definitionRunner = definition.runners.find(r => r.selectionId === rawRunner.selectionId);
      const quote = quotes.get(`${rawMarket.marketId}:${rawRunner.selectionId}`);
      assert.ok(quote, `missing source selection ${rawMarket.marketId}:${rawRunner.selectionId}`);
      assert.equal(quote.gameId, game.id);
      assert.equal(quote.market, expectedKinds[definition.marketType]);
      assert.equal(quote.side, definitionRunner.result.type.toLowerCase());
      assert.equal(quote.period, "full_game");
      assert.equal(quote.line, definition.marketType === "MONEY_LINE" ? null : rawRunner.handicap);
      assert.equal(quote.american, rawRunner.winRunnerOdds.americanDisplayOdds.americanOddsInt);
      assert.equal(quote.suspended, false, "all rows in this capture were OPEN/ACTIVE");
    }
  }
  for (const game of board.games) {
    const contracts = board.quotes.filter(q => q.gameId === game.id).map(q => `${q.market}:${q.side}`).sort();
    assert.deepEqual(contracts, ["moneyline:away", "moneyline:home", "spread:away", "spread:home", "total:over", "total:under"]);
  }
});

test("Ontario Panthers–Packers fixture has the six independently checked main-line prices", () => {
  const board = normalize();
  const game = board.games.find(g => g.sourceId === "36215311");
  assert.equal(game.away.id, "CAR");
  assert.equal(game.home.id, "GB");
  assert.equal(game.id, "2026-10-29:CAR:GB");
  assert.equal(game.startsAt, "2026-10-30T00:16:00.000Z");
  const sort = rows => rows.sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`));
  const actual = board.quotes.filter(q => q.gameId === game.id).map(q => [q.market, q.side, q.line, q.american]);
  // Checked directly against the captured Ontario runner rows, independent of
  // the normalizer: moneyline's raw zero handicap must not become a point line.
  assert.deepEqual(sort(actual), sort([
    ["moneyline", "away", null, 160],
    ["moneyline", "home", null, -190],
    ["spread", "away", 3.5, -106],
    ["spread", "home", -3.5, -114],
    ["total", "over", 47.5, -102],
    ["total", "under", 47.5, -120],
  ]));
});

test("Ontario side assignment survives reversed response order and string selection IDs", () => {
  const altered = structuredClone(prices).reverse();
  for (const market of altered) {
    market.runnerDetails.reverse();
    for (const runner of market.runnerDetails) runner.selectionId = String(runner.selectionId);
  }
  const byId = board => [...board.quotes].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(byId(normalize(altered)), byId(normalize()));
});

test("Ontario market and runner suspension remain visible with the correct affected sides", () => {
  const altered = structuredClone(prices);
  altered.find(m => m.marketId === "801.192827493").marketStatus = "SUSPENDED";
  const moneyline = altered.find(m => m.marketId === "801.192827494");
  moneyline.runnerDetails.find(r => r.selectionId === 50192).runnerStatus = "SUSPENDED";
  moneyline.inplay = true;
  const board = normalize(altered);
  const game = board.games.find(g => g.sourceId === "36215311");
  assert.equal(game.live, true);
  const quotes = board.quotes.filter(q => q.gameId === game.id);
  assert.deepEqual(quotes.filter(q => q.suspended).map(q => `${q.market}:${q.side}`).sort(),
    ["moneyline:home", "total:over", "total:under"]);
  assert.equal(quotes.find(q => q.market === "moneyline" && q.side === "away").suspended, false);
});

test("Ontario discovery cannot be paired with the recorded New Jersey price IDs", async () => {
  const njPrices = fixture("fanduel-prices");
  const njCatalog = selectFanDuelMarkets(fixture("fanduel-discovery"));
  assert.throws(() => normalizeFanDuel(catalog, njPrices), /no requested markets/);
  assert.throws(() => normalizeFanDuel(njCatalog, prices), /no requested markets/);
  await assert.rejects(fetchFanDuelPrices(Object.keys(catalog.markets).slice(0, 70), {
    fetcher: async () => ({ data: njPrices.slice(0, 70), receivedAt: Date.now(), durationMs: 1, decodedBytes: 100 }),
  }), /does not match the requested markets/);
});

test("FanDuel collector uses one Ontario profile for discovery, price requests and push", async () => {
  const calls = [], store = new OddsStore();
  let pushConfig, timer, onMessage;
  const collector = new FanDuel(store, {
    pollMs: 60000,
    pushOptions: { region: "nj" }, // A per-transport override cannot mix jurisdictions.
    pushFactory: config => { pushConfig = config; return { start() {}, stop() {}, setMarketIds() {} }; },
    fetcher: async (url, options) => {
      calls.push({ url, options });
      const data = url === FD_DISCOVERY ? discovery : prices.filter(m => JSON.parse(options.body).marketIds.includes(m.marketId));
      return { data, receivedAt: Date.now(), durationMs: 1, decodedBytes: JSON.stringify(data).length };
    },
  });
  try {
    const populated = new Promise((resolve, reject) => {
      onMessage = () => { if (store.datasets.fanduel.quotes.length === 174) resolve(); };
      store.on("message", onMessage);
      timer = setTimeout(() => reject(new Error("Ontario fixture board did not populate")), 2000);
    });
    collector.start();
    await populated;
    assert.equal(FD_REGION, "on");
    assert.equal(FD_ORIGIN, "https://sportsbook.fanduel.ca");
    assert.equal(pushConfig.region, "on");
    assert.equal(new URL(FD_DISCOVERY).hostname, "sbapi.on.sportsbook.fanduel.ca");
    assert.equal(new URL(FD_DISCOVERY).searchParams.get("timezone"), "America/Toronto");
    assert.equal(new URL(FD_PRICES).hostname, "smp.on.sportsbook.fanduel.ca");
    assert.equal(calls.length, 3);
    for (const { options } of calls) {
      for (const [header, value] of Object.entries(FD_HEADERS)) assert.equal(options.headers[header], value);
      assert.equal(options.headers["X-Sportsbook-Region"], "ON");
      assert.equal(options.headers.Origin, "https://sportsbook.fanduel.ca");
      assert.equal(options.headers.Referer, "https://sportsbook.fanduel.ca/");
    }
    assert.deepEqual(calls.filter(c => c.url === FD_PRICES).map(c => JSON.parse(c.options.body).marketIds.length).sort((a, b) => b - a), [70, 17]);
    assert.equal(store.sources.fanduel.region, "Ontario");
  } finally {
    clearTimeout(timer);
    store.off("message", onMessage);
    collector.stop();
  }
});
