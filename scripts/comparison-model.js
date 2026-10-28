import { team } from '../src/model.js';

export const valueOf = q => JSON.stringify([q.line, q.odds, q.suspended]);
const active = q => q && !q.suspended && Number.isFinite(q.odds);
const round = n => Math.round(n * 100) / 100;
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });
export const compatibleGames = (a, b) => a && b && Math.abs(Date.parse(a.startsAt) - Date.parse(b.startsAt)) <= 90000;
export function stats(values) {
  const a = [...values].sort((a, b) => a - b);
  if (!a.length) return { n: 0 };
  const percentile = p => a[Math.max(0, Math.ceil(p * a.length) - 1)];
  return { n: a.length, min: round(a[0]), p50: round(percentile(.5)), p95: round(percentile(.95)), max: round(a.at(-1)) };
}

// A common model independent of either app's IDs and server timestamps.
// The feeds can disagree by one minute on kickoff. Match teams/date, then
// require kickoff agreement within 90 seconds before admitting a race sample.
export class BoardObserver {
  constructor(app) {
    this.app = app;
    this.games = new Map();
    this.quotes = new Map();
    this.sources = {};
  }
  game(g) {
    const away = team(g.away.name).id, home = team(g.home.name).id;
    const start = new Date(g.startsAt ?? g.start).toISOString();
    return { key: `${day.format(new Date(start))}|${away}|${home}`, startsAt: start };
  }
  apply(type, data) {
    const before = new Map(this.quotes);
    if (type === 'snapshot') { this.games.clear(); this.quotes.clear(); }
    Object.assign(this.sources, data.sources ?? {});
    if (data.source) this.sources[data.source.book] = data.source;
    if (this.app === 'codex') {
      for (const id of data.removeGameIds ?? []) this.removeGame(id);
      for (const g of data.games ?? data.upsertGames ?? []) {
        this.removeGame(g.id);
        const game = this.game(g);
        this.games.set(g.id, game);
        for (const q of g.quotes) {
          if (q.period !== 'full_game') continue;
          this.put(q, game, q.american);
        }
      }
    } else {
      for (const g of data.games ?? []) this.games.set(g.key, this.game(g));
      for (const q of data.quotes ?? []) {
        const game = this.games.get(q.gameKey);
        if (!game) throw new Error(`Unknown game ${q.gameKey}`);
        this.put(q, game, q.odds);
      }
    }
    if (type === 'snapshot') return [];
    const changes = [];
    for (const [key, next] of this.quotes) {
      const prev = before.get(key);
      if (active(prev) && active(next) && valueOf(prev) !== valueOf(next)) {
        const source = this.sources[next.book];
        const healthy = this.app === 'codex' ? source?.status === 'healthy' : source?.stale === false && source?.state !== 'down';
        changes.push({ key, book: next.book, from: prev, to: next, healthy });
      }
    }
    return changes;
  }
  removeGame(id) {
    const game = this.games.get(id);
    if (game) for (const [key, q] of this.quotes) if (q.game === game.key) this.quotes.delete(key);
    this.games.delete(id);
  }
  put(q, game, odds) {
    if (!['moneyline', 'spread', 'total'].includes(q.market)) return;
    const key = `${q.book}|${game.key}|full_game|${q.market}|${q.side}`;
    if (q.removed) { this.quotes.delete(key); return; }
    this.quotes.set(key, { game: game.key, startsAt: game.startsAt, book: q.book, market: q.market, side: q.side,
      line: q.market === 'moneyline' ? null : q.line, odds, suspended: !!q.suspended });
  }
}

export function coverage(a, b) {
  return Object.fromEntries(['draftkings', 'fanduel'].map(book => {
    const aa = [...a.quotes].filter(([, q]) => q.book === book);
    const bb = [...b.quotes].filter(([, q]) => q.book === book);
    const shared = aa.filter(([k]) => b.quotes.has(k));
    return [book, { codex: aa.length, claude: bb.length, shared: shared.length,
      identicalActive: shared.filter(([k, q]) => active(q) && active(b.quotes.get(k)) && compatibleGames(q, b.quotes.get(k)) && valueOf(q) === valueOf(b.quotes.get(k))).length,
      kickoffConflicts: shared.filter(([k, q]) => !compatibleGames(q, b.quotes.get(k))).map(([key, codex]) => ({ key, codex: codex.startsAt, claude: b.quotes.get(key).startsAt })),
      differences: shared.filter(([k, q]) => valueOf(q) !== valueOf(b.quotes.get(k))).map(([key, codex]) => ({ key, codex, claude: b.quotes.get(key) })),
      codexOnly: aa.filter(([k]) => !b.quotes.has(k)).map(([k]) => k),
      claudeOnly: bb.filter(([k]) => !a.quotes.has(k)).map(([k]) => k) }];
  }));
}

// Match the entire old -> new transition. A repeated transition that could match
// more than once within the window is ambiguous and excluded, never guessed.
export function pairChanges(changes, { startMs, endMs, maxLagMs = 15000 }) {
  const signature = x => `${x.key}|${valueOf(x.from)}|${valueOf(x.to)}`;
  const candidates = new Map();
  for (const x of changes) {
    const sig = signature(x);
    if (!candidates.has(sig)) candidates.set(sig, []);
    candidates.get(sig).push(x);
  }
  const pairs = [], unmatched = [], excluded = [];
  for (const group of candidates.values()) {
    const neighbors = x => group.filter(y => y.app !== x.app && Math.abs(y.atMs - x.atMs) <= maxLagMs && compatibleGames(x.to, y.to));
    for (const x of group) {
      if (!x.healthy) { excluded.push({ ...x, reason: 'source reported unhealthy' }); continue; }
      const options = neighbors(x).filter(y => y.healthy);
      if (!options.length) { if (x.atMs < endMs) unmatched.push(x); continue; }
      if (options.length !== 1 || neighbors(options[0]).filter(y => y.healthy).length !== 1) {
        excluded.push({ ...x, reason: 'ambiguous repeated transition' }); continue;
      }
      if (x.app !== 'codex') continue;
      const y = options[0];
      if (Math.min(x.atMs, y.atMs) < startMs || Math.min(x.atMs, y.atMs) >= endMs) continue;
      pairs.push({ key: x.key, book: x.book, from: x.from, to: x.to,
        codexAtMs: x.atMs, claudeAtMs: y.atMs, codexBatch: x.batch, claudeBatch: y.batch,
        codexMinusClaudeMs: round(x.atMs - y.atMs) });
    }
  }
  const summary = Object.fromEntries(['draftkings', 'fanduel'].map(book => {
    const rows = pairs.filter(x => x.book === book);
    const batches = new Map(rows.map(x => [`${x.codexBatch}|${x.claudeBatch}`, x.codexMinusClaudeMs]));
    return [book, { pairedQuoteTransitions: rows.length, distinctBatchPairs: batches.size,
      codexFirst: rows.filter(x => x.codexMinusClaudeMs < 0).length,
      claudeFirst: rows.filter(x => x.codexMinusClaudeMs > 0).length,
      ties: rows.filter(x => x.codexMinusClaudeMs === 0).length,
      quoteLeadMs: stats(rows.map(x => x.codexMinusClaudeMs)), batchLeadMs: stats(batches.values()),
      unmatchedCodex: unmatched.filter(x => x.book === book && x.app === 'codex').length,
      unmatchedClaude: unmatched.filter(x => x.book === book && x.app === 'claude').length }];
  }));
  return { summary, pairs, unmatched, excluded };
}
