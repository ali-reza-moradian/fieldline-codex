import { makeGame, makeQuote } from "../model.js";
import { fetchJson, retryDelay } from "../http.js";

export const FD_TYPES = {
  MONEY_LINE: "moneyline",
  "MATCH_HANDICAP_(2-WAY)": "spread",
  "TOTAL_POINTS_(OVER/UNDER)": "total",
};
// Public page configuration, observed in the logged-out NFL page's network requests.
export const FD_DISCOVERY =
  "https://api.sportsbook.fanduel.com/sbapi/content-managed-page?page=CUSTOM&customPageId=nfl&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FNew_York";
export const FD_PRICES =
  "https://smp.nj.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0";

export function selectFanDuelMarkets(data) {
  if (!data?.attachments?.events || !data?.attachments?.markets)
    throw new Error("FanDuel discovery schema changed");
  return {
    events: data.attachments.events,
    markets: Object.fromEntries(
      Object.entries(data.attachments.markets).filter(
        ([, m]) => m.competitionId === 12282733 && FD_TYPES[m.marketType],
      ),
    ),
  };
}
export function normalizeFanDuel(catalog, prices) {
  if (!Array.isArray(prices)) throw new Error("FanDuel price schema changed");
  const fresh = new Map(prices.map((m) => [m.marketId, m])),
    games = new Map(),
    quotes = [],
    warnings = [];
  let matched = 0;
  for (const market of Object.values(catalog.markets)) {
    const price = fresh.get(market.marketId);
    // Missing markets are deliberately removed, never refreshed using old discovery odds.
    if (!price) continue;
    if (!Array.isArray(price.runnerDetails))
      throw new Error("FanDuel runner schema changed");
    matched++;
    const event = catalog.events[market.eventId];
    if (!event || !event.name.includes(" @ ")) {
      warnings.push(`Unmatched event ${market.eventId}`);
      continue;
    }
    const [away, home] = event.name.split(" @ ");
    let game;
    try {
      game = makeGame(
        "fanduel",
        event.eventId,
        away,
        home,
        event.openDate,
        price.inplay === true,
      );
    } catch (e) {
      warnings.push(e.message);
      continue;
    }
    if (games.get(game.id)?.live) game.live = true;
    games.set(game.id, game);
    const kind = FD_TYPES[market.marketType];
    for (const runner of price.runnerDetails) {
      const original = market.runners?.find(
        (r) => r.selectionId === runner.selectionId,
      );
      if (!original) {
        warnings.push(`Unknown selection ${runner.selectionId}`);
        continue;
      }
      const side = original.result?.type?.toLowerCase();
      const suspended =
        price.marketStatus !== "OPEN" || runner.runnerStatus !== "ACTIVE";
      try {
        quotes.push(
          makeQuote(
            game,
            kind,
            side,
            runner.handicap,
            runner.winRunnerOdds?.americanDisplayOdds?.americanOddsInt,
            `${market.marketId}:${runner.selectionId}`,
            suspended,
          ),
        );
      } catch (e) {
        warnings.push(e.message);
      }
    }
  }
  if (Object.keys(catalog.markets).length && !matched)
    throw new Error("FanDuel returned no requested markets");
  if (matched && !quotes.length)
    throw new Error("FanDuel returned no valid selections");
  return { games: [...games.values()], quotes, warnings };
}

export class FanDuel {
  constructor(sink, { pollMs = 2000, discoveryMs = 60000 } = {}) {
    this.sink = sink;
    this.pollMs = Math.max(1000, pollMs);
    this.discoveryMs = discoveryMs;
    this.stopped = true;
  }
  start() {
    this.stopped = false;
    void this.tick();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
  async tick() {
    const began = performance.now();
    let delay = this.pollMs;
    try {
      let catalog = this.catalog;
      if (!catalog || Date.now() - this.discoveredAt >= this.discoveryMs) {
        const result = await fetchJson(FD_DISCOVERY, {
          headers: { "X-Sportsbook-Region": "NJ" },
        });
        catalog = selectFanDuelMarkets(result.data);
        this.catalog = catalog;
        this.discoveredAt = Date.now();
      }
      const ids = Object.keys(catalog.markets);
      const result = ids.length
        ? await fetchJson(FD_PRICES, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ marketIds: ids }),
          })
        : { data: [], receivedAt: Date.now(), durationMs: 0, decodedBytes: 0 };
      if (this.stopped) return;
      this.sink.update("fanduel", normalizeFanDuel(catalog, result.data), {
        ...result,
        data: undefined,
        kind: "poll",
        pollMs: this.pollMs,
      });
      this.failures = 0;
      delay = Math.max(0, this.pollMs - (performance.now() - began));
    } catch (error) {
      if (this.stopped) return;
      this.sink.failure("fanduel", error);
      delay = retryDelay(
        (this.failures = (this.failures || 0) + 1),
        error,
        this.pollMs,
      );
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), delay);
  }
}
