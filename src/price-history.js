import { BOOKS, decimalOdds } from "./model.js";
import { isSourceFresh } from "./analytics.js";
import { sourceForLeague } from "./league-view.js";

const HOUR = 3600000;
const SIDES = { moneyline: ["away", "home"], spread: ["away", "home"], total: ["over", "under"] };
const string = value => typeof value === "string" && value.length > 0 && value.length <= 256;
const stamp = value => Number.isFinite(value) && value > 0;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value, min, max, name) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`Invalid ${name}`);
  return value;
};
const sourceCopy = source => source && ({ status: source.status, lastConfirmedAt: source.lastConfirmedAt,
  staleAfterMs: source.staleAfterMs, coverage: source.coverage && { requested: source.coverage.requested,
    returned: source.coverage.returned, missingIds: [...(source.coverage.missingIds ?? [])] },
  ...(source.leagues ? { leagues: Object.fromEntries(Object.entries(source.leagues).map(([league, s]) => [league, sourceCopy(s)])) } : {}) });
const gameLeague = game => game?.league ?? (/^(ncaaf|cfl):/.exec(game?.id ?? '')?.[1]) ?? 'nfl';
const freshForGame = (source, game, at) => isSourceFresh(sourceForLeague(source, gameLeague(game)), at);
const metadata = (q, gameId = q?.gameId, defaultSettlement = "including_overtime") => {
  const settlement = q?.settlement ?? defaultSettlement;
  if (!q || !BOOKS.includes(q.book) || !string(gameId) || q.period !== "full_game" ||
      !Object.hasOwn(SIDES, q.market) || !SIDES[q.market].includes(q.side) || !["including_overtime", "regulation"].includes(settlement)) return null;
  return { book: q.book, gameId, period: q.period, settlement, market: q.market, side: q.side };
};
const keyOf = m => JSON.stringify([m.book, m.gameId, m.period, m.settlement, m.market, m.side]);
const price = q => Number.isFinite(q?.american) && Math.abs(q.american) >= 100 && decimalOdds(q.american) > 1 &&
  (q.market === "moneyline" ? q.line == null : Number.isFinite(q.line));

/** Server observations, not reconstructed provider history. The message listener
 * only queues references to immutable store publications; bounded setImmediate
 * turns do chart work after the live fanout. Persistence is an explicit caller
 * action, never an await in the collector path. */
export class PriceHistory {
  constructor({ now = Date.now, retentionMs = 48 * HOUR, maxSeries = 1024, maxPointsPerSeries = 3000,
    maxTotalPoints = 150000, maxPending = 512, batchSize = 32,
    schedule = callback => setImmediate(callback), cancel = handle => clearImmediate(handle) } = {}) {
    integer(retentionMs, 60000, 72 * HOUR, "retentionMs");
    integer(maxSeries, 1, 4096, "maxSeries"); integer(maxPointsPerSeries, 2, 10000, "maxPointsPerSeries");
    integer(maxTotalPoints, 2, 500000, "maxTotalPoints"); integer(maxPending, 1, 4096, "maxPending");
    integer(batchSize, 1, 256, "batchSize");
    Object.assign(this, { now, retentionMs, maxSeries, maxPointsPerSeries, maxTotalPoints, maxPending, batchSize, schedule, cancel });
    this.series = new Map(); this.games = new Map(); this.sources = {}; this.pending = []; this.scheduled = null;
    this.totalPoints = 0; this.lastProcessedAt = 0; this.nextPruneAt = 0; this.store = null; this.listener = null;
    this.counters = { queueOverflows: 0, clockRollbacks: 0, evictedSeries: 0, evictedPoints: 0, invalidImports: 0 };
  }

  attach(store) {
    if (this.store) throw new Error("Price history is already attached");
    if (!store?.on || !store?.off || !store?.snapshot) throw new TypeError("Invalid odds store");
    this.store = store;
    this.listener = message => {
      const at = this.now();
      if (!stamp(at)) return;
      if (this.pending.length >= this.maxPending) {
        this.counters.queueOverflows++; this.pending = [];
        this.enqueue({ type: "snapshot", data: this.capture(), at, discontinuity: "history queue overflow" });
      } else this.enqueue({ ...message, at });
    };
    store.on("message", this.listener);
    this.enqueue({ type: "snapshot", data: this.capture(), at: this.now(), discontinuity: "collector attached" });
    return () => this.detach();
  }

  capture() {
    const snapshot = this.store.snapshot();
    return { games: snapshot.games, sources: Object.fromEntries(Object.entries(snapshot.sources).map(([book, s]) => [book, sourceCopy(s)])) };
  }

