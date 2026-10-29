// IDs verified against each book's public Ontario navigation and main-market
// responses. A league label never changes the configured sportsbook jurisdiction.
export const LEAGUES = Object.freeze({
  nfl: Object.freeze({ id: "nfl", name: "NFL", draftkings: ["88808"], fanduel: [12282733] }),
  ncaaf: Object.freeze({ id: "ncaaf", name: "College football", draftkings: ["87637", "154752"], fanduel: [12529073, 12623176] }),
  cfl: Object.freeze({ id: "cfl", name: "CFL", draftkings: ["33567"], fanduel: [12488538] }),
});
export const LEAGUE_IDS = Object.freeze(Object.keys(LEAGUES));
export const DRAFTKINGS_LEAGUES = Object.freeze(Object.values(LEAGUES).flatMap(league =>
  league.draftkings.map(sourceId => Object.freeze({ league: league.id, sourceId, subcategoryId: "4518" }))));
export function leagueForDraftKings(sourceId) {
  return DRAFTKINGS_LEAGUES.find(source => source.sourceId === String(sourceId))?.league ?? null;
}
export function leagueForCompetition(sourceId) {
  return Object.values(LEAGUES).find(league => league.fanduel.includes(Number(sourceId)))?.id ?? null;
}
