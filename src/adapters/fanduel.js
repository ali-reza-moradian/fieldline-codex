import { makeGame, makeQuote } from "../model.js";
import { fetchJson, retryDelay, UpstreamError } from "../http.js";
import { FanDuelPush, discoverFanDuelPushConfig } from "./fanduel-push.js";
import { FanDuelState } from "./fanduel-state.js";
import { LEAGUES } from "../leagues.js";
export { FanDuelState } from "./fanduel-state.js";

export const FD_TYPES = {
  MONEY_LINE: "moneyline",
  "MATCH_HANDICAP_(2-WAY)": "spread",
  "TOTAL_POINTS_(OVER/UNDER)": "total",
};
// Public page configuration, observed in the logged-out NFL page's network requests.
export const FD_REGION = "on";
export const FD_ORIGIN = "https://sportsbook.fanduel.ca";
export const FD_HEADERS = Object.freeze({
  "X-Sportsbook-Region": "ON", Origin: FD_ORIGIN, Referer: `${FD_ORIGIN}/`,
});
export const FD_DISCOVERY =
  "https://sbapi.on.sportsbook.fanduel.ca/api/content-managed-page?page=CUSTOM&customPageId=nfl&pbHorizontal=false&_ak=FhMFpcPWXMeyZxOx&timezone=America%2FToronto";
// Verified from the Ontario football navigation and each league's public page.
// Futures and exhibition/e-football competitions are deliberately excluded.
export const FD_LEAGUES = Object.freeze({
  nfl: Object.freeze({ page: "nfl", competitions: LEAGUES.nfl.fanduel }),
  ncaaf: Object.freeze({ page: "ncaaf", competitions: LEAGUES.ncaaf.fanduel }),
  cfl: Object.freeze({ page: "cfl", competitions: LEAGUES.cfl.fanduel }),
});
export function fanDuelDiscovery(league = "nfl") {
  const config = FD_LEAGUES[league];
  if (!config) throw new Error("Unsupported FanDuel league");
  const url = new URL(FD_DISCOVERY);
  url.searchParams.set("customPageId", config.page);
  return url.href;
}
export const FD_PRICES =
  "https://smp.on.sportsbook.fanduel.ca/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0";

export function selectFanDuelMarkets(data, { league = "nfl" } = {}) {
  const config = FD_LEAGUES[league];
  if (!config) throw new Error("Unsupported FanDuel league");
  if (!data?.attachments?.events || !data?.attachments?.markets)
    throw new Error("FanDuel discovery schema changed");
  return {
    league,
    events: data.attachments.events,
    markets: Object.fromEntries(
      Object.entries(data.attachments.markets).filter(
        ([, m]) => config.competitions.includes(m.competitionId) && FD_TYPES[m.marketType] &&
          data.attachments.events[m.eventId]?.competitionId === m.competitionId,
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
        catalog.league ?? "nfl",
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
        (r) => String(r.selectionId) === String(runner.selectionId),
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
            runner.winRunnerOdds?.americanDisplayOdds?.americanOddsInt ??
              runner.winRunnerOdds?.americanDisplayOdds?.americanOdds,
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

export async function fetchFanDuelPrices(ids, { fetcher = fetchJson, signal, batchSize = 70, concurrency = 2 } = {}) {
  if (batchSize < 1 || batchSize > 70 || !Number.isInteger(batchSize)) throw new Error("FanDuel price batches must contain 1–70 markets");
  const requested = [...new Set(ids)], batches = [];
  for (let i = 0; i < requested.length; i += batchSize) batches.push(requested.slice(i, i + batchSize));
  const began = performance.now(), results = new Array(batches.length);
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000), ...(signal ? [signal] : [])]);
  let index = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(Math.max(1, Math.min(2, concurrency)), batches.length) }, async () => {
    try { while (index < batches.length) {
      requestSignal.throwIfAborted();
      const slot = index++, batch = batches[slot];
      const result = await fetcher(FD_PRICES, {
        method: "POST", headers: { ...FD_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ marketIds: batch }), signal: requestSignal,
      });
      if (!Array.isArray(result.data) || result.data.some(m => !m || !batch.includes(m.marketId) || !Array.isArray(m.runnerDetails)))
        throw new Error("FanDuel price response does not match the requested markets");
      if (new Set(result.data.map(m => m.marketId)).size !== result.data.length)
        throw new Error("FanDuel price response contains duplicate markets");
      results[slot] = result;
    } } catch (error) { controller.abort(error); throw error; }
  }));
  const failed = workers.find(result => result.status === "rejected");
  if (failed) throw controller.signal.reason ?? failed.reason;
  const data = results.flatMap(r => r.data), returned = new Set(data.map(m => m.marketId));
  return { data, receivedAt: Math.max(Date.now(), ...results.map(r => r.receivedAt)),
    durationMs: performance.now() - began,
    decodedBytes: results.reduce((n, r) => n + (r.decodedBytes ?? 0), 0),
    coverage: { requested: requested.length, returned: returned.size, batches: batches.length,
      missingIds: requested.filter(id => !returned.has(id)) } };
}

