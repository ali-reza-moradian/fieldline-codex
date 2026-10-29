import { americanOdds, decimalOdds, team } from "../model.js";
import { UpstreamError } from "../http.js";

export const DK_EXTRA_CATEGORIES = Object.freeze([
  { id: "13195", kind: "alt-spread", type: "Spread Alternate" },
  { id: "13196", kind: "alt-total", type: "Total Alternate" },
  { id: "12438", kind: "td", type: "Anytime Touchdown Scorer" },
  { id: "16569", kind: "pass-yds", type: "Passing Yards Milestones" },
  { id: "16571", kind: "rush-yds", type: "Rushing Yards Milestones" },
  { id: "16570", kind: "rec-yds", type: "Receiving Yards Milestones" },
  { id: "16821", kind: "receptions", type: "Receptions Milestones" },
]);
export const EXTRA_KINDS = Object.freeze(DK_EXTRA_CATEGORIES.map(c => c.kind));
export const EXTRAS_RULES_NOTE = "Full-game markets include overtime. Player milestones mean at least the stated number, not over/under. Player participation and early-exit protection rules can differ between books.";
const fail = message => { throw new UpstreamError(`Extras: ${message}`); };
const canonicalId = value => String(value ?? "");

export function validateExtraGame(game) {
  if (!game?.id || !/^\d+$/.test(String(game.sourceId))) fail("invalid event identity");
  for (const side of ["away", "home"]) {
    if (!game[side]?.id || team(game[side].name ?? game[side].id).id !== game[side].id)
      fail("invalid event team");
  }
  if (game.away.id === game.home.id || !Number.isFinite(Date.parse(game.startsAt)))
    fail("invalid event schedule");
}

// Preserve suffixes. A missed comparison is preferable to joining different players.
export function playerKey(name) {
  const key = String(name ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key || key.length > 100 || !/[a-z]/.test(key)) fail("invalid player name");
  return key;
}

function finiteLine(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) fail("invalid line");
  const line = Number(value);
  if (Math.abs(line) > 10000) fail("line outside supported range");
  return Object.is(line, -0) ? 0 : line;
}

function prices(americanValue, decimalValue, suspended) {
  if (suspended) return { american: null, decimal: null };
  let american;
  try { american = americanOdds(americanValue); } catch { fail("active selection has invalid odds"); }
  const decimal = decimalValue == null ? decimalOdds(american) : Number(decimalValue);
  if (!Number.isFinite(decimal) || decimal <= 1) fail("active selection has invalid decimal odds");
  const impliedAmerican = decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
  if (Math.abs(impliedAmerican - american) > Math.max(1.01, Math.abs(american) * 0.0001))
    fail("American and decimal odds disagree");
  return { american, decimal };
}

function row(game, book, kind, data, observedAt) {
  if (!Number.isFinite(observedAt) || observedAt <= 0) fail("missing observation time");
  const line = data.line == null ? null : finiteLine(data.line);
  const thresholdOperator = ["pass-yds", "rush-yds", "rec-yds", "receptions"].includes(kind) ? "gte" : null;
  return {
    id: `${book}:${data.sourceId}`,
    key: [game.id, "full_game", kind, data.subject, line ?? "", thresholdOperator ?? ""].join("|"),
    kind, subject: data.subject, name: data.name, line,
    ...prices(data.american, data.decimal, data.suspended),
    suspended: data.suspended, observedAt, period: "full_game", rules: "including_overtime",
    ...(thresholdOperator ? { thresholdOperator } : {}),
    ...(data.protection ? { protection: data.protection } : {}),
    ...(data.playerIdentity ? { _playerIdentity: data.playerIdentity } : {}),
  };
}

function isDkSuspended(item) {
  if (item.isSuspended === true || item.isOpen === false || item.isActive === false) return true;
  const status = item.status ?? item.marketStatus ?? item.selectionStatus;
  if (status == null) return false;
  if (["OPEN", "ACTIVE", "TRADING"].includes(String(status).toUpperCase())) return false;
  if (["SUSPENDED", "CLOSED", "SETTLED", "REMOVED", "INACTIVE", "UNAVAILABLE"].includes(String(status).toUpperCase())) return true;
  fail("unknown DraftKings availability status");
}

