// Browser presentation only. Comparison eligibility stays in the shared model.
export const safeView = value => ["best", "draftkings", "fanduel"].includes(value) ? value : "best";
export const safeFormat = value => value === "decimal" ? "decimal" : "american";
export function sourceFresh(source, { connected, now, clockUncertaintyMs = 0 }) {
  if (!connected || source?.status !== "healthy" || !Number.isFinite(source.lastConfirmedAt) ||
      !Number.isFinite(source.staleAfterMs) || source.staleAfterMs <= 0) return false;
  if (source.coverage != null && (!Number.isInteger(source.coverage.requested) || source.coverage.requested <= 0 ||
      source.coverage.returned !== source.coverage.requested || !Array.isArray(source.coverage.missingIds) || source.coverage.missingIds.length > 0)) return false;
  const age = now - source.lastConfirmedAt;
  return age >= -Math.max(1000, clockUncertaintyMs) && Math.max(0, age) < source.staleAfterMs;
}
export const payout = value => Number.isFinite(value) && Math.abs(value) >= 100
  ? value > 0 ? 1 + value / 100 : 1 + 100 / -value : null;
export function formatOdds(value, format = "american") {
  const decimal = payout(value);
  if (decimal === null) return "—";
  return safeFormat(format) === "decimal" ? decimal.toFixed(3)
    : value > 0 ? `+${value}` : `−${Math.abs(value)}`;
}
export const selectionKey = q => JSON.stringify([q.gameId, q.book, q.period, q.market, q.side]);
const valueKey = q => JSON.stringify([q.line ?? null, q.american, !!q.suspended, !!q.missing]);

/** A new line is a different bet, not a better/worse price. Availability is
 * also separate from movement. Equivalent -100/+100 payouts do not get arrows. */
export function quoteChange(before, after) {
  if (!before || !after) return null;
  const lineChanged = (before.line ?? null) !== (after.line ?? null);
  const availabilityChanged = !!before.suspended !== !!after.suspended || !!before.missing !== !!after.missing;
  const a = payout(before.american), b = payout(after.american);
  const direction = a !== null && b !== null && Math.abs(a - b) > 1e-9 ? Math.sign(b - a) : 0;
  const kind = lineChanged ? "line" : availabilityChanged ? "availability"
    : !before.suspended && !after.suspended && direction ? "price" : null;
  return kind ? { kind, direction: kind === "price" ? direction : 0,
    lineChanged, availabilityChanged, before: { ...before }, after: { ...after } } : null;
}

/** One page's observations, never reconstructed bookmaker history. A snapshot
 * is a baseline; reconnects deliberately break continuity and do not invent moves. */
export class SessionHistory {
  constructor({ maxSeries = 512, maxPoints = 120, maxMoves = 30, maxAgeMs = 60 * 60 * 1000 } = {}) {
    this.maxSeries = maxSeries; this.maxPoints = maxPoints; this.maxMoves = maxMoves; this.maxAgeMs = maxAgeMs;
    this.series = new Map(); this.current = new Map(); this.recent = []; this.lastChanges = new Map();
    this.hasBaseline = false; this.version = 0;
  }
  recordGames(games, { at = Date.now(), baseline = false, replaceAll = false, book = null } = {}) {
    if (baseline) {
      for (const [key, q] of this.current) if (!book || q.book === book) this.current.delete(key);
      for (const [key, change] of this.lastChanges) if (!book || change.book === book) this.lastChanges.delete(key);
    }
    const retained = new Set(), updatedGames = new Set(games.map(g => g.id));
    for (const game of games) for (const quote of game.quotes) {
      if (book && quote.book !== book) continue;
      const key = selectionKey(quote); retained.add(key);
      const previous = this.current.get(key);
      const changed = !previous || valueKey(previous) !== valueKey(quote);
      let entry = this.series.get(key);
      if (!entry) entry = { key, gameId: game.id, book: quote.book, market: quote.market,
        side: quote.side, period: quote.period, points: [] };
      if (changed || baseline) {
        entry.points.push({ at, american: quote.american, line: quote.line ?? null,
          suspended: !!quote.suspended, breakBefore: baseline && this.hasBaseline });
        entry.points = entry.points.filter(p => p.at >= at - this.maxAgeMs).slice(-this.maxPoints);
        entry.version = ++this.version;
      }
      this.series.delete(key); this.series.set(key, entry);
      const move = !baseline && quoteChange(previous, quote);
      if (move) {
        const event = { ...move, key, at, gameId: game.id, away: game.away.id, home: game.home.id,
          book: quote.book, market: quote.market, side: quote.side };
        this.recent.unshift(event); this.lastChanges.set(key, event);
      }
      this.current.set(key, { ...quote });
    }
    for (const [key, quote] of this.current) if ((!book || quote.book === book) && !retained.has(key) && (replaceAll || updatedGames.has(quote.gameId))) {
      this.current.delete(key); this.lastChanges.delete(key);
      const entry = this.series.get(key);
      if (entry) { entry.points.push({ at, american: null, line: quote.line, suspended: true, missing: true });
        entry.points = entry.points.slice(-this.maxPoints); entry.version = ++this.version; }
    }
    while (this.series.size > this.maxSeries) {
      const key = this.series.keys().next().value;
      this.series.delete(key); this.current.delete(key); this.lastChanges.delete(key);
    }
    this.recent = this.recent.filter(m => m.at >= at - this.maxAgeMs).slice(0, this.maxMoves);
    this.hasBaseline = true;
  }
  disconnect(at = Date.now(), book = null) {
    for (const entry of this.series.values()) {
      if (!this.current.has(entry.key) || (book && entry.book !== book)) continue;
      entry.points.push({ at, american: null, suspended: true, missing: true });
      entry.points = entry.points.slice(-this.maxPoints); entry.version = ++this.version;
    }
    for (const [key, q] of this.current) if (!book || q.book === book) this.current.delete(key);
    for (const [key, change] of this.lastChanges) if (!book || change.book === book) this.lastChanges.delete(key);
  }
  hasCurrentBook(book) { return [...this.current.values()].some(q => q.book === book); }
  changeFor(quote, now = Date.now()) {
    const event = this.lastChanges.get(selectionKey(quote));
    return event && now >= event.at && now - event.at < 8000 && valueKey(event.after) === valueKey(quote) ? event : null;
  }
  forSelection(gameId, market, side, now = Date.now()) {
    return [...this.series.values()].filter(s => s.gameId === gameId && s.market === market && s.side === side)
      .map(s => ({ ...s, points: s.points.filter(p => p.at >= now - this.maxAgeMs) }));
  }
}

/** Keep the chart from connecting across a reconnect, missing/suspended price,
 * or point-line change. Decimal payout makes cross-sign changes meaningful. */
export function historySegments(points) {
  const segments = []; let segment = null, previous = null;
  for (const point of points) {
    const decimal = payout(point.american);
    if (point.suspended || point.missing || decimal === null) { segment = null; previous = null; continue; }
    if (!segment || point.breakBefore || point.line !== previous?.line) {
      segment = []; segments.push(segment);
    }
    segment.push({ ...point, decimal }); previous = point;
  }
  return segments;
}