export class FanDuel {
  constructor(sink, { pollMs = process.env.FD_POLL_MS ?? 250, verificationMs = pollMs, discoveryMs = 60000,
    fetcher = fetchJson, pushFactory = options => new FanDuelPush(options),
    clock = Date.now, pushOptions = {}, reconcileMaxAgeMs = 30000,
    league = "nfl", priceConcurrency = 2, livePollMs = null,
    scheduler = { now: () => performance.now(), setTimeout, clearTimeout } } = {}) {
    this.sink = sink;
    this.league = league;
    this.discoveryUrl = fanDuelDiscovery(league);
    this.priceConcurrency = priceConcurrency;
    if (livePollMs != null && (!Number.isFinite(Number(livePollMs)) || Number(livePollMs) < 250))
      throw new Error("FanDuel live poll interval must be at least 250ms");
    this.livePollMs = livePollMs == null ? null : Number(livePollMs);
    if (!Number.isFinite(Number(pollMs)) || !Number.isFinite(Number(verificationMs)))
      throw new Error("FanDuel poll intervals must be finite milliseconds");
    // Four complete cycles/second at most during regular successful polling.
    // Longer intervals remain available to reduce traffic; failures retain the
    // previous one-second minimum backoff independently of the success cadence.
    this.pollMs = Math.max(250, Number(pollMs));
    this.verificationMs = Math.max(this.pollMs, Number(verificationMs));
    this.reconcileMaxAgeMs = Math.max(this.verificationMs, reconcileMaxAgeMs);
    this.discoveryMs = discoveryMs;
    this.fetcher = fetcher;
    this.clock = clock;
    this.scheduler = scheduler;
    this.state = new FanDuelState({ now: clock });
    this.pushState = { status: "disconnected", generation: 0, subscribedMarkets: 0 };
    this.push = pushFactory({ ...pushOptions, region: FD_REGION,
      onMarkets: (markets, timing) => this.onPushMarkets(markets, timing),
      onState: state => this.onPushState(state) });
    this.nextAllowedPollAt = 0;
    this.nextDiscoveryAt = 0;
    this.stopped = true;
  }
  start() {
    if (!this.stopped) return;
    this.runId = (this.runId ?? 0) + 1;
    this.stopped = false;
    this.controller = new AbortController();
    this.verifiedEpoch = null;
    this.pushEpoch = null;
    this.hasBaseline = false;
    this.hasLiveGames = false;
    this.lastFullPollAt = null;
    this.lastPollAt = null;
    this.catalog = null;
    this.nextDiscoveryAt = 0;
    this.discoveryRetryAt = 0;
    this.nextAllowedPollAt = 0;
    this.timerAt = null;
    this.pendingTickAt = null;
    this.pollingCounters = { cyclesStarted: 0, successfulCycles: 0, failedCycles: 0,
      partialCycles: 0, rateLimitedCycles: 0, lastFailureAt: null, lastFailureStatus: null };
    this.state = new FanDuelState({ now: this.clock });
    this.sink.details?.("fanduel", { status: "connecting", lastConfirmedAt: null, error: null });
    this.push.start();
    void this.tick();
  }
  stop() {
    this.stopped = true;
    this.runId = (this.runId ?? 0) + 1;
    this.controller?.abort();
    this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = null;
    this.inFlight = null;
    this.pendingTickAt = null;
    this.push.stop();
  }
  pushReady() {
    return this.hasBaseline && this.pushState.status === "subscribed" &&
      this.verifiedEpoch === this.pushEpoch &&
      this.pushState.subscribedMarkets === Object.keys(this.catalog?.markets ?? {}).length &&
      this.lastFullPollAt != null && this.clock() - this.lastFullPollAt < this.reconcileMaxAgeMs &&
      this.clock() - (this.pushState.lastConfirmedAt ?? 0) < 12000;
  }
  interval() {
    const normal = this.pushReady() ? this.verificationMs : this.pollMs;
    return this.hasLiveGames && this.livePollMs != null ? Math.min(normal, this.livePollMs) : normal;
  }
  sourceDetails() {
    return {
      region: "Ontario",
      league: this.league,
      endpoints: { discovery: new URL(FD_DISCOVERY).origin,
        prices: new URL(FD_PRICES).origin },
      transport: this.pushReady() ? "Live push · polling backup" : "Polling fallback · reconnecting live feed",
      pollMs: this.interval(), coverage: this.coverage ?? null,
      channels: { push: { ...this.pushState, verified: this.pushReady(), ordering: { ...this.state.counters } },
        polling: { ...this.pollingCounters, intervalMs: this.interval(), lastSuccessAt: this.lastPollAt ?? null,
          lastCompleteAt: this.lastFullPollAt ?? null, error: this.pollError ?? null },
        discovery: { lastSuccessAt: this.discoveredAt ?? null, error: this.discoveryError ?? null } },
    };
  }
  details() { this.sink.details?.("fanduel", this.sourceDetails()); }
  queueTick(delay = 0) {
    if (this.stopped) return;
    const now = this.clock();
    let at = Math.max(now + delay, this.nextAllowedPollAt);
    if (this.inFlight) { this.pendingTickAt = Math.min(this.pendingTickAt ?? Infinity, at); return; }
    // Discovery has its own deadline. A request to check it later must never
    // postpone an already scheduled price poll; rate-limit deadlines still win.
    at = Math.max(this.nextAllowedPollAt, Math.min(at, this.timerAt ?? Infinity));
    if (this.timer != null && at === this.timerAt) return;
    this.scheduler.clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = this.scheduler.setTimeout(() => { this.timer = null; this.timerAt = null; void this.tick(); },
      Math.max(at - now, 0));
  }
  onPushState(state) {
    if (this.stopped) return;
    const wasReady = this.pushReady();
    this.pushState = state;
    if (state.status === "subscribed") {
      const epoch = `${state.generation}:${Object.keys(this.catalog?.markets ?? {}).sort().join(",")}`;
      if (epoch !== this.pushEpoch) {
        this.pushEpoch = epoch;
        this.requiredBaselineAt = this.clock();
        this.queueTick();
      }
      if (this.pushReady()) this.sink.confirm?.("fanduel");
      else if (this.lastFullPollAt != null && this.clock() - this.lastFullPollAt >= this.reconcileMaxAgeMs) {
        this.sink.failure("fanduel", new Error("FanDuel full-board verification expired; retrying prices"));
        this.queueTick();
      }
    } else {
      this.verifiedEpoch = null;
      if (wasReady) this.queueTick();
    }
    this.details();
  }
  onPushMarkets(markets, timing) {
    if (this.stopped || !this.catalog || timing.generation !== this.pushState.generation) return;
    try {
      const result = this.state.applyPush(markets, timing, this.catalog);
      if (result.unknown) {
        this.verifiedEpoch = null;
        this.nextDiscoveryAt = Math.max(this.discoveryRetryAt,
          Math.min(this.nextDiscoveryAt,
            Math.max(this.clock() + 1000, (this.discoveredAt ?? 0) + 10000)));
        this.queueTick(Math.max(0, this.nextDiscoveryAt - this.clock()));
      }
      if (result.accepted && this.hasBaseline &&
          (this.pushReady() || this.clock() - this.lastPollAt < 10000))
        this.publish({ ...timing, kind: "push", pollMs: this.interval() });
      this.details();
    } catch (error) {
      this.verifiedEpoch = null;
      this.pushState = { ...this.pushState, error: error.message };
      this.queueTick(); this.details();
    }
  }
  publish(timing) {
    const dataset = normalizeFanDuel(this.catalog, this.state.values());
    this.hasLiveGames = dataset.games.some(game => game.live);
    if (this.coverage?.missingIds.length)
      dataset.warnings.push(`FanDuel omitted ${this.coverage.missingIds.length} requested markets; coverage is incomplete`);
    // Coverage and price changes must travel in the same publication. A later
    // details frame must not briefly certify a partial reply using an old lease.
    dataset.source = this.sourceDetails();
    this.sink.update("fanduel", dataset, timing);
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (this.clock() < this.nextAllowedPollAt) { this.queueTick(); return Promise.resolve(); }
    this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = null;
    const runId = this.runId;
    const task = this.runTick(runId).finally(() => {
      if (this.inFlight !== task) return;
      this.inFlight = null;
      if (this.stopped || runId !== this.runId) return;
      const delay = Math.min(this.nextDelay,
        this.pendingTickAt != null ? Math.max(0, this.pendingTickAt - this.clock()) : Infinity);
      this.pendingTickAt = null;
      this.queueTick(delay);
    });
    this.inFlight = task;
    return this.inFlight;
  }
  async runTick(runId) {
    const began = this.scheduler.now();
    // A cycle includes optional discovery and the complete group of price
    // requests. Any error classifies it as failed, including discovery errors
    // recovered using the current catalogue; a cycle is counted only once.
    this.pollingCounters.cyclesStarted++;
    let cycleFailed = false, cycleRateLimited = false;
    const recordFailure = error => {
      if (!cycleFailed) this.pollingCounters.failedCycles++;
      cycleFailed = true;
      if (error?.status === 429 && !cycleRateLimited) {
        this.pollingCounters.rateLimitedCycles++;
        cycleRateLimited = true;
      }
      this.pollingCounters.lastFailureAt = this.clock();
      this.pollingCounters.lastFailureStatus = Number(error?.status) || null;
    };
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)]);
    try {
      if (!this.catalog || this.clock() >= this.nextDiscoveryAt) {
        try {
          const result = await this.fetcher(this.discoveryUrl, { headers: FD_HEADERS, signal });
          if (this.stopped || runId !== this.runId) return;
          this.catalog = selectFanDuelMarkets(result.data, { league: this.league });
          this.discoveredAt = this.clock();
          this.nextDiscoveryAt = this.clock() + this.discoveryMs;
          this.discoveryRetryAt = 0;
          this.discoveryError = null;
          this.state.prune(this.catalog);
          this.push.setMarketIds(Object.keys(this.catalog.markets));
        } catch (error) {
          if (this.stopped || runId !== this.runId) return;
          recordFailure(error);
          this.discoveryError = error.message;
          this.discoveryRetryAt = this.clock() + Math.max(10000, retryDelay(1, error, 10000));
          this.nextDiscoveryAt = this.discoveryRetryAt;
          if (!this.catalog) throw error;
        }
      }
      const token = this.state.beginPoll();
      const result = await fetchFanDuelPrices(Object.keys(this.catalog.markets), {
        fetcher: this.fetcher, signal, concurrency: this.priceConcurrency,
      });
      if (this.stopped || runId !== this.runId) return;
      // Validate the complete HTTP response before replacing any working state.
      normalizeFanDuel(this.catalog, result.data);
      this.state.applyPoll(result.data, token, { catalog: this.catalog });
      this.coverage = result.coverage;
      this.hasBaseline = true;
      this.lastPollAt = this.clock();
      this.pollError = null;
      if (!result.coverage.missingIds.length) {
        this.lastFullPollAt = this.clock();
        if (this.pushState.status === "subscribed" && token.startedAt >= this.requiredBaselineAt)
          this.verifiedEpoch = this.pushEpoch;
      } else this.verifiedEpoch = null;
      this.publish({ ...result, data: undefined, kind: "poll", pollMs: this.interval() });
      if (!cycleFailed) {
        if (result.coverage.missingIds.length) this.pollingCounters.partialCycles++;
        else this.pollingCounters.successfulCycles++;
      }
      this.failures = 0;
      this.nextAllowedPollAt = 0;
      // Start-to-start pacing, with no overlap or accumulated catch-up cycles.
      this.nextDelay = Math.max(0, this.interval() - (this.scheduler.now() - began));
      this.details();
    } catch (error) {
      if (this.stopped || runId !== this.runId) return;
      recordFailure(error);
      this.pollError = error.message;
      if (!this.pushReady()) this.sink.failure("fanduel", error);
      this.nextDelay = Math.max(
        retryDelay(this.failures = (this.failures || 0) + 1, error, Math.max(1000, this.pollMs)),
        this.catalog ? 0 : this.discoveryRetryAt - this.clock(),
      );
      this.nextAllowedPollAt = this.clock() + this.nextDelay;
      this.details();
    }
  }
}