function validateFullGame(market) {
  // Exact market-type allowlists are the primary contract guard. Reject explicit
  // contradictory metadata as well, rather than letting a changed schema leak in.
  const period = market.period ?? market.periodName;
  if (period != null && !["full_game", "Full Game", "Game", "Match"].includes(period))
    fail("non-full-game market in extras response");
  if (market.includesOvertime === false) fail("regulation-only market in extras response");
}

export function normalizeDraftKingsExtras(data, game, category, observedAt) {
  validateExtraGame(game);
  if (!DK_EXTRA_CATEGORIES.some(c => c.id === category.id && c.kind === category.kind)) fail("unsupported category");
  if (!Array.isArray(data?.markets) || !Array.isArray(data?.selections)) fail("DraftKings schema changed");
  const markets = new Map(), sourceMarkets = new Set(), rows = [];
  for (const market of data.markets) {
    if (canonicalId(market.eventId) !== String(game.sourceId)) fail("DraftKings returned another event");
    if (market.leagueId != null && canonicalId(market.leagueId) !== "88808") fail("DraftKings returned another league");
    if (canonicalId(market.subcategoryId ?? market.subCategoryId) !== category.id) fail("DraftKings returned another category");
    if (!market.id || sourceMarkets.has(canonicalId(market.id))) fail("duplicate or missing DraftKings market identity");
    sourceMarkets.add(canonicalId(market.id));
    if (market.marketType?.name !== category.type) continue;
    validateFullGame(market);
    if (!market.id || markets.has(canonicalId(market.id))) fail("duplicate or missing DraftKings market identity");
    markets.set(canonicalId(market.id), market);
  }
  const ids = new Set();
  for (const selection of data.selections) {
    if (!sourceMarkets.has(canonicalId(selection.marketId))) fail("orphan DraftKings selection");
    const market = markets.get(canonicalId(selection.marketId));
    if (!market) continue;
    if (!selection.id || ids.has(canonicalId(selection.id))) fail("duplicate or missing DraftKings selection identity");
    ids.add(canonicalId(selection.id));
    let subject, name, line = null, playerIdentity;
    if (category.kind === "alt-spread") {
      subject = String(selection.outcomeType ?? "").toLowerCase();
      if (!["away", "home"].includes(subject)) fail("unknown DraftKings spread side");
      const participant = selection.participants?.find(p => p.type === "Team");
      if (team(participant?.name ?? selection.label).id !== game[subject].id) fail("DraftKings spread team mismatch");
      line = finiteLine(selection.points);
      name = game[subject].name;
    } else if (category.kind === "alt-total") {
      subject = String(selection.outcomeType ?? "").toLowerCase();
      if (!["over", "under"].includes(subject)) fail("unknown DraftKings total side");
      line = finiteLine(selection.points);
      if (line < 0) fail("negative total");
      name = subject === "over" ? "Over" : "Under";
    } else {
      const participants = selection.participants?.filter(p => p.type === "Player") ?? [];
      if (!participants.length && (/^(no |neither)/i.test(selection.label ?? "") || / D\/ST$/i.test(selection.label ?? ""))) continue;
      if (participants.length !== 1 || !participants[0].id) fail("ambiguous DraftKings player");
      const player = participants[0];
      name = player.name;
      subject = playerKey(name);
      playerIdentity = String(player.id);
      if (category.kind === "td") {
        if (selection.outcomeType && selection.outcomeType !== "ToScoreAnyTime") fail("unexpected touchdown outcome");
        if (playerKey(selection.label) !== subject) fail("touchdown player mismatch");
      } else {
        const threshold = /^(\d+)\+$/.exec(String(selection.label).trim());
        if (!threshold || !Number.isSafeInteger(Number(threshold[1]))) fail("unknown DraftKings milestone contract");
        line = Number(threshold[1]);
        if (selection.milestoneValue != null && finiteLine(selection.milestoneValue) !== line) fail("DraftKings milestone mismatch");
        if (line <= 0) fail("nonpositive milestone");
      }
    }
    rows.push(row(game, "draftkings", category.kind, {
      sourceId: selection.id, subject, name, line, playerIdentity,
      american: selection.displayOdds?.american, decimal: selection.trueOdds,
      suspended: isDkSuspended(market) || isDkSuspended(selection),
      protection: selection.tags?.some(t => ["EarlyExit", "EarlyExitPlus"].includes(t)) ? "early_exit" : null,
    }, observedAt));
  }
  return { rows, markets: markets.size };
}

