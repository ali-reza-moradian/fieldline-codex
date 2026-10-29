import { makeGame, makeQuote } from "../model.js";
import { fetchJson, retryDelay } from "../http.js";
import { FanDuelPush } from "./fanduel-push.js";
import { FanDuelState } from "./fanduel-state.js";
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
export const FD_PRICES =
  "https://smp.on.sportsbook.fanduel.ca/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0";

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
    scheduler = { now: () => performance.now(), setTimeout, clearTimeout } } = {}) {
    this.sink = sink;
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
  interval() { return this.pushReady() ? this.verificationMs : this.pollMs; }
  details() {
    this.sink.details?.("fanduel", {
      region: "Ontario",
      endpoints: { discovery: new URL(FD_DISCOVERY).origin,
        prices: new URL(FD_PRICES).origin },
      transport: this.pushReady() ? "Live push · polling backup" : "Polling fallback · reconnecting live feed",
      pollMs: this.interval(), coverage: this.coverage ?? null,
      channels: { push: { ...this.pushState, verified: this.pushReady(), ordering: { ...this.state.counters } },
        polling: { ...this.pollingCounters, intervalMs: this.interval(), lastSuccessAt: this.lastPollAt ?? null,
          lastCompleteAt: this.lastFullPollAt ?? null, error: this.pollError ?? null },
        discovery: { lastSuccessAt: this.discoveredAt ?? null, error: this.discoveryError ?? null } },
    });
  }
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
    if (this.coverage?.missingIds.length)
      dataset.warnings.push(`FanDuel omitted ${this.coverage.missingIds.length} requested markets; coverage is incomplete`);
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
          const result = await this.fetcher(FD_DISCOVERY, { headers: FD_HEADERS, signal });
          if (this.stopped || runId !== this.runId) return;
          this.catalog = selectFanDuelMarkets(result.data);
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
      const result = await fetchFanDuelPrices(Object.keys(this.catalog.markets), { fetcher: this.fetcher, signal });
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