  enqueue(packet) {
    this.pending.push(packet);
    if (this.scheduled === null) this.scheduled = this.schedule(() => { this.scheduled = null; this.flush(); });
  }

  /** At most one bounded batch. Exposed for deterministic tests and explicit
   * shutdown draining. Queries do not turn a large pending queue into a long
   * synchronous operation; pendingEvents is visible in their limits. */
  flush() {
    const batch = this.pending.splice(0, this.batchSize);
    for (const packet of batch) this.process(packet);
    if (this.pending.length && this.scheduled === null) this.scheduled = this.schedule(() => { this.scheduled = null; this.flush(); });
    return this.pending.length;
  }

  detach() {
    if (!this.store) return;
    this.store.off("message", this.listener);
    this.cancel(this.scheduled); this.scheduled = null; this.pending = [];
    const at = this.now();
    for (const entry of [...this.series.values()]) this.gap(entry, at, "collector detached");
    this.sources = {}; this.games.clear(); this.store = null; this.listener = null;
  }

  process({ type, data, at, discontinuity }) {
    if (!stamp(at) || !object(data)) return;
    if (at < this.lastProcessedAt) {
      this.counters.clockRollbacks++;
      for (const entry of this.series.values()) { entry.active = false; entry.signature = null; }
      return;
    }
    this.lastProcessedAt = at;
    this.expire(at);
    if (type === "snapshot") {
      for (const entry of [...this.series.values()]) this.gap(entry, at, discontinuity ?? "new snapshot");
      this.games.clear(); this.sources = Object.fromEntries(Object.entries(data.sources ?? {}).map(([b, s]) => [b, sourceCopy(s)]));
      for (const game of data.games ?? []) { this.games.set(game.id, game); this.recordGame(game, at); }
    } else {
      const book = data.source?.book, previousSource = this.sources[book];
      if (BOOKS.includes(book)) this.sources[book] = sourceCopy(data.source);
      this.expire(at);
      if (type === "delta") {
        for (const id of data.removeGameIds ?? []) {
          this.games.delete(id);
          for (const entry of [...this.series.values()]) if (entry.gameId === id) this.gap(entry, at, "game removed");
        }
        for (const game of data.upsertGames ?? []) { this.games.set(game.id, game); this.recordGame(game, at); }
      }
      if (book) for (const game of this.games.values())
        if (!freshForGame(previousSource, game, at) && freshForGame(this.sources[book], game, at)) this.recordGame(game, at, book);
    }
    this.prune(at);
  }

  expire(at, currentSources = this.sources) {
    for (const entry of this.series.values())
      if (!freshForGame(currentSources[entry.book], this.games.get(entry.gameId) ?? { id: entry.gameId }, at)) this.gap(entry, at, "source unavailable");
  }

  recordGame(game, at, onlyBook = null) {
    if (!game || !string(game.id) || !Array.isArray(game.quotes)) return;
    const retained = new Set();
    for (const q of game.quotes) {
      if (!q || q.gameId !== game.id || (onlyBook && q.book !== onlyBook)) continue;
      const m = metadata(q, game.id, game.settlement ?? "including_overtime");
      if (!m) continue;
      const key = keyOf(m); retained.add(key);
      let entry = this.series.get(key);
      if (!freshForGame(this.sources[q.book], game, at) || q.suspended || q.missing || !price(q)) {
        if (entry) this.gap(entry, at, q.suspended ? "suspended" : "quote unavailable");
        continue;
      }
      if (!entry) {
        entry = { ...m, key, points: [], active: false, signature: null, lastLine: null };
        this.series.set(key, entry);
      }
      const line = q.market === "moneyline" ? null : q.line;
      if (entry.active && entry.lastLine !== line) this.gap(entry, at, "point line changed");
      const signature = JSON.stringify([q.american, line]);
      if (!entry.active || entry.signature !== signature) {
        this.append(entry, { at, american: q.american, decimal: decimalOdds(q.american), line,
          ...(entry.points.length && !entry.active ? { breakBefore: true } : {}) });
      }
      entry.active = true; entry.signature = signature; entry.lastLine = line;
    }
    for (const entry of [...this.series.values()])
      if (entry.gameId === game.id && (!onlyBook || entry.book === onlyBook) && !retained.has(entry.key)) this.gap(entry, at, "quote removed");
  }

