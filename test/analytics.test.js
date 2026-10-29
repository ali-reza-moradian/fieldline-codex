import test from "node:test";
import assert from "node:assert/strict";
import { analyzeGame, analyzeMarket, isSourceFresh } from "../src/analytics.js";
import { decimalOdds } from "../src/model.js";

const now = 10000;
const sources = () => Object.fromEntries(["draftkings", "fanduel"].map(book => [book,
  { status: "healthy", lastConfirmedAt: 9500, staleAfterMs: 1000 }]));
const quote = (book, side, american, extra = {}) => ({ id: `${book}:${side}`, gameId: "game", book, market: "moneyline",
  period: "full_game", side, line: null, american, decimal: decimalOdds(american), suspended: false, ...extra });
const board = (values = [-110, -110, -110, -110]) => [quote("draftkings", "away", values[0]), quote("draftkings", "home", values[1]),
  quote("fanduel", "away", values[2]), quote("fanduel", "home", values[3])];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("hold and market-derived fair/EV estimates use both complete books", () => {
  const result = analyzeMarket(board(), sources(), now);
  close(result.holdPercent, 100 * (2 / decimalOdds(-110) - 1));
  close(result.fairProbabilities.away, .5); close(result.fairProbabilities.home, .5);
  close(result.bestOffers.away.estimatedEvPercent, (decimalOdds(-110) * .5 - 1) * 100);
  assert.deepEqual(result.bestOffers.away.bestBooks, ["draftkings", "fanduel"]);
  assert.equal(result.arbitrageCandidate, false);
  assert.ok(result.assumptions.some(text => text.includes("not an independently predictive model")));
});

test("a complete complementary market can flag an observed-price arbitrage candidate", () => {
  const result = analyzeMarket(board([110, -130, -130, 110]), sources(), now);
  assert.equal(result.arbitrageCandidate, true);
  close(result.holdPercent, 100 * (2 / 2.1 - 1));
  assert.equal(result.bestOffers.away.book, "draftkings"); assert.equal(result.bestOffers.home.book, "fanduel");
  assert.ok(result.assumptions.some(text => text.includes("profit is not guaranteed")));
});

test("spread pairs require opposite handicaps and never mix different point lines", () => {
  const q = board([110, -130, -130, 110]).map(q => ({ ...q, market: "spread", line: q.side === "away" ? 3 : -3 }));
  assert.equal(analyzeMarket(q, sources(), now).arbitrageCandidate, true);
  const mixed = q.map(q => q.book === "fanduel" ? { ...q, line: q.side === "away" ? 3.5 : -3.5 } : q);
  assert.equal(analyzeMarket(mixed, sources(), now), null);
  assert.deepEqual(analyzeGame({ id: "game", quotes: mixed }, sources(), now).groups, []);
  assert.equal(analyzeMarket(q.map(q => ({ ...q, line: 3 })), sources(), now), null);
});

test("total and settlement mismatches cannot manufacture a winning combination", () => {
  const q = board([110, -130, -130, 110]).map(q => ({ ...q, market: "total", side: q.side === "away" ? "over" : "under", line: 47.5 }));
  assert.ok(analyzeMarket(q, sources(), now));
  assert.equal(analyzeMarket(q.map((q, i) => i === 3 ? { ...q, line: 48.5 } : q), sources(), now), null);
  assert.equal(analyzeMarket(q.map(q => q.book === "fanduel" ? { ...q, settlement: "regulation" } : q), sources(), now), null);
  assert.equal(analyzeMarket(q.map((q, i) => i === 0 ? { ...q, period: "first_half" } : q), sources(), now), null);
  assert.equal(analyzeMarket(q.map(q => ({ ...q, settlement: "unverified" })), sources(), now), null);
});

test("missing, duplicate, suspended, stale and inconsistent quotes fail closed", () => {
  const q = board();
  assert.equal(analyzeMarket(q.slice(1), sources(), now), null);
  assert.equal(analyzeMarket([q[0], q[0], q[2], q[3]], sources(), now), null);
  for (const patch of [{ suspended: true }, { missing: true }, { decimal: 9 }, { american: null }, { american: 50 }, { gameId: "other" }]) {
    assert.equal(analyzeMarket(q.map((x, i) => i === 0 ? { ...x, ...patch } : x), sources(), now), null);
  }
  const stale = sources(); stale.fanduel.status = "stale";
  assert.equal(analyzeMarket(q, stale, now), null);
  assert.equal(analyzeMarket(q, sources(), 10500), null, "exact expiry is ineligible");
});

test("incomplete coverage and invalid freshness metadata are ineligible", () => {
  for (const patch of [{ lastConfirmedAt: 11000 }, { lastConfirmedAt: null }, { staleAfterMs: 0 }, { staleAfterMs: Infinity },
    { coverage: { requested: 87, returned: 80, missingIds: ["missing"] } }]) {
    assert.equal(isSourceFresh({ ...sources().fanduel, ...patch }, now), false);
  }
  assert.equal(isSourceFresh({ ...sources().fanduel, coverage: { requested: 87, returned: 87, missingIds: [] } }, now), true);
});

test("equivalent even-money formats tie and do not produce fictitious arbitrage", () => {
  const result = analyzeMarket(board([-100, 100, 100, -100]), sources(), now);
  close(result.holdPercent, 0); assert.equal(result.arbitrageCandidate, false);
  assert.deepEqual(result.bestOffers.away.bestBooks, ["draftkings", "fanduel"]);
});

test("fair probabilities de-vig each book before averaging, and do not mutate inputs", () => {
  const quotes = board([200, -250, 220, -280]), original = structuredClone(quotes);
  const result = analyzeMarket(quotes, sources(), now);
  const expected = ((1 / 3) / (1 / 3 + 1 / 1.4) + (1 / 3.2) / (1 / 3.2 + 1 / decimalOdds(-280))) / 2;
  close(result.fairProbabilities.away, expected); close(result.fairProbabilities.home, 1 - expected);
  assert.deepEqual(quotes, original);
});

test("game summaries group contracts and reject uncertain identity or unsupported sports", () => {
  const q = board();
  const alternate = q.map(q => ({ ...q, id: `${q.id}:spread`, market: "spread", line: q.side === "away" ? 3 : -3 }));
  const result = analyzeGame({ id: "game", quotes: [...q, ...alternate] }, sources(), now);
  assert.equal(result.groups.length, 2); assert.ok(Number.isFinite(result.bestHoldPercent));
  assert.deepEqual(analyzeGame({ id: "game", quotes: q, matchWarning: "Different kickoff" }, sources(), now).groups, []);
  assert.deepEqual(analyzeGame({ id: "game", quotes: q, sport: "soccer" }, sources(), now).groups, []);
});
