import { fetchJson, UpstreamError } from "../http.js";
import { fetchCurlJsonBatch } from "../curl-batch-http.js";
import { DK_HEADERS } from "../adapters/draftkings.js";
import { FD_HEADERS, fetchFanDuelPrices } from "../adapters/fanduel.js";
import { DK_EXTRA_CATEGORIES, EXTRA_KINDS, EXTRAS_RULES_NOTE, validateExtraGame,
  normalizeDraftKingsExtras, selectFanDuelExtras, normalizeFanDuelExtras, finalizeExtraRows } from "./normalize.js";
export { DK_EXTRA_CATEGORIES, EXTRA_KINDS } from "./normalize.js";

export function draftKingsExtrasUrl(game, category) {
  validateExtraGame(game);
  if (!DK_EXTRA_CATEGORIES.some(c => c.id === category.id)) throw new UpstreamError("Unsupported extras category");
  const url = new URL("https://sportsbook-nash.draftkings.com/sites/CA-ON-SB/api/sportscontent/controldata/event/eventSubcategory/v1/markets");
  url.search = new URLSearchParams({ isBatchable: "false", templateVars: `${game.sourceId},${category.id}`, entity: "markets",
    marketsQuery: `$filter=eventId eq '${game.sourceId}' AND clientMetadata/subCategoryId eq '${category.id}' AND tags/all(t: t ne 'SportcastBetBuilder')` });
  return url.href;
}

export function fanDuelExtrasUrl(game) {
  validateExtraGame(game);
  const url = new URL("https://sbapi.on.sportsbook.fanduel.ca/api/event-page");
  url.search = new URLSearchParams({ _ak: "FhMFpcPWXMeyZxOx", eventId: String(game.sourceId), tab: "popular", timezone: "America/Toronto" });
  return url.href;
}