  gap(entry, at, reason) {
    if (!entry.active) return;
    entry.active = false; entry.signature = null;
    const lastAt = entry.points.at(-1)?.at ?? 0;
    if (!stamp(at) || at < lastAt) return;
    this.append(entry, { at, american: null, decimal: null, line: entry.lastLine, gap: true,
      missing: true, suspended: reason === "suspended", reason });
  }

  append(entry, point) {
    entry.points.push(point); this.totalPoints++;
    while (entry.points.length > this.maxPointsPerSeries) {
      entry.points.shift(); this.totalPoints--; this.counters.evictedPoints++;
    }
    // Insertion order is the least recently observed series eviction order.
    this.series.delete(entry.key); this.series.set(entry.key, entry);
  }

  prune(at, force = false) {
    if (force || at >= this.nextPruneAt) {
      this.nextPruneAt = at + 60000;
      const from = at - this.retentionMs;
      for (const [key, entry] of this.series) {
        let count = 0; while (count < entry.points.length && entry.points[count].at < from) count++;
        if (count) { entry.points.splice(0, count); this.totalPoints -= count; }
        if (!entry.points.length && !entry.active) this.series.delete(key);
      }
    }
    while (this.series.size > this.maxSeries || this.totalPoints > this.maxTotalPoints) {
      const key = this.series.keys().next().value, entry = this.series.get(key);
      this.totalPoints -= entry.points.length; this.counters.evictedPoints += entry.points.length; this.counters.evictedSeries++;
      this.series.delete(key);
    }
  }

  limits() {
    return { maxSeries: this.maxSeries, maxPointsPerSeries: this.maxPointsPerSeries, maxTotalPoints: this.maxTotalPoints,
      pendingEvents: this.pending.length, ...this.counters,
      note: "Actual server observations only. History can be shorter than the selected window after startup, gaps, or capacity eviction. Restored history never restores live eligibility." };
  }

  query({ gameId, market, side, hours = 48, maxPoints = this.maxPointsPerSeries } = {}) {
    const span = Number(hours);
    if (!Number.isFinite(span) || span <= 0) throw new RangeError("Invalid history hours");
    if (gameId !== undefined && !string(gameId)) throw new TypeError("Invalid history game");
    if (market !== undefined && !Object.hasOwn(SIDES, market)) throw new TypeError("Invalid history market");
    if (side !== undefined && !["home", "away", "over", "under"].includes(side)) throw new TypeError("Invalid history side");
    integer(maxPoints, 1, this.maxPointsPerSeries, "history point limit");
    this.flush();
    const generatedAt = this.now(), from = generatedAt - Math.min(this.retentionMs, span * HOUR);
    // An idle board can expire without a store publication. Check the store's
    // current source state as well as processed history before serving a chart.
    if (!this.pending.length) this.expire(generatedAt, this.store?.sources ?? this.sources);
    this.prune(generatedAt);
    let truncated = false;
    const series = [];
    for (const entry of this.series.values()) {
      if ((gameId !== undefined && entry.gameId !== gameId) || (market !== undefined && entry.market !== market) ||
          (side !== undefined && entry.side !== side)) continue;
      let points = entry.points.filter(p => p.at >= from && p.at <= generatedAt);
      if (!points.length) continue;
      if (points.length > maxPoints) { truncated = true; points = points.slice(-maxPoints); }
      series.push({ book: entry.book, gameId: entry.gameId, market: entry.market, side: entry.side, period: entry.period,
        settlement: entry.settlement, points: points.map(point => ({ ...point })) });
    }
    return { generatedAt, from, retentionHours: this.retentionMs / HOUR, series, limits: { ...this.limits(), queryMaxPointsPerSeries: maxPoints, truncated } };
  }

  serialize() {
    this.flush(); const savedAt = this.now();
    if (!this.pending.length) this.expire(savedAt, this.store?.sources ?? this.sources);
    this.prune(savedAt, true);
    return { schema: 1, savedAt, retentionMs: this.retentionMs,
      series: [...this.series.values()].filter(entry => entry.points.length).map(entry => ({ book: entry.book, gameId: entry.gameId,
        period: entry.period, settlement: entry.settlement, market: entry.market, side: entry.side,
        points: entry.points.map(point => ({ ...point })) })) };
  }