export function fanDuelExtraKind(marketType) {
  const fixed = { ALTERNATE_HANDICAP: "alt-spread", ALTERNATE_TOTAL: "alt-total", ANY_TIME_TOUCHDOWN_SCORER: "td" };
  if (fixed[marketType]) return fixed[marketType];
  const match = /^PLAYER_X_ALT_(PASSING_YARDS|RUSHING_YARDS|RECEIVING_YARDS|RECEPTIONS)_(HIGH|MEDIUM|LOW)$/.exec(marketType ?? "");
  return match ? { PASSING_YARDS: "pass-yds", RUSHING_YARDS: "rush-yds", RECEIVING_YARDS: "rec-yds", RECEPTIONS: "receptions" }[match[1]] : null;
}

function fdContract(market, runner, game) {
  const kind = fanDuelExtraKind(market.marketType), text = String(runner.runnerName ?? "").trim();
  if (kind === "alt-spread" || kind === "alt-total") {
    const match = /^(.*?)\s*\(([+−–-]?\d+(?:\.\d+)?)\)$/.exec(text);
    if (!match) fail("unknown FanDuel alternate line label");
    const line = finiteLine(match[2].replace(/[−–]/g, "-"));
    const subject = String(runner.result?.type ?? "").toLowerCase();
    if (kind === "alt-spread") {
      if (!["home", "away"].includes(subject) || team(match[1]).id !== game[subject].id) fail("FanDuel spread team mismatch");
      return { kind, subject, name: game[subject].name, line };
    }
    if (!["over", "under"].includes(subject) || match[1].toLowerCase() !== subject || line < 0) fail("FanDuel total side mismatch");
    return { kind, subject, name: match[1], line };
  }
  if (kind === "td") {
    if (/^(no |neither)/i.test(text) || / (D\/ST|Defense|Defence)$/i.test(text)) return null;
    if (runner.isPlayerSelection === false || !text) fail("ambiguous FanDuel touchdown player");
    return { kind, subject: playerKey(text), name: text, line: null, playerIdentity: playerKey(text) };
  }
  const suffix = kind === "receptions" ? "Receptions" : "Yards";
  const match = new RegExp(`^(.+?)\\s+(\\d+)\\+ ${suffix}$`, "i").exec(text);
  if (!match || runner.isPlayerSelection === false) fail("unknown FanDuel milestone contract");
  const name = match[1], subject = playerKey(name), line = Number(match[2]);
  const marketPlayer = String(market.marketName ?? "").split(/\s+-\s+Alt\s+/i)[0];
  if (playerKey(marketPlayer) !== subject || !Number.isSafeInteger(line) || line <= 0) fail("FanDuel milestone player mismatch");
  return { kind, subject, name, line, playerIdentity: subject };
}

export function selectFanDuelExtras(data, game, observedAt) {
  validateExtraGame(game);
  if (!data?.attachments?.events || !data.attachments.markets) fail("FanDuel event-page schema changed");
  const event = data.attachments.events[String(game.sourceId)];
  if (!event || event.competitionId !== 12282733 || String(event.eventId) !== String(game.sourceId)) fail("FanDuel event identity mismatch");
  const teams = String(event.name).split(" @ ");
  if (teams.length !== 2 || team(teams[0]).id !== game.away.id || team(teams[1]).id !== game.home.id ||
      !Number.isFinite(Date.parse(event.openDate)) || Math.abs(Date.parse(event.openDate) - Date.parse(game.startsAt)) > 30 * 60000)
    fail("FanDuel event teams or start time mismatch");
  const markets = new Map();
  for (const market of Object.values(data.attachments.markets)) {
    if (String(market.eventId) !== String(game.sourceId) || !fanDuelExtraKind(market.marketType)) continue;
    if (market.competitionId !== 12282733 || !Array.isArray(market.runners)) fail("FanDuel market schema changed");
    validateFullGame(market);
    if (!market.marketId || markets.has(market.marketId)) fail("duplicate FanDuel market identity");
    const runners = new Map();
    for (const runner of market.runners) {
      const id = canonicalId(runner.selectionId);
      if (!id || runners.has(id)) fail("duplicate FanDuel selection identity");
      const contract = fdContract(market, runner, game);
      runners.set(id, { contract, status: runner.runnerStatus, label: runner.runnerName });
    }
    markets.set(market.marketId, { id: market.marketId, runners,
      protection: market.isBetProtectEligible === true ? "bet_protect" : null });
  }
  return { gameId: game.id, sourceId: String(game.sourceId), observedAt, markets };
}

