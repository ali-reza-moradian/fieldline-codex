import {
  fetchDraftKingsSnapshot,
  DraftKingsState,
} from "../src/adapters/draftkings.js";
import {
  FD_DISCOVERY,
  FD_PRICES,
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
    const p = await fetchJson(FD_PRICES, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketIds: Object.keys(c.markets) }),
    });
    return {
      book: "fanduel",
      ...normalizeFanDuel(c, p.data),
      requestMs: p.durationMs,
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
      }),
    );
  } else {
    console.error(result.reason.message);
    process.exitCode = 1;
  }
}
