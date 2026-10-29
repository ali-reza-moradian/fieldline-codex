import { COLLEGE_TEAMS } from "./college-teams.js";
import { LEAGUES } from "./leagues.js";

export const BOOKS = ["draftkings", "fanduel"];
export const BOOK_NAMES = { draftkings: "DraftKings", fanduel: "FanDuel" };

const teams = [
  ["ARI", "Arizona Cardinals", "ARZ"],
  ["ATL", "Atlanta Falcons"],
  ["BAL", "Baltimore Ravens"],
  ["BUF", "Buffalo Bills"],
  ["CAR", "Carolina Panthers"],
  ["CHI", "Chicago Bears"],
  ["CIN", "Cincinnati Bengals"],
  ["CLE", "Cleveland Browns"],
  ["DAL", "Dallas Cowboys"],
  ["DEN", "Denver Broncos"],
  ["DET", "Detroit Lions"],
  ["GB", "Green Bay Packers"],
  ["HOU", "Houston Texans"],
  ["IND", "Indianapolis Colts"],
  ["JAX", "Jacksonville Jaguars", "JAC"],
  ["KC", "Kansas City Chiefs"],
  ["LV", "Las Vegas Raiders"],
  ["LAC", "Los Angeles Chargers", "LA Chargers"],
  ["LAR", "Los Angeles Rams", "LA Rams"],
  ["MIA", "Miami Dolphins"],
  ["MIN", "Minnesota Vikings"],
  ["NE", "New England Patriots"],
  ["NO", "New Orleans Saints"],
  ["NYG", "New York Giants", "NY Giants"],
  ["NYJ", "New York Jets", "NY Jets"],
  ["PHI", "Philadelphia Eagles"],
  ["PIT", "Pittsburgh Steelers"],
  ["SEA", "Seattle Seahawks"],
  ["SF", "San Francisco 49ers"],
  ["TB", "Tampa Bay Buccaneers"],
  ["TEN", "Tennessee Titans"],
  ["WAS", "Washington Commanders", "WSH"],
];
const clean = (text) =>
  String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const aliases = new Map();
for (const [id, name, ...extra] of teams) {
  const nickname = name.split(" ").at(-1);
  for (const alias of [id, name, nickname, `${id} ${nickname}`, ...extra]) {
    aliases.set(clean(alias), { id, name });
  }
}
const leagueAliases = { nfl: aliases, ncaaf: new Map(), cfl: new Map() };
const cflTeams = [
  ["BC", "British Columbia Lions", "BC Lions"],
  ["CGY", "Calgary Stampeders", "CGY Stampeders", "CAL Stampeders"],
  ["EDM", "Edmonton Elks", "EDM Elks"],
  ["HAM", "Hamilton Tiger-Cats", "HAM Tiger-Cats"],
  ["MTL", "Montreal Alouettes", "MTL Alouettes"],
  ["OTT", "Ottawa Redblacks", "OTT Redblacks"],
  ["SSK", "Saskatchewan Roughriders", "SSK Roughriders", "SAS Roughriders"],
  ["TOR", "Toronto Argonauts", "TOR Argonauts"],
  ["WPG", "Winnipeg Blue Bombers", "WPG Blue Bombers", "WIN Blue Bombers"],
];
for (const [league, rows] of [["ncaaf", COLLEGE_TEAMS], ["cfl", cflTeams]]) {
  for (const [id, name, ...extra] of rows) {
    for (const alias of [id, name, ...extra]) {
      const key = clean(alias), existing = leagueAliases[league].get(key);
      if (existing && existing.id !== id) throw new Error(`Ambiguous ${league} team alias: ${alias}`);
      leagueAliases[league].set(key, { id, name });
    }
  }
}
export function team(name, league = "nfl") {
  const result = leagueAliases[league]?.get(clean(name));
  if (!result) throw new Error(`Unrecognized ${LEAGUES[league]?.name ?? league} team: ${name}`);
  return result;
}
export function americanOdds(value) {
  const odds = Number(String(value).replace(/[−–]/g, "-").replace(/,/g, ""));
  if (!Number.isFinite(odds) || Math.abs(odds) < 100)
    throw new Error(`Invalid American odds: ${value}`);
  return odds;
}
export const decimalOdds = (odds) =>
  odds > 0 ? 1 + odds / 100 : 1 + 100 / -odds;
const day = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function makeGame(
  book,
  sourceId,
  awayName,
  homeName,
  startsAt,
  live = false,
  league = "nfl",
) {
  if (!Object.hasOwn(LEAGUES, league)) throw new Error(`Unsupported league: ${league}`);
  const away = team(awayName, league),
    home = team(homeName, league),
    time = new Date(startsAt);
  if (away.id === home.id || !Number.isFinite(time.getTime()))
    throw new Error("Invalid game identity");
  return {
    id: `${league === "nfl" ? "" : `${league}:`}${day.format(time)}:${away.id}:${home.id}`,
    league,
    book,
    sourceId: String(sourceId),
    away,
    home,
    startsAt: time.toISOString(),
    live,
  };
}
export function makeQuote(
  game,
  market,
  side,
  line,
  odds,
  sourceId,
  suspended = false,
) {
  if (!["moneyline", "spread", "total"].includes(market))
    throw new Error("Unknown market");
  if (
    !(market === "total" ? ["over", "under"] : ["away", "home"]).includes(side)
  )
    throw new Error("Unknown side");
  if (
    market !== "moneyline" &&
    (line === null || !Number.isFinite(Number(line)))
  )
    throw new Error("Missing line");
  const american = suspended && odds == null ? null : americanOdds(odds);
  return {
    id: `${game.book}:${sourceId}`,
    gameId: game.id,
    book: game.book,
    period: "full_game",
    market,
    side,
    line: market === "moneyline" ? null : Number(line),
    american,
    decimal: american === null ? null : decimalOdds(american),
    suspended,
    sourceId: String(sourceId),
  };
}

/** Only identical contracts compete on price. Different point lines stay separate. */
export function compareQuotes(quotes, sources, now = Date.now()) {
  const groups = new Map();
  for (const q of quotes) {
    const key = `${q.market}:${q.period}:${q.side}:${q.line ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    const source = sources[q.book];
    const stale =
      !source ||
      source.status !== "healthy" ||
      now - source.lastConfirmedAt > source.staleAfterMs ||
      (source.coverage != null && (!Number.isInteger(source.coverage.requested) || source.coverage.requested <= 0 ||
        source.coverage.returned !== source.coverage.requested || !Array.isArray(source.coverage.missingIds) ||
        source.coverage.missingIds.length !== 0));
    groups.get(key).push({ ...q, stale });
  }
  return [...groups.entries()].map(([key, offers]) => {
    const available = offers.filter(
      (q) => !q.stale && !q.suspended && q.decimal !== null,
    );
    const price = Math.max(...available.map((q) => q.decimal));
    return {
      key,
      offers,
      bestBooks: available
        .filter((q) => Math.abs(q.decimal - price) < 1e-9)
        .map((q) => q.book),
    };
  });
}