export function normalizeFanDuelExtras(catalog, pricesData, game, observedAt) {
  validateExtraGame(game);
  if (catalog.gameId !== game.id || catalog.sourceId !== String(game.sourceId) || !(catalog.markets instanceof Map) || !Array.isArray(pricesData)) fail("FanDuel extras catalog mismatch");
  const seen = new Set(), rows = [], missingRunnerIds = [];
  for (const price of pricesData) {
    const market = catalog.markets.get(price.marketId);
    if (!market || seen.has(price.marketId)) fail("unexpected or duplicate FanDuel market price");
    seen.add(price.marketId);
    if (!Array.isArray(price.runnerDetails) || !["OPEN", "SUSPENDED", "CLOSED", "INACTIVE"].includes(price.marketStatus)) fail("FanDuel price schema changed");
    const runnersSeen = new Set();
    for (const runner of price.runnerDetails) {
      const id = canonicalId(runner.selectionId), original = market.runners.get(id);
      if (!original || runnersSeen.has(id)) fail("unexpected or duplicate FanDuel runner price");
      runnersSeen.add(id);
      if (!["ACTIVE", "SUSPENDED", "REMOVED", "WINNER", "LOSER", "PLACED", "VOID"].includes(runner.runnerStatus)) fail("unknown FanDuel runner status");
      if (!original.contract) continue;
      const { kind, ...contract } = original.contract;
      if (runner.runnerName != null && runner.runnerName !== original.label)
        fail("FanDuel runner label changed since discovery");
      // The Ontario alternates feed currently sends handicap=0 even for nonzero
      // labelled lines. If it supplies a meaningful handicap, it must agree.
      if (kind.startsWith("alt-") && runner.handicap != null && Number(runner.handicap) !== 0 && finiteLine(runner.handicap) !== contract.line)
        fail("FanDuel alternate line changed since discovery");
      rows.push(row(game, "fanduel", kind, {
        ...contract, sourceId: `${price.marketId}:${id}`,
        american: runner.winRunnerOdds?.americanDisplayOdds?.americanOddsInt ?? runner.winRunnerOdds?.americanDisplayOdds?.americanOdds,
        decimal: runner.winRunnerOdds?.trueOdds?.decimalOdds?.decimalOdds,
        suspended: price.marketStatus !== "OPEN" || runner.runnerStatus !== "ACTIVE",
        protection: market.protection,
      }, observedAt));
    }
    for (const [id, original] of market.runners) {
      if (price.marketStatus === "OPEN" && original.contract && original.status === "ACTIVE" && !runnersSeen.has(id))
        missingRunnerIds.push(`${market.id}:${id}`);
    }
  }
  const missingMarketIds = [...catalog.markets.keys()].filter(id => !seen.has(id));
  return { rows, coverage: { complete: !missingMarketIds.length && !missingRunnerIds.length,
    requested: catalog.markets.size, returned: seen.size, missingMarketIds, missingRunnerIds } };
}

export function finalizeExtraRows(inputRows) {
  const identities = new Map(), ambiguous = new Set(), ids = new Set(), keys = new Set();
  for (const row of inputRows) {
    if (ids.has(row.id)) fail("duplicate selection across extras categories");
    ids.add(row.id);
    if (row._playerIdentity) {
      const previous = identities.get(row.subject);
      if (previous && previous !== row._playerIdentity) ambiguous.add(row.subject);
      identities.set(row.subject, row._playerIdentity);
    }
  }
  const rows = [];
  for (const { _playerIdentity, ...row } of inputRows) {
    if (ambiguous.has(row.subject)) continue;
    if (keys.has(row.key)) fail("duplicate outcome contract across extras markets");
    keys.add(row.key);
    rows.push(row);
  }
  return { rows, warnings: [...ambiguous].map(name => `Ambiguous player identity omitted: ${name}`), quarantinedPlayers: ambiguous.size };
}