function boundedSignal(signal) {
  const timeout = AbortSignal.timeout(30000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
export function draftKingsExtrasUsesCurl() {
  return (process.env.DK_HTTP_TRANSPORT ?? (process.env.RENDER === "true" ? "curl" : "native")) === "curl";
}

// No mutable price state is kept here. The caller publishes a complete snapshot
// only if its request generation still owns the event. Failure leaves no partial
// object that could accidentally refresh a previous price's observation time.
export async function fetchDraftKingsExtras(game, { signal, fetcher, batchFetcher, batchClient } = {}) {
  validateExtraGame(game);
  const began = performance.now(), requestStartedAt = Date.now(), snapshots = [], categories = {}, joinedSignal = boundedSignal(signal);
  let decodedBytes = 0, markets = 0;
  const consume = (category, response) => {
    const parsed = normalizeDraftKingsExtras(response.data, game, category, response.receivedAt);
    snapshots.push({ rows: parsed.rows, observedAt: response.receivedAt });
    categories[category.kind] = { markets: parsed.markets, rows: parsed.rows.length, observedAt: response.receivedAt };
    markets += parsed.markets;
    decodedBytes += response.decodedBytes ?? 0;
  };
  const batch = batchFetcher ?? (!fetcher && draftKingsExtrasUsesCurl() ?
    (batchClient ? batchClient.fetch.bind(batchClient) : fetchCurlJsonBatch) : null);
  if (batch) {
    joinedSignal.throwIfAborted();
    const requests = DK_EXTRA_CATEGORIES.map(category => ({ id: category.id, url: draftKingsExtrasUrl(game, category) }));
    const responses = await batch(requests, { headers: DK_HEADERS, signal: joinedSignal });
    if (!Array.isArray(responses) || responses.length !== requests.length ||
        responses.some((response, i) => response?.id !== requests[i].id))
      throw new UpstreamError("DraftKings extras batch category coverage is incomplete or reordered");
    joinedSignal.throwIfAborted();
    for (let i = 0; i < responses.length; i++) consume(DK_EXTRA_CATEGORIES[i], responses[i]);
  } else {
    for (const category of DK_EXTRA_CATEGORIES) {
      joinedSignal.throwIfAborted();
      const response = await (fetcher ?? fetchJson)(draftKingsExtrasUrl(game, category), { headers: DK_HEADERS, signal: joinedSignal });
      consume(category, response);
    }
  }
  joinedSignal.throwIfAborted();
  const final = finalizeExtraRows(snapshots.flatMap(snapshot => snapshot.rows));
  return { book: "draftkings", gameId: game.id, region: "Ontario", requestStartedAt,
    observedAt: Math.min(...snapshots.map(s => s.observedAt)), rows: final.rows,
    coverage: { complete: !final.quarantinedPlayers, categories, markets, rows: final.rows.length },
    warnings: final.warnings, rulesNote: EXTRAS_RULES_NOTE,
    durationMs: performance.now() - began, decodedBytes };
}

export async function fetchFanDuelExtras(game, { signal, fetcher = fetchJson, catalog = null, catalogTtlMs = 60000 } = {}) {
  validateExtraGame(game);
  const began = performance.now(), requestStartedAt = Date.now(), joinedSignal = boundedSignal(signal);
  let decodedBytes = 0, nextCatalog = catalog, refreshed = false;
  const discover = async () => {
    const response = await fetcher(fanDuelExtrasUrl(game), { headers: FD_HEADERS, signal: joinedSignal });
    decodedBytes += response.decodedBytes ?? 0;
    nextCatalog = selectFanDuelExtras(response.data, game, response.receivedAt);
    refreshed = true;
  };
  if (nextCatalog?.gameId !== game.id || nextCatalog?.sourceId !== String(game.sourceId) ||
      !(nextCatalog?.markets instanceof Map) || !Number.isFinite(nextCatalog.observedAt) ||
      requestStartedAt < nextCatalog.observedAt || requestStartedAt - nextCatalog.observedAt >= Math.min(60000, Math.max(0, catalogTtlMs))) await discover();
  let parsed, priceResponse;
  for (let attempt = 0; attempt < 2; attempt++) {
    joinedSignal.throwIfAborted();
    const priceTimes = [];
    const timedFetcher = async (...args) => {
      const response = await fetcher(...args);
      if (!Number.isFinite(response.receivedAt) || response.receivedAt <= 0) throw new UpstreamError("FanDuel extras has no observation time");
      priceTimes.push(response.receivedAt);
      return response;
    };
    priceResponse = await fetchFanDuelPrices([...nextCatalog.markets.keys()], { fetcher: timedFetcher, signal: joinedSignal, batchSize: 70, concurrency: 1 });
    // A multi-batch snapshot is only as fresh as its oldest confirmation.
    priceResponse.receivedAt = priceTimes.length ? Math.min(...priceTimes) : nextCatalog.observedAt;
    decodedBytes += priceResponse.decodedBytes ?? 0;
    try {
      parsed = normalizeFanDuelExtras(nextCatalog, priceResponse.data, game, priceResponse.receivedAt);
      if (parsed.coverage.complete) break;
      if (refreshed) throw new UpstreamError("FanDuel extras price response is incomplete");
    } catch (error) {
      if (refreshed || !(error instanceof UpstreamError)) throw error;
    }
    await discover();
  }
  joinedSignal.throwIfAborted();
  if (!parsed?.coverage.complete) throw new UpstreamError("FanDuel extras price response is incomplete");
  const final = finalizeExtraRows(parsed.rows);
  const categories = Object.fromEntries(EXTRA_KINDS.map(kind => [kind, { rows: final.rows.filter(row => row.kind === kind).length, observedAt: priceResponse.receivedAt }]));
  return { book: "fanduel", gameId: game.id, region: "Ontario", requestStartedAt, observedAt: priceResponse.receivedAt,
    rows: final.rows, coverage: { ...parsed.coverage, complete: !final.quarantinedPlayers, categories, rows: final.rows.length },
    warnings: final.warnings, rulesNote: EXTRAS_RULES_NOTE, durationMs: performance.now() - began, decodedBytes,
    // Worker-only cache: do not serialize the catalog into the public response.
    catalog: nextCatalog };
}
