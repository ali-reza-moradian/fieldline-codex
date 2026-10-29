import { BOOKS, decimalOdds } from "./model.js";

const MARKETS = { moneyline: ["away", "home"], spread: ["away", "home"], total: ["over", "under"] };
const SETTLEMENTS = new Set(["including_overtime", "regulation"]);
export const ANALYTICS_ASSUMPTIONS = Object.freeze([
  "Main NFL full-game quotes without an explicit settlement field use the board's documented including-overtime contract.",
  "Implied margin (hold) is the sum of the best prices' implied probabilities minus one; this is not realized bookmaker revenue.",
  "Fair probability normalizes each book's two implied probabilities and averages the two books. Estimated EV uses this market-derived estimate, not an independently predictive model.",
  "Fair probabilities and EV are conditional on a settled win/loss; push, tie-void and cancellation probabilities are not modeled.",
  "An arbitrage flag is a candidate at observed prices only. Availability, execution, limits, voids and settlement must agree; profit is not guaranteed.",
]);

export function isSourceFresh(source, now = Date.now()) {
  if (source?.status !== "healthy" || !Number.isFinite(now) || !Number.isFinite(source.lastConfirmedAt) ||
      !Number.isFinite(source.staleAfterMs) || source.staleAfterMs <= 0) return false;
  const age = now - source.lastConfirmedAt;
  if (age < 0 || age >= source.staleAfterMs) return false;
  const coverage = source.coverage;
  return !coverage || (Number.isInteger(coverage.requested) && coverage.requested > 0 &&
    coverage.returned === coverage.requested && Array.isArray(coverage.missingIds) && coverage.missingIds.length === 0);
}

function contract(q, fallback) {
  if (!q || !BOOKS.includes(q.book) || typeof q.gameId !== "string" || !q.gameId ||
      !Object.hasOwn(MARKETS, q.market) || !MARKETS[q.market].includes(q.side) || q.period !== "full_game") return null;
  const settlement = q.settlement ?? fallback;
  if (!SETTLEMENTS.has(settlement)) return null;
  let line = null;
  if (q.market !== "moneyline") {
    if (!Number.isFinite(q.line)) return null;
    line = q.market === "spread" && q.side === "home" ? -q.line : q.line;
    if (Object.is(line, -0)) line = 0;
  } else if (q.line !== null && q.line !== undefined) return null;
  return { gameId: q.gameId, market: q.market, period: q.period, settlement, line };
}

function eligible(q, sources, now) {
  if (q.suspended || q.missing || !isSourceFresh(sources?.[q.book], now) ||
      !Number.isFinite(q.american) || Math.abs(q.american) < 100) return null;
  const decimal = decimalOdds(q.american);
  if (!Number.isFinite(decimal) || decimal <= 1 ||
      (q.decimal !== undefined && (!Number.isFinite(q.decimal) || Math.abs(decimal - q.decimal) > 1e-8))) return null;
  return { ...q, decimal };
}

/** One complete two-outcome contract, with both sides from both books. A missing,
 * stale or duplicate side fails closed instead of producing a partial fair line. */
export function analyzeMarket(quotes, sources, now = Date.now(), { defaultSettlement = "including_overtime" } = {}) {
  if (!Array.isArray(quotes) || quotes.length !== BOOKS.length * 2) return null;
  const first = contract(quotes[0], defaultSettlement);
  if (!first) return null;
  const key = JSON.stringify(first), sides = MARKETS[first.market], byBook = new Map(BOOKS.map(book => [book, new Map()]));
  for (const q of quotes) {
    if (JSON.stringify(contract(q, defaultSettlement)) !== key) return null;
    const offer = eligible(q, sources, now), pair = byBook.get(q.book);
    if (!offer || !pair || pair.has(q.side)) return null;
    pair.set(q.side, offer);
  }
  if ([...byBook.values()].some(pair => sides.some(side => !pair.has(side)))) return null;
  const fairProbabilities = Object.fromEntries(sides.map(side => [side, 0]));
  for (const pair of byBook.values()) {
    const sum = sides.reduce((total, side) => total + 1 / pair.get(side).decimal, 0);
    for (const side of sides) fairProbabilities[side] += (1 / pair.get(side).decimal) / sum / BOOKS.length;
  }
  const offers = [...byBook.values()].flatMap(pair => sides.map(side => {
    const q = pair.get(side);
    return { ...q, impliedProbability: 1 / q.decimal, fairProbability: fairProbabilities[side],
      estimatedEvPercent: (q.decimal * fairProbabilities[side] - 1) * 100 };
  }));
  const bestOffers = Object.fromEntries(sides.map(side => {
    const rows = offers.filter(q => q.side === side), decimal = Math.max(...rows.map(q => q.decimal));
    const best = rows.find(q => q.decimal === decimal);
    return [side, { ...best, bestBooks: rows.filter(q => Math.abs(q.decimal - decimal) < 1e-9).map(q => q.book) }];
  }));
  const impliedSum = sides.reduce((total, side) => total + 1 / bestOffers[side].decimal, 0);
  return { ...first, holdPercent: (impliedSum - 1) * 100, impliedSum,
    arbitrageCandidate: impliedSum < 1 - 1e-9, fairProbabilities, bestOffers, offers,
    assumptions: [...ANALYTICS_ASSUMPTIONS] };
}

/** Groups different point lines and settlement rules before considering prices.
 * Malformed contracts are omitted; partially available contracts produce no row. */
export function analyzeGame(game, sources, now = Date.now()) {
  const empty = { gameId: game?.id ?? null, groups: [], bestHoldPercent: null, bestEstimatedEvPercent: null,
    assumptions: [...ANALYTICS_ASSUMPTIONS] };
  if (!game?.id || !Array.isArray(game.quotes) || game.matchWarning) return empty;
  // This module currently supports the board's NFL main markets. An explicit
  // unknown sport must not inherit football settlement assumptions.
  if (game.sport && !["nfl", "NFL"].includes(game.sport)) return empty;
  const fallback = game.settlement ?? "including_overtime", grouped = new Map();
  for (const q of game.quotes) {
    if (q?.gameId !== game.id) continue;
    const c = contract(q, fallback);
    if (!c) continue;
    const key = JSON.stringify(c);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(q);
  }
  const groups = [...grouped.values()].map(quotes => analyzeMarket(quotes, sources, now, { defaultSettlement: fallback })).filter(Boolean);
  return { ...empty, groups,
    bestHoldPercent: groups.length ? Math.min(...groups.map(g => g.holdPercent)) : null,
    bestEstimatedEvPercent: groups.length ? Math.max(...groups.flatMap(g => Object.values(g.bestOffers).map(q => q.estimatedEvPercent))) : null };
}