  /** Persistence consumes one bounded series per event-loop turn, rather than
   * copying or JSON-encoding the entire history on the main feed's hot path.
   * This is a sequence of timestamped series checkpoints, not an atomic board. */
  async *serializeRows({ yieldControl = () => new Promise(resolve => setImmediate(resolve)) } = {}) {
    this.flush();
    const at = this.now();
    if (!this.pending.length) this.expire(at, this.store?.sources ?? this.sources);
    this.prune(at, true);
    const keys = [...this.series.keys()].sort();
    for (const key of keys) {
      await yieldControl();
      const entry = this.series.get(key), savedAt = this.now();
      if (!entry) continue;
      const points = entry.points.filter(p => p.at >= savedAt - this.retentionMs && p.at <= savedAt).map(p => ({ ...p }));
      if (!points.length) continue;
      yield { key, checkpoint: { schema: 1, savedAt, retentionMs: this.retentionMs, series: [{
        book: entry.book, gameId: entry.gameId, period: entry.period, settlement: entry.settlement,
        market: entry.market, side: entry.side, points,
      }] } };
    }
  }

  /** Import bounded historical points only. Invalid individual points break the
   * next segment; a corrupt envelope throws without changing current history. */
  load(value) {
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > 32 * 1024 * 1024) throw new RangeError("History checkpoint too large");
      value = JSON.parse(value);
    }
    if (!object(value) || value.schema !== 1 || !Array.isArray(value.series) || value.series.length > this.maxSeries * 4)
      throw new TypeError("Invalid history checkpoint");
    const now = this.now(), from = now - this.retentionMs;
    let loadedSeries = 0, loadedPoints = 0, rejectedPoints = 0, inspectedPoints = 0;
    for (const raw of value.series.slice(-this.maxSeries)) {
      if (inspectedPoints >= this.maxTotalPoints * 2) break;
      const m = metadata(raw), key = m && keyOf(m);
      if (!m || !Array.isArray(raw.points) || raw.points.length > this.maxPointsPerSeries * 4) { this.counters.invalidImports++; continue; }
      const points = []; let lastAt = 0, breakBefore = false;
      for (const p of raw.points.slice(-this.maxPointsPerSeries)) {
        if (++inspectedPoints > this.maxTotalPoints * 2) break;
        const gap = p?.gap === true || p?.missing === true || p?.suspended === true;
        const valid = object(p) && stamp(p.at) && p.at >= lastAt && p.at <= now &&
          (m.market === "moneyline" ? p.line == null : Number.isFinite(p.line)) &&
          (gap || (Number.isFinite(p.american) && Math.abs(p.american) >= 100 && Number.isFinite(p.decimal) && p.decimal > 1 && Math.abs(p.decimal - decimalOdds(p.american)) <= 1e-8));
        if (!valid) { rejectedPoints++; breakBefore = true; continue; }
        lastAt = p.at;
        if (p.at < from) continue;
        points.push(gap ? { at: p.at, american: null, decimal: null, line: p.line ?? null, gap: true, missing: true,
          suspended: p.suspended === true, reason: typeof p.reason === "string" ? p.reason.slice(0,80) : "restored gap" }
          : { at: p.at, american: p.american, decimal: decimalOdds(p.american), line: p.line ?? null,
            ...(breakBefore || p.breakBefore === true || (points.length && points.at(-1).line !== (p.line ?? null)) ? { breakBefore: true } : {}) });
        breakBefore = false;
      }
      if (!points.length) continue;
      const existing = this.series.get(key), existingPoints = existing?.points ?? [];
      // If live observation has already begun, restored points are only allowed
      // before its first observation and cannot overwrite it or bridge its start.
      const earlier = existingPoints.length ? points.filter(p => p.at < existingPoints[0].at) : points;
      if (!earlier.length) continue;
      const merged = [...earlier, ...existingPoints.map((p, i) => i === 0 ? { ...p, breakBefore: true } : p)].slice(-this.maxPointsPerSeries);
      this.totalPoints -= existingPoints.length; this.totalPoints += merged.length;
      const entry = existing ?? { ...m, key, active: false, signature: null, lastLine: null };
      entry.points = merged; this.series.set(key, entry); loadedSeries++; loadedPoints += earlier.length;
    }
    // Import arrival order is not observation recency. A late checkpoint can
    // contain older series than the live observations already recorded here.
    // Restore the eviction order before enforcing either capacity bound so
    // those older imports cannot displace newer live or restored history.
    this.series = new Map([...this.series].sort(([aKey, a], [bKey, b]) =>
      (a.points.at(-1)?.at ?? 0) - (b.points.at(-1)?.at ?? 0) || aKey.localeCompare(bKey)));
    this.counters.invalidImports += rejectedPoints; this.prune(now, true);
    return { loadedSeries, loadedPoints, rejectedPoints, limits: this.limits() };
  }
}