// Keep lower-priority league requests off the NFL's verification path. At most
// one extra-league HTTP request runs at once; aborting a queued generation
// removes it immediately. Each child still owns its own complete poll cycle.
function serialFetcher(fetcher) {
  const queue = [];
  let active = false;
  const drain = () => {
    if (active) return;
    const job = queue.shift();
    if (!job) return;
    job.signal?.removeEventListener("abort", job.abort);
    if (job.signal?.aborted) { job.reject(job.signal.reason); drain(); return; }
    active = true;
    Promise.resolve().then(() => fetcher(job.url, job.options)).then(job.resolve, job.reject)
      .finally(() => { active = false; drain(); });
  };
  return (url, options = {}) => new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    const job = { url, options, resolve, reject, signal };
    job.abort = () => {
      const index = queue.indexOf(job);
      if (index >= 0) { queue.splice(index, 1); reject(signal.reason); }
    };
    signal?.addEventListener("abort", job.abort, { once: true });
    queue.push(job); drain();
  });
}

/** Separate complete baselines, freshness clocks and retry budgets per league.
 * The store receives the union, but an NFL poll never refreshes college/CFL.
 * dataset.source is an atomic source patch consumed by OddsStore.update.
 */
export class FanDuelLeagues {
  constructor(sink, { leagues = ["nfl", "ncaaf", "cfl"], fetcher = fetchJson,
    collectorFactory = (target, options) => new FanDuel(target, options),
    clock = Date.now, extraPollMs = 2000, extraLivePollMs = 1000,
    ...options } = {}) {
    if (!leagues.length || new Set(leagues).size !== leagues.length || leagues.some(league => !FD_LEAGUES[league]))
      throw new Error("FanDuel requires distinct supported leagues");
    this.sink = sink; this.clock = clock; this.leagues = [...leagues];
    this.stopped = true;
    this.datasets = new Map();
    this.sources = new Map(leagues.map(league => [league, {
      book: "fanduel", league, region: "Ontario", status: "connecting", error: null,
      lastConfirmedAt: null, lastDataAt: null, lastChangeAt: null, staleAfterMs: 10000,
      warnings: [], games: 0, quotes: 0, updates: 0, priceChanges: 0,
    }]));
    this.rateLimits = new Map();
    const limitedFetcher = async (url, request) => {
      const parsed = new URL(url), key = parsed.origin + parsed.pathname;
      const remaining = (this.rateLimits.get(key) ?? 0) - this.clock();
      if (remaining > 0) throw new UpstreamError("FanDuel shared endpoint Retry-After is active", 429, remaining);
      try { return await fetcher(url, request); }
      catch (error) {
        if (error?.status === 429) this.rateLimits.set(key, Math.max(this.rateLimits.get(key) ?? 0,
          this.clock() + Math.max(1000, error.retryAfterMs || 0)));
        throw error;
      }
    };
    const extraFetcher = serialFetcher(limitedFetcher);
    // All leagues use the same public Ontario subscription configuration.
    // Coalesce simultaneous bundle reads without retaining expired auth data.
    const configFetcher = options.pushOptions?.fetchConfig ?? discoverFanDuelPushConfig;
    const sharedConfig = args => {
      if (!this.configRead) {
        const request = configFetcher({ ...args, signal: this.configController.signal });
        this.configRead = request;
        request.finally(() => { if (this.configRead === request) this.configRead = null; }).catch(() => {});
      }
      return this.configRead;
    };
    this.collectors = new Map(leagues.map(league => {
      const target = {
        update: (book, dataset, timing) => { if (!this.stopped) this.update(league, dataset, timing); },
        details: (book, patch) => { if (!this.stopped) { Object.assign(this.sources.get(league), patch); this.details(); } },
        confirm: () => {
          if (this.stopped) return;
          const source = this.sources.get(league);
          if (source.status !== "healthy") return;
          source.lastConfirmedAt = this.clock(); this.details();
        },
        failure: (book, error) => {
          if (this.stopped) return;
          Object.assign(this.sources.get(league), { status: "stale", error: error.message, lastErrorAt: this.clock() });
          this.details();
        },
      };
      return [league, collectorFactory(target, {
        ...options, league, clock,
        pushOptions: { ...options.pushOptions, fetchConfig: sharedConfig },
        ...(league === "nfl" ? { fetcher: limitedFetcher } : {
          fetcher: extraFetcher, pollMs: extraPollMs, verificationMs: extraPollMs,
          livePollMs: extraLivePollMs, priceConcurrency: 1,
        }),
      })];
    }));
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.configController = new AbortController();
    this.configRead = null;
    this.datasets.clear();
    for (const source of this.sources.values()) Object.assign(source, {
      status: "connecting", error: null, lastConfirmedAt: null, lastDataAt: null,
      lastChangeAt: null, games: 0, quotes: 0, warnings: [], updates: 0, priceChanges: 0,
    });
    this.details();
    for (const collector of this.collectors.values()) collector.start();
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.configController?.abort();
    for (const collector of this.collectors.values()) collector.stop();
  }
  source() {
    const now = this.clock();
    const leagues = Object.fromEntries([...this.sources].map(([league, source]) => [league, {
      ...source,
      status: source.status === "healthy" && (source.lastConfirmedAt == null || now - source.lastConfirmedAt >= source.staleAfterMs)
        ? "stale" : source.status,
    }]));
    const rows = Object.values(leagues), healthy = rows.every(row => row.status === "healthy");
    const oldest = key => rows.every(row => row[key] != null) ? Math.min(...rows.map(row => row[key])) : null;
    const total = key => rows.reduce((sum, row) => sum + (row[key] ?? 0), 0);
    const nfl = leagues.nfl ?? rows[0];
    const polling = rows.map(row => row.channels?.polling ?? {});
    const pushes = rows.map(row => row.channels?.push ?? {});
    const sum = (values, key) => values.reduce((n, row) => n + (Number.isFinite(row[key]) ? row[key] : 0), 0);
    const oldestOf = (values, key) => values.every(row => Number.isFinite(row[key])) ? Math.min(...values.map(row => row[key])) : null;
    const coverage = rows.every(row => row.coverage) ? {
      requested: sum(rows.map(row => row.coverage), "requested"),
      returned: sum(rows.map(row => row.coverage), "returned"),
      batches: sum(rows.map(row => row.coverage), "batches"),
      missingIds: rows.flatMap(row => row.coverage.missingIds ?? []),
    } : null;
    return {
      ...nfl, book: "fanduel", league: undefined, leagues,
      status: healthy ? "healthy" : rows.some(row => row.status === "stale") ? "stale" : "connecting",
      lastConfirmedAt: oldest("lastConfirmedAt"), lastDataAt: oldest("lastDataAt"),
      lastChangeAt: Math.max(0, ...rows.map(row => row.lastChangeAt ?? 0)) || null,
      games: total("games"), quotes: total("quotes"), updates: total("updates"), priceChanges: total("priceChanges"),
      error: healthy ? null : rows.filter(row => row.status !== "healthy").map(row => `${row.league}: ${row.error ?? row.status}`).join("; "),
      warnings: rows.flatMap(row => (row.warnings ?? []).map(warning => `${row.league}: ${warning}`)),
      region: "Ontario",
      pollMs: null, coverage,
      transport: "Live push with independent league verification",
      channels: {
        push: { status: pushes.every(row => row.status === "subscribed") ? "subscribed" : "partial",
          verified: pushes.every(row => row.verified === true), subscribedMarkets: sum(pushes, "subscribedMarkets"),
          lastConfirmedAt: oldestOf(pushes, "lastConfirmedAt"), region: FD_REGION, origin: FD_ORIGIN,
          endpoint: "https://pir.on.sportsbook.fanduel.ca/graphql", leagueCount: rows.length },
        polling: { ...Object.fromEntries(["cyclesStarted", "successfulCycles", "failedCycles", "partialCycles", "rateLimitedCycles"]
          .map(key => [key, sum(polling, key)])), intervalMs: null,
          lastSuccessAt: oldestOf(polling, "lastSuccessAt"), lastCompleteAt: oldestOf(polling, "lastCompleteAt"),
          error: polling.map(row => row.error).filter(Boolean).join("; ") || null },
        discovery: { lastSuccessAt: oldestOf(rows.map(row => row.channels?.discovery ?? {}), "lastSuccessAt"),
          error: rows.map(row => row.channels?.discovery?.error).filter(Boolean).join("; ") || null },
      },
    };
  }
  details() { this.sink.details?.("fanduel", this.source()); }
  update(league, dataset, timing) {
    const source = this.sources.get(league), now = this.clock();
    if (dataset.games.some(game => (game.league ?? "nfl") !== league))
      throw new Error("FanDuel league collector returned a different competition");
    const previous = new Map((this.datasets.get(league)?.quotes ?? []).map(quote =>
      [`${quote.gameId}:${quote.market}:${quote.side}`, quote]));
    const changed = dataset.quotes.filter(quote => {
      const old = previous.get(`${quote.gameId}:${quote.market}:${quote.side}`);
      return old && (old.american !== quote.american || old.line !== quote.line || old.suspended !== quote.suspended);
    }).length;
    this.datasets.set(league, dataset);
    Object.assign(source, {
      ...dataset.source,
      status: "healthy", lastConfirmedAt: now, lastDataAt: timing.receivedAt,
      lastChangeAt: changed ? now : source.lastChangeAt, error: null,
      warnings: dataset.warnings ?? [], games: dataset.games.length, quotes: dataset.quotes.length,
      updates: source.updates + 1, priceChanges: source.priceChanges + changed,
      requestMs: timing.durationMs ?? source.requestMs ?? null, decodedBytes: timing.decodedBytes,
      pollMs: timing.pollMs ?? source.pollMs ?? null,
    });
    const datasets = [...this.datasets.values()];
    this.sink.update("fanduel", {
      games: datasets.flatMap(row => row.games), quotes: datasets.flatMap(row => row.quotes),
      warnings: datasets.flatMap(row => row.warnings ?? []), source: this.source(),
    }, { ...timing, league });
  }
}
