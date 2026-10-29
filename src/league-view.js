import { LEAGUE_IDS } from './leagues.js';

export function selectedLeague(value) {
  if (value == null || value === '') return 'nfl';
  if (!LEAGUE_IDS.includes(value)) throw new RangeError('Unknown league');
  return value;
}

/** A league can only inherit a shared source lease when the collector actually
 * uses one complete shared baseline. Independent collectors must publish their
 * own lease, including an explicit connecting state before the first result. */
export function sourceForLeague(source, league) {
  if (!source) return null;
  const { leagues, ...base } = source;
  if (!leagues) return base;
  const part = leagues[league];
  if (!part) return { ...base, status: 'connecting', lastConfirmedAt: null,
    lastDataAt: null, lastChangeAt: null, games: 0, quotes: 0,
    error: 'Waiting for this league', coverage: null, channels: null };
  return { ...base, ...part, book: source.book, region: source.region };
}

export function leagueSources(sources, league, games) {
  return Object.fromEntries(Object.entries(sources).map(([book, source]) => {
    const projected = sourceForLeague(source, league);
    if (games) {
      projected.games = games.filter(g => g.books.includes(book)).length;
      projected.quotes = games.reduce((n, g) => n + g.quotes.filter(q => q.book === book).length, 0);
    }
    return [book, projected];
  }));
}

export function leagueSnapshot(snapshot, league) {
  const games = snapshot.games.filter(g => (g.league ?? 'nfl') === league);
  return { ...snapshot, league, games, sources: leagueSources(snapshot.sources, league, games) };
}

export function leagueFrame(type, data, league, store) {
  const games = [...store.boards.values()].filter(g => (g.league ?? 'nfl') === league);
  const source = data.source ? leagueSources({ [data.source.book]: data.source }, league, games)[data.source.book] : null;
  if (type === 'delta') {
    const upsertGames = data.upsertGames.filter(g => (g.league ?? 'nfl') === league);
    // Non-NFL IDs have a mandatory league prefix. Historic NFL IDs are stable.
    const removeGameIds = data.removeGameIds.filter(id => league === 'nfl'
      ? !/^(?:ncaaf|cfl):/.test(id) : id.startsWith(league + ':'));
    return upsertGames.length || removeGameIds.length
      ? { type, data: { ...data, league, upsertGames, removeGameIds, source } }
      : { type: 'status', data: { revision: data.revision, sentAt: data.sentAt, source } };
  }
  return { type, data: source ? { ...data, source } : data };
}
