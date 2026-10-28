import { EventEmitter } from "node:events";
import { BOOKS } from "./model.js";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quoteValue = (q) => [
  q.gameId,
  q.market,
  q.side,
  q.line,
  q.american,
  q.suspended,
];
export class OddsStore extends EventEmitter {
  constructor() {
    super();
    this.revision = 0;
    this.boards = new Map();
    this.history = [];
    this.sources = Object.fromEntries(
      BOOKS.map((book) => [
        book,
        {
          book,
          status: "connecting",
          lastConfirmedAt: null,
          lastDataAt: null,
          lastChangeAt: null,
          staleAfterMs: book === "draftkings" ? 25000 : 10000,
          error: null,
          warnings: [],
          updates: 0,
          priceChanges: 0,
          games: 0,
          quotes: 0,
          transport:
            book === "draftkings"
              ? "WebSocket · JSON deltas"
              : "HTTP · 2 second polling",
          region: book === "draftkings" ? "Ontario" : "New Jersey",
        },
      ]),
    );
    this.datasets = Object.fromEntries(
      BOOKS.map((book) => [book, { games: [], quotes: [] }]),
    );
  }
  update(book, dataset, timing) {
    const began = performance.now(),
      now = Date.now(),
      source = this.sources[book];
    const previous = new Map(this.datasets[book].quotes.map((q) => [q.id, q]));
    const sideKey = (q) => `${q.gameId}:${q.period}:${q.market}:${q.side}`;
    const previousSides = new Map(
      this.datasets[book].quotes.map((q) => [sideKey(q), q]),
    );
    let priceChanges = 0;
    const quotes = dataset.quotes.map((q) => {
      const old = previous.get(q.id) ?? previousSides.get(sideKey(q));
      const changed = old && !same(quoteValue(q), quoteValue(old));
      if (changed) priceChanges++;
      return {
        ...q,
        changedAt: !old || changed ? now : old.changedAt,
        previousAmerican: changed
          ? old.american
          : (old?.previousAmerican ?? null),
      };
    });
    this.datasets[book] = { games: dataset.games, quotes };
    Object.assign(source, {
      status: "healthy",
      lastConfirmedAt: now,
      lastDataAt: timing.receivedAt,
      lastChangeAt: priceChanges ? now : source.lastChangeAt,
      error: null,
      warnings: dataset.warnings,
      updates: source.updates + 1,
      priceChanges: source.priceChanges + priceChanges,
      games: dataset.games.length,
      quotes: quotes.length,
      requestMs: timing.durationMs ?? source.requestMs ?? null,
      decodedBytes: timing.decodedBytes,
      pollMs: timing.pollMs ?? null,
    });
    const next = this.buildBoard(),
      upsertGames = [],
      removeGameIds = [];
    for (const [id, game] of next)
      if (!same(game, this.boards.get(id))) upsertGames.push(game);
    for (const id of this.boards.keys())
      if (!next.has(id)) removeGameIds.push(id);
    this.boards = next;
    const normalizedAt = Date.now();
    const metadata = {
      book,
      kind: timing.kind,
      receivedAt: timing.receivedAt,
      normalizedAt,
      processingMs: performance.now() - began,
      requestMs: timing.durationMs ?? null,
      sourceCreatedAt: timing.sourceCreatedAt ?? null,
      sourcePublishedAt: timing.sourcePublishedAt ?? null,
      decodedBytes: timing.decodedBytes,
      priceChanges,
      phases: [
        ...new Set(
          (upsertGames.length ? upsertGames : dataset.games).map((g) =>
            g.live ? "live" : "pregame",
          ),
        ),
      ],
    };
    if (upsertGames.length || removeGameIds.length)
      this.publish("delta", {
        upsertGames,
        removeGameIds,
        source: { ...source },
        timing: metadata,
      });
    else this.publish("status", { source: { ...source } });
    this.history.push({ at: now, ...metadata });
    if (this.history.length > 10000)
      this.history.splice(0, this.history.length - 10000);
  }
  buildBoard() {
    const games = new Map(),
      gameMap = new Map();
    for (const book of BOOKS) {
      for (const g of this.datasets[book].games) {
        const existing = games.get(g.id);
        // Team aliases alone are insufficient: quarantine implausible kickoff differences.
        const conflict =
          existing &&
          Math.abs(Date.parse(existing.startsAt) - Date.parse(g.startsAt)) >
            30 * 60 * 1000;
        const id = conflict ? `${g.id}:${book}:${g.sourceId}` : g.id;
        gameMap.set(`${book}:${g.id}`, id);
        const merged = games.get(id) ?? {
          id,
          away: g.away,
          home: g.home,
          startsAt: g.startsAt,
          live: false,
          books: [],
          quotes: [],
          matchWarning: conflict
            ? "Kickoff differs by more than 30 minutes; kept separate"
            : null,
        };
        merged.books.push(book);
        merged.live ||= g.live;
        games.set(id, merged);
      }
    }
    for (const book of BOOKS)
      for (const q of this.datasets[book].quotes) {
        const id = gameMap.get(`${book}:${q.gameId}`);
        if (id) games.get(id).quotes.push({ ...q, gameId: id });
      }
    for (const game of games.values())
      game.quotes.sort((a, b) => a.id.localeCompare(b.id));
    return games;
  }
  confirm(book) {
    if (this.sources[book].status !== "healthy") return;
    this.sources[book].lastConfirmedAt = Date.now();
    this.publish("status", { source: { ...this.sources[book] } });
  }
  failure(book, error) {
    const source = this.sources[book];
    Object.assign(source, {
      status: "stale",
      error: error.message,
      lastErrorAt: Date.now(),
    });
    this.publish("status", { source: { ...source } });
  }
  publish(type, data) {
    this.emit("message", {
      type,
      data: { ...data, revision: ++this.revision, sentAt: Date.now() },
    });
  }
  snapshot() {
    return {
      games: [...this.boards.values()],
      sources: this.sources,
      revision: this.revision,
      sentAt: Date.now(),
    };
  }
}
