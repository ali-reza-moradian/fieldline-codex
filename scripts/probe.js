import {
  fetchDraftKingsSnapshot,
  DraftKingsState,
} from "../src/adapters/draftkings.js";
import {
  FD_DISCOVERY,
  fetchFanDuelPrices,
  selectFanDuelMarkets,
  normalizeFanDuel,
} from "../src/adapters/fanduel.js";
import { fetchJson } from "../src/http.js";

const results = await Promise.allSettled([
  (async () => {
    const r = await fetchDraftKingsSnapshot();
    const s = new DraftKingsState();
    s.replace(r.data);
    return { book: "draftkings", ...s.normalize(), requestMs: r.durationMs };
  })(),
  (async () => {
    const r = await fetchJson(FD_DISCOVERY, {
      headers: { "X-Sportsbook-Region": "NJ" },
    });
    const c = selectFanDuelMarkets(r.data);
    const p = await fetchFanDuelPrices(Object.keys(c.markets));
    return {
      book: "fanduel",
      ...normalizeFanDuel(c, p.data),
      requestMs: p.durationMs,
      coverage: p.coverage,
    };
  })(),
]);
for (const result of results) {
  if (result.status === "fulfilled") {
    const r = result.value;
    console.log(
      JSON.stringify({
        book: r.book,
        games: r.games.length,
        quotes: r.quotes.length,
        warnings: r.warnings,
        requestMs: r.requestMs,
        coverage: r.coverage,
      }),
    );
  } else {
    console.error(result.reason.message);
    process.exitCode = 1;
  }
}
