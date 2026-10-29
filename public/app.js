import { BOOK_NAMES, compareQuotes } from "/model.js";
import { formatOdds, safeView, safeFormat, sourceFresh, SessionHistory, historySegments, selectionKey } from "/presentation.js";
import { BoardStream, ClockSync, mergeFreshness } from "/stream.js";
import { analyzeGame } from "/analytics.js";
import { safePreference, parseFavorites, shortcutAction, sortGames, validExtraKinds, extraOffers, extraLineLabel, HistoryLoader, historyStorageLabel } from "/ui-controls.js";
import { ExtrasPanel } from "/extras-panel.js";

const $ = id => document.getElementById(id);
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const signed = n => n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "PK";
const lineText = q => q.market === "moneyline" ? "" : q.market === "total" ? `${q.side === "over" ? "O" : "U"} ${q.line}` : signed(q.line);
const marketName = { moneyline: "Moneyline", spread: "Spread", total: "Total" };
const when = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const shortTime = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const storage = { get(key = "odds") { try { return localStorage.getItem("fieldline." + key); } catch { return null; } }, set(value, key = "odds") { try { localStorage.setItem("fieldline." + key, value); } catch { /* optional preference */ } } };
const params = new URLSearchParams(location.search);
let games = new Map(), sources = {}, view = safeView(params.get("view")), format = safeFormat(params.get("odds") ?? storage.get());
let connected = false, loaded = false, revision = 0, clockOffset = 0, clockUncertainty = null, lastClockSync = 0;
let lastHealthKey = "", movementDeadline = Infinity;
const rendered = new Map(), charts = new Map(), history = new SessionHistory();
const observedHealth = new Map();
const openedAt = Date.now();
const preferences = Object.fromEntries(["layout", "density", "scheme", "sort"].map(key => [key, safePreference(key, storage.get(key))]));
const favorites = parseFavorites(storage.get("favorites"));
let starredOnly = false, analyticsOpen = false;
const analyticsCache = new Map();
let chartGraphicCache = null;
const savedHistory = new HistoryLoader({ onChange: () => render() });
const extras = new ExtrasPanel({ getClock: () => clockSync.estimate(), onChange: changed => changed ? render() : renderExtraSources() });
const clockSync = new ClockSync({ onSync(best) {
  clockOffset = best.offset; clockUncertainty = best.rtt / 2; lastClockSync = Date.now();
  $("clock-note").textContent = `Clock-sync uncertainty ≥ ±${clockUncertainty.toFixed(1)} ms`;
} });
const serverNow = () => clockSync.estimate()?.now ?? Date.now() + clockOffset;
const odds = n => formatOdds(n, format);
const historyId = id => `history-${encodeURIComponent(id)}`;
function effectiveSources() { return Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, { ...source, status: freshness(key) ? "healthy" : "stale" }])); }
function freshness(book) {
  return sourceFresh(sources[book], { connected, now: serverNow(), clockUncertaintyMs: clockUncertainty ?? 0 });
}
function markSourceGaps() {
  for (const book of Object.keys(BOOK_NAMES)) {
    const healthy = freshness(book), previous = observedHealth.get(book);
    if (!healthy && history.hasCurrentBook(book)) history.disconnect(Date.now(), book);
    if (previous === false && healthy && loaded && !history.hasCurrentBook(book))
      history.recordGames([...games.values()], { baseline: true, book });
    observedHealth.set(book, healthy);
  }
}
function renderSource(book) {
  const s = sources[book], healthy = freshness(book);
  const label = healthy ? "Connected" : !s || s.status === "connecting" ? "Connecting" : "Stale";
  const age = s?.lastConfirmedAt ? Math.max(0, Math.floor((serverNow() - s.lastConfirmedAt) / 1000)) : null;
  const error = !connected && loaded ? "Connection lost. Prices are excluded until reconnected." : s?.error;
  $(book + "-status").innerHTML = `<div class="source-title"><span class="book-logo ${book === "fanduel" ? "fd" : ""}">${book === "fanduel" ? "FD" : "DK"}</span>${BOOK_NAMES[book]}<span class="region">Ontario</span></div><span class="status-pill ${healthy ? "" : "stale"}">${label}</span><div class="source-details">${escape(s?.transport ?? "Waiting for source")}</div><div class="source-details right">${age === null ? "Awaiting data" : `Confirmed ${age}s ago`}</div>${error ? `<div class="source-error">${escape(error)}</div>` : ""}${s?.warnings?.length ? `<div class="source-error">${s.warnings.length} validation warning(s). <a href="/api/metrics" target="_blank" rel="noopener">Details</a></div>` : ""}`;
}
function movementHtml(q, stale) {
  if (stale) return "";
  const move = history.changeFor(q);
  if (!move) return "";
  movementDeadline = Math.min(movementDeadline, move.at + 8000);
  if (move.kind === "line") return `<span class="movement line-move" title="The point line changed; these are different bets">↔ Line was ${escape(lineText(move.before))}</span>`;
  if (move.kind === "availability") return `<span class="movement availability">${q.suspended ? "Now paused" : "Reopened"}</span>`;
  return `<span class="movement ${move.direction > 0 ? "higher" : "lower"}" aria-label="${move.direction > 0 ? "Higher" : "Lower"} payout; previously ${escape(odds(move.before.american))}"><span aria-hidden="true">${move.direction > 0 ? "↑" : "↓"}</span> <s>${escape(odds(move.before.american))}</s></span>`;
}
function quoteHtml(q, books, { best = false, stale = false, only = false } = {}) {
  const move = !stale && history.changeFor(q), picked = charts.get(q.gameId);
  const selected = picked?.market === q.market && picked?.side === q.side;
  const value = q.suspended ? "Paused" : odds(q.american), line = lineText(q);
  const reason = stale ? "Stale · excluded" : q.suspended ? "Market suspended" : only ? "Only available" : "";
  const cue = !move ? "" : move.kind === "price" ? `${move.direction > 0 ? "Higher" : "Lower"} payout, previously ${odds(move.before.american)}. `
    : move.kind === "line" ? `Point line changed from ${lineText(move.before)} to ${line}; previous price ${odds(move.before.american)}. `
    : q.suspended ? "Market just paused. " : "Market just reopened. ";
  return `<button type="button" class="quote ${best ? "best" : ""} ${stale ? "stale" : ""} ${move && Date.now() - move.at < 1800 ? `changed ${move.direction < 0 ? "change-down" : ""}` : ""}" data-chart-game="${escape(q.gameId)}" data-chart-market="${q.market}" data-chart-side="${q.side}" data-focus="${escape(selectionKey(q))}" aria-expanded="${selected}" aria-controls="${historyId(q.gameId)}" aria-label="${escape(`${BOOK_NAMES[q.book]} ${marketName[q.market]} ${q.side}, ${line} ${value}${reason ? `, ${reason}` : ""}. ${cue}Show price history.`)}"><span class="price">${line ? `<span class="points">${escape(line)}</span>` : ""}${escape(value)}</span><span class="book-name">${books.map(b => BOOK_NAMES[b]).join(" + ")}${best ? '<span class="winner-dot" aria-label="Best identical-line price"></span>' : ""}</span>${movementHtml(q, stale)}${reason ? `<small>${reason}</small>` : ""}</button>`;
}
function cell(game, market, side) {
  const matching = game.quotes.filter(q => q.market === market && q.side === side && (view === "best" || q.book === view));
  const label = `${marketName[market]}${market === "total" ? ` · ${side}` : ""}`;
  if (!matching.length) return `<div class="odds-cell"><span class="mobile-market">${label}</span><div class="empty-quote" aria-label="${label} not offered">—</div></div>`;
  const groups = compareQuotes(matching, effectiveSources(), serverNow()).sort((a, b) => (a.offers[0].line ?? 0) - (b.offers[0].line ?? 0));
  const contents = groups.map(group => {
    if (view === "best" && group.bestBooks.length) {
      const winner = group.offers.find(q => group.bestBooks.includes(q.book));
      const eligible = group.offers.filter(q => !q.stale && !q.suspended && q.decimal !== null);
      const comparison = group.offers.length > 1 ? `<div class="compare-strip">${group.offers.map(q => `<span class="${q.stale || q.suspended ? "unavailable" : ""}">${q.book === "draftkings" ? "DK" : "FD"} ${q.suspended ? "paused" : escape(odds(q.american))}${q.stale ? " stale" : ""}</span>`).join("")}</div>` : "";
      return quoteHtml(winner, group.bestBooks, { best: eligible.length > 1, only: eligible.length === 1 && group.offers.length > 1 }) + comparison;
    }
    return group.offers.map(q => quoteHtml(q, [q.book], { stale: q.stale })).join("");
  }).join("");
  return `<div class="odds-cell"><span class="mobile-market">${label}</span>${groups.length > 1 ? '<div class="different">Different lines · unranked</div>' : ""}${contents}</div>`;
}
function gameAnalysis(game) {
  const health = JSON.stringify(Object.keys(BOOK_NAMES).map(book => [freshness(book), sources[book]?.coverage]));
  const previous = analyticsCache.get(game.id);
  if (previous?.game === game && previous.health === health) return previous.value;
  const value = analyzeGame(game, effectiveSources(), serverNow());
  analyticsCache.set(game.id, { game, health, value }); return value;
}
const percent = value => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(2)}%` : "—";
function contractLabel(group) {
  return `${marketName[group.market]}${group.line === null ? "" : group.market === "spread" ? ` · away ${signed(group.line)}` : ` · ${group.line}`}`;
}
function analyticsHtml(game) {
  if (!analyticsOpen) return "";
  const analysis = gameAnalysis(game);
  if (!analysis.groups.length) return '<p class="analysis-empty">No complete, fresh two-book market to estimate. Different lines, missing prices and paused sources are excluded.</p>';
  return `<div class="analysis-cards" aria-label="Market estimates">${analysis.groups.map(group => `<section class="analysis-card"><div><strong>${escape(contractLabel(group))}</strong><span class="${group.arbitrageCandidate ? "candidate" : ""}">${group.arbitrageCandidate ? "Arbitrage candidate · verify availability" : "Same-line estimate"}</span></div><p>Implied margin <b>${percent(group.holdPercent)}</b></p>${Object.entries(group.bestOffers).map(([side, q]) => `<p><span>${escape(side === "away" || side === "home" ? game[side].id : side)} <small>fair chance estimate</small> ${(q.fairProbability * 100).toFixed(1)}%</span><span>Estimated EV <b>${percent(q.estimatedEvPercent)}</b> <small>${q.bestBooks.map(book => BOOK_NAMES[book]).join(" + ")}</small></span></p>`).join("")}</section>`).join("")}</div>`;
}
function gridHtml(game) {
  const groups = compareQuotes(game.quotes.filter(q => view === "best" || q.book === view), effectiveSources(), serverNow());
  const order = { moneyline: 0, spread: 1, total: 2 };
  groups.sort((a, b) => order[a.offers[0].market] - order[b.offers[0].market] || a.offers[0].side.localeCompare(b.offers[0].side) || (a.offers[0].line ?? 0) - (b.offers[0].line ?? 0));
  const books = view === "best" ? Object.keys(BOOK_NAMES) : [view];
  return `<h2 class="grid-matchup">${escape(game.away.name)} <span>at</span> ${escape(game.home.name)}</h2><div class="comparison-scroll" tabindex="0" data-focus="grid-scroll" data-scroll="grid" aria-label="Price comparison; scroll horizontally on a small screen"><table class="comparison-table"><thead><tr><th scope="col">Market / selection</th>${books.map(b => `<th scope="col">${BOOK_NAMES[b]}</th>`).join("")}<th scope="col">Best same-line price</th></tr></thead><tbody>${groups.map(group => {
    const first = group.offers[0], available = group.offers.filter(q => !q.stale && !q.suspended && q.decimal !== null);
    const label = `${marketName[first.market]} · ${first.side === "away" || first.side === "home" ? game[first.side].id : first.side}${first.line === null ? "" : ` · ${lineText(first)}`}`;
    return `<tr><th scope="row">${escape(label)}</th>${books.map(book => { const q = group.offers.find(q => q.book === book); return `<td>${q ? quoteHtml(q, [book], { stale: q.stale, best: available.length > 1 && group.bestBooks.includes(book) }) : '<span class="grid-unavailable">Not offered</span>'}</td>`; }).join("")}<td class="grid-best">${available.length > 1 ? group.bestBooks.map(b => BOOK_NAMES[b]).join(" + ") : available.length === 1 ? "One available book" : "Unavailable"}</td></tr>`;
  }).join("") || `<tr><td colspan="${books.length + 2}">No prices available in this view.</td></tr>`}</tbody></table></div>`;
}
function chartHtml(game) {
  const chosen = charts.get(game.id);
  if (!chosen) return "";
  const saved = savedHistory.selection?.gameId === game.id && savedHistory.data;
  const graphicKey = JSON.stringify([game.id, chosen.market, chosen.side, view, saved ? "server" : "tab", saved ? savedHistory.version : history.version]);
  const reuseGraphic = chartGraphicCache?.key === graphicKey;
  const entries = (saved ? saved.series : history.forSelection(game.id, chosen.market, chosen.side)).filter(s => view === "best" || s.book === view);
  const data = reuseGraphic ? null : entries.map(s => ({ ...s, segments: historySegments(s.points.map(p => p.gap ? { ...p, missing: true } : p)) }));
  const points = reuseGraphic ? chartGraphicCache.points : data.flatMap(s => s.segments.flat());
  const options = ["moneyline", "spread", "total"].flatMap(market => (market === "total" ? ["over", "under"] : ["away", "home"]).map(side => `<option value="${market}:${side}"${chosen.market === market && chosen.side === side ? " selected" : ""}>${marketName[market]} · ${market === "total" ? side : game[side].id}</option>`)).join("");
  const legend = Object.keys(BOOK_NAMES).filter(b => view === "best" || b === view).map(book => {
    const q = game.quotes.find(q => q.book === book && q.market === chosen.market && q.side === chosen.side);
    return `<span class="chart-legend ${book}">${BOOK_NAMES[book]} <strong>${q ? `${escape(lineText(q))} ${q.suspended ? "Paused" : escape(odds(q.american))}` : "Not offered"}</strong>${!freshness(book) ? " · stale" : ""}</span>`;
  }).join("");
  let graphic = reuseGraphic ? chartGraphicCache.html : '<p class="chart-empty">No price observations for this selection yet.</p>';
  if (!reuseGraphic && points.length) {
    const from = Math.min(...points.map(p => p.at)), to = Math.max(...points.map(p => p.at), from + 1000);
    const low = Math.min(...points.map(p => p.decimal)), high = Math.max(...points.map(p => p.decimal));
    const padding = Math.max(.025, (high - low) * .15), bottom = low - padding, top = high + padding;
    const x = p => 44 + 632 * (p.at - from) / (to - from), y = p => 132 - 104 * (p.decimal - bottom) / (top - bottom);
    const paths = data.map(s => {
      const path = s.segments.map(segment => segment.map((p, i) => i ? `H${x(p).toFixed(2)}V${y(p).toFixed(2)}` : `M${x(p).toFixed(2)},${y(p).toFixed(2)}`).join("")).join(" ");
      const latest = s.segments.at(-1)?.at(-1);
      return `<path class="chart-line ${s.book}" d="${path}"/>${latest ? `<circle class="chart-point ${s.book}" cx="${x(latest).toFixed(2)}" cy="${y(latest).toFixed(2)}" r="3"><title>${BOOK_NAMES[s.book]} · ${escape(when.format(latest.at))} · ${latest.decimal.toFixed(3)}${latest.line == null ? "" : ` · line ${latest.line}`}</title></circle>` : ""}`;
    }).join("");
    graphic = `<svg class="history-chart" viewBox="0 0 720 164" role="img" aria-label="Observed decimal odds for ${escape(`${game.away.id} at ${game.home.id}, ${marketName[chosen.market]}, ${chosen.side}`)}. ${points.length} stored observations. Gaps and line changes are not joined."><line class="chart-grid" x1="44" x2="676" y1="28" y2="28"/><line class="chart-grid" x1="44" x2="676" y1="132" y2="132"/><text class="chart-axis" x="4" y="32">${top.toFixed(2)}</text><text class="chart-axis" x="4" y="136">${bottom.toFixed(2)}</text>${paths}<text class="chart-axis" x="44" y="157">${escape(shortTime.format(from))}</text><text class="chart-axis chart-end" x="676" y="157">${escape(shortTime.format(to))} ET</text></svg>`;
  }
  if (!reuseGraphic) chartGraphicCache = { key: graphicKey, html: graphic, points };
  const existingGraphic = rendered.get(game.id)?.element.querySelector("[data-chart-graphic]");
  graphic = existingGraphic?.dataset.chartKey === graphicKey ? '<div data-preserve-graphic></div>' : `<div data-chart-graphic data-chart-key="${escape(graphicKey)}">${graphic}</div>`;
  const explanation = saved ? `Available server observations, up to ${Math.min(48, saved.retentionHours || 48)} hours. ${points.length ? `First shown: ${when.format(Math.min(...points.map(p => p.at)))} ET.` : "Recording starts with the first available observation."}` : `Current-tab observations since ${shortTime.format(openedAt)} ET; up to 60 minutes while saved history loads.`;
  return `<section class="history-panel" id="${historyId(game.id)}" aria-label="Price history"><div class="history-heading"><div><strong>Price history</strong><span>${saved ? "Available history · up to 48 hours" : "Current tab"} · decimal odds${savedHistory.loading ? " · loading history…" : ""}</span></div><label class="sr-only" for="history-select-${encodeURIComponent(game.id)}">Selection to chart</label><select id="history-select-${encodeURIComponent(game.id)}" data-history-select="${escape(game.id)}" data-focus="history-select">${options}</select><button class="close-history" type="button" data-close-history="${escape(game.id)}" data-focus="close-history" aria-label="Close price history">×</button></div><div class="chart-legends">${legend}</div>${graphic}<p class="history-note">${escape(explanation)} ${saved ? `<span class="history-storage">${escape(historyStorageLabel(saved.storage))}${Number.isFinite(saved.storage?.lastSavedAt) ? ` Last confirmed checkpoint: ${escape(when.format(saved.storage.lastSavedAt))} ET.` : ""}</span>` : ""} Dots mark the last recorded price of each book. Gaps, pauses and line changes start a new segment; nothing is filled in before the first observation. ${saved?.limits?.truncated ? "The observation limit was reached; only the latest retained observations are shown." : ""} ${savedHistory.error ? `<span class="history-error">${escape(savedHistory.error)} <button type="button" data-retry-history>Retry</button></span>` : ""}</p></section>`;
}
const extraNames = { "alt-spread": "Alternate spreads", "alt-total": "Alternate totals", td: "Touchdowns", "pass-yds": "Passing yards", "rush-yds": "Rushing yards", "rec-yds": "Receiving yards", receptions: "Receptions" };
const extrasId = id => `extras-${encodeURIComponent(id)}`;
function extraSourceHtml(book) {
  const s = extras.sources[book], fresh = extras.fresh(book), age = Number.isFinite(s?.lastConfirmedAt) ? Math.max(0, Math.floor((serverNow() - s.lastConfirmedAt) / 1000)) : null;
  return `<span class="extra-source ${fresh ? "" : "unavailable"}"><strong>${BOOK_NAMES[book]}</strong> · Ontario · ${fresh ? "Current" : !s || s.status === "connecting" ? "Connecting" : "Stale; excluded"}${age === null ? "" : ` · confirmed ${age}s ago`}${s?.error ? `<small>${escape(s.error)}</small>` : ""}</span>`;
}
function renderExtraSources() {
  if (!extras.gameId) return;
  const node = document.querySelector("[data-extra-sources]");
  if (node) node.innerHTML = Object.keys(BOOK_NAMES).map(extraSourceHtml).join("");
}
function extrasHtml(game) {
  if (extras.gameId !== game.id) return "";
  const visible = extras.visibleRows();
  return `<section class="extras-panel" id="${extrasId(game.id)}" aria-label="More markets"><div class="extras-heading"><div><strong>More markets</strong><p>Full game · Ontario · same player, side and line to compare</p></div><button class="close-history" type="button" data-toggle-extras="${escape(game.id)}" data-focus="close-extras" aria-label="Close more markets">×</button></div><div class="extra-sources" data-extra-sources>${Object.keys(BOOK_NAMES).map(extraSourceHtml).join("")}</div><div class="extra-filters"><label>Market <select data-extra-kind data-focus="extra-kind"><option value="all">All extra markets</option>${validExtraKinds.map(k => `<option value="${k}"${extras.kind === k ? " selected" : ""}>${extraNames[k]}</option>`).join("")}</select></label><label class="search"><span aria-hidden="true">⌕</span><input type="search" placeholder="Find a player or team" aria-label="Find a player or team in extra markets" data-extra-search data-focus="extra-search" value="${escape(extras.query)}"></label></div><div class="comparison-scroll" tabindex="0" data-focus="extra-scroll" data-scroll="extras" aria-label="Extra market comparison"><table class="comparison-table extra-table"><thead><tr><th scope="col">Selection</th><th scope="col">DraftKings</th><th scope="col">FanDuel</th></tr></thead><tbody>${visible.rows.map(row => {
    const comparison = extraOffers(row, extras.sources, { now: serverNow(), connected: extras.connected, clockUncertaintyMs: clockUncertainty ?? 0 });
    return `<tr><th scope="row">${escape(row.name || row.subject || "Selection")}<small>${escape(extraNames[row.kind] ?? row.kind)}${row.line == null ? "" : ` · ${escape(extraLineLabel(row))}`}${row.comparable === false ? " · separate contract" : ""}</small></th>${Object.keys(BOOK_NAMES).map(book => {
      const q = comparison.offers[book];
      return `<td><span class="extra-price ${q.available && comparison.bestBooks.includes(book) ? "best" : ""} ${q.stale ? "unavailable" : ""}">${!row.offers?.[book] ? "—" : q.suspended ? "Paused" : escape(odds(q.american))}<small>${!row.offers?.[book] ? "Not offered" : q.stale ? "Stale · excluded" : q.suspended ? "Excluded" : comparison.bestBooks.includes(book) ? "Best identical line" : q.available ? "Available" : "Invalid price · excluded"}</small>${q.protection ? `<small>${escape(q.protection === "early_exit" ? "Early-exit protection" : q.protection === "bet_protect" ? "Bet Protect" : q.protection)}</small>` : ""}</span></td>`;
    }).join("")}</tr>`;
  }).join("") || `<tr><td colspan="3" class="extras-empty">${!extras.connected || Object.values(extras.sources).some(source => source.status === "connecting") ? "Loading extra markets… Main prices continue updating above." : !Object.keys(BOOK_NAMES).some(book => extras.fresh(book)) ? "Extra markets are temporarily unavailable. Source details above explain what is happening; main prices update independently." : "No extra markets match this filter. Some markets are offered closer to kickoff."}</td></tr>`}</tbody></table></div><div class="extra-footer"><span>${visible.total} ${visible.total === 1 ? "selection" : "selections"}${extras.message ? ` · ${escape(extras.message)}` : ""}</span><div><button type="button" data-extra-page="${extras.page - 1}" data-focus="extra-prev" ${extras.page === 0 ? "disabled" : ""}>Previous</button><span>${extras.page + 1} / ${visible.pageCount}</span><button type="button" data-extra-page="${extras.page + 1}" data-focus="extra-next" ${extras.page + 1 >= visible.pageCount ? "disabled" : ""}>Next</button></div></div><p class="history-note">${escape(extras.rulesNote || "Full-game player markets can have different participation and early-exit protection rules at each book. Check the book’s settlement rules.")} Loaded only while this panel is open; extra markets refresh separately. Different protection rules are not ranked.</p></section>`;
}
function gameHtml(game) {
  const starred = favorites.has(game.id), analysis = gameAnalysis(game);
  return `<div class="game-meta"><div class="game-meta-left"><button type="button" class="star-game" data-star-game="${escape(game.id)}" data-focus="star" aria-pressed="${starred}" aria-label="${starred ? "Unstar" : "Star"} ${escape(`${game.away.name} at ${game.home.name}`)}">${starred ? "★" : "☆"}</button><time datetime="${escape(game.startsAt)}">${when.format(new Date(game.startsAt))}</time><span class="state-tag ${game.live ? "live" : ""}">${game.live ? "LIVE" : "PREGAME"}</span></div><div class="game-meta-right"><span class="${game.books.length < 2 ? "one-book" : ""}">${game.matchWarning ? escape(game.matchWarning) : game.books.length === 2 ? "2 books" : `${BOOK_NAMES[game.books[0]]} only`}</span><button type="button" class="history-toggle" data-toggle-history="${escape(game.id)}" data-focus="history-toggle" aria-expanded="${charts.has(game.id)}" aria-controls="${historyId(game.id)}">${charts.has(game.id) ? "Close history" : "Price history"} <span aria-hidden="true">⌁</span></button><button type="button" class="history-toggle" data-toggle-extras="${escape(game.id)}" data-focus="extras-toggle" aria-expanded="${extras.gameId === game.id}" aria-controls="${extrasId(game.id)}">More markets <span aria-hidden="true">${extras.gameId === game.id ? "−" : "+"}</span></button></div></div>${preferences.layout === "grid" ? gridHtml(game) : ["away", "home"].map((side, i) => `<div class="game-row"><div class="team"><span class="team-badge">${escape(game[side].id)}</span><span class="team-name">${escape(game[side].name)}<small>${side}</small></span></div>${cell(game, "moneyline", side)}${cell(game, "spread", side)}${cell(game, "total", i === 0 ? "over" : "under")}</div>`).join("")}<div class="analysis-summary"><span>${Number.isFinite(analysis.bestHoldPercent) ? `Lowest implied margin ${percent(analysis.bestHoldPercent)}` : "No complete same-line margin"}</span>${analysis.groups.some(g => g.arbitrageCandidate) ? '<span class="candidate">Arbitrage candidate · see estimates</span>' : ""}</div>${analyticsHtml(game)}${chartHtml(game)}${extrasHtml(game)}`;
}
function replaceGameContents(element, html) {
  const active = element.contains(document.activeElement) ? document.activeElement : null;
  const focused = active?.dataset.focus, selection = typeof active?.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
  const existingGraphic = element.querySelector("[data-chart-graphic]");
  const scrollPositions = [...element.querySelectorAll("[data-scroll]")].map(node => [node.dataset.scroll, node.scrollLeft]);
  element.innerHTML = html;
  const placeholder = element.querySelector("[data-preserve-graphic]");
  if (placeholder && existingGraphic) placeholder.replaceWith(existingGraphic);
  for (const [key, left] of scrollPositions) { const node = element.querySelector(`[data-scroll="${CSS.escape(key)}"]`); if (node) node.scrollLeft = left; }
  if (focused) { const next = element.querySelector(`[data-focus="${CSS.escape(focused)}"]`); next?.focus({ preventScroll: true }); if (selection && next?.setSelectionRange) next.setSelectionRange(...selection); }
}
function renderActivity() {
  const moves = history.recent.filter(m => view === "best" || m.book === view);
  $("move-count").textContent = String(moves.length);
  $("recent-moves").innerHTML = moves.length ? `<ol>${moves.slice(0, 8).map(m => {
    const side = m.side === "away" ? m.away : m.side === "home" ? m.home : m.side;
    const previous = m.before.suspended ? "Paused" : `${lineText(m.before)} ${odds(m.before.american)}`.trim();
    const current = m.after.suspended ? `${lineText(m.after)} Paused`.trim() : `${lineText(m.after)} ${odds(m.after.american)}`.trim();
    return `<li><button type="button" data-move-game="${escape(m.gameId)}" data-move-market="${m.market}" data-move-side="${m.side}"><span><strong>${escape(`${m.away} @ ${m.home}`)}</strong> · ${marketName[m.market]} ${side}</span><span class="move-values"><s>${escape(previous)}</s> <span class="${m.kind === "price" ? m.direction > 0 ? "higher" : "lower" : "line-move"}">${m.kind === "line" ? "↔" : m.kind === "price" ? m.direction > 0 ? "↑" : "↓" : "→"}</span> ${escape(current)}${m.kind === "line" ? ' <em>line changed</em>' : ""}</span><span class="move-book">${BOOK_NAMES[m.book]} · ${escape(shortTime.format(m.at))}</span></button></li>`;
  }).join("")}</ol>` : '<p>No changes observed in this view since this page opened. Initial and reconnect snapshots establish a baseline.</p>';
}
function render() {
  markSourceGaps();
  movementDeadline = Infinity;
  renderSource("draftkings"); renderSource("fanduel");
  $("connection").textContent = connected ? "● Auto-updating" : loaded ? "○ Reconnecting" : "Connecting…";
  $("game-count").textContent = games.size || "—";
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
  $("odds-format").value = format;
  document.documentElement.dataset.scheme = preferences.scheme;
  document.documentElement.dataset.density = preferences.density;
  document.documentElement.dataset.layout = preferences.layout;
  $("layout-choice").value = preferences.layout; $("sort-choice").value = preferences.sort;
  $("density-toggle").setAttribute("aria-pressed", String(preferences.density === "compact"));
  $("theme-toggle").setAttribute("aria-pressed", String(preferences.scheme === "dark"));
  $("starred-toggle").setAttribute("aria-pressed", String(starredOnly));
  $("star-count").textContent = [...favorites].filter(id => games.has(id)).length;
  const query = $("search").value.trim().toLowerCase(), filter = $("game-filter").value;
  const healthKey = JSON.stringify([freshness("draftkings"), freshness("fanduel")]);
  const candidates = [...games.values()].filter(g => (!query || `${g.away.name} ${g.home.name} ${g.away.id} ${g.home.id}`.toLowerCase().includes(query)) && (filter === "all" || (filter === "live" ? g.live : !g.live)) && (!starredOnly || favorites.has(g.id)));
  const analyses = new Map(candidates.map(game => [game.id, gameAnalysis(game)]));
  const visible = sortGames(candidates, { favorites, sort: preferences.sort, analytics: analyses });
  const visibleIds = new Set(visible.map(g => g.id));
  if (extras.gameId && !visibleIds.has(extras.gameId)) extras.close();
  for (const id of charts.keys()) if (!visibleIds.has(id)) { charts.delete(id); savedHistory.close(); }
  for (const id of analyticsCache.keys()) if (!games.has(id)) analyticsCache.delete(id);
  const container = $("board");
  if (!visible.length) {
    rendered.clear();
    const title = games.size ? filter === "live" ? "No live NFL games right now" : "No matching games" : loaded ? "Waiting for available odds" : "Connecting to the books";
    container.innerHTML = `<div class="empty-state"><h2>${title}</h2><p>${games.size ? "Clear the search, turn off Starred or choose All games to see more." : "Each book connects independently. Check the source status above."}</p></div>`;
  } else {
    container.querySelector(".empty-state")?.remove();
    const ids = new Set(visible.map(g => g.id));
    for (const [id, item] of rendered) if (!ids.has(id)) { item.element.remove(); rendered.delete(id); }
    let nextElement = container.firstElementChild;
    for (const game of visible) {
      const cues = game.quotes.map(q => { const move = history.changeFor(q); if (move) movementDeadline = Math.min(movementDeadline, move.at + 8000); return move?.at ?? null; });
      const key = JSON.stringify([game, view, format, healthKey, preferences.layout, favorites.has(game.id), analyticsOpen, charts.get(game.id), cues, charts.has(game.id) ? [savedHistory.data ? null : history.version, savedHistory.version] : null, extras.gameId === game.id ? extras.version : null]);
      let item = rendered.get(game.id);
      if (!item) {
        const element = document.createElement("article"); element.className = "game"; element.dataset.gameId = game.id;
        element.setAttribute("aria-label", `${game.away.name} at ${game.home.name}`);
        item = { element, key: null }; rendered.set(game.id, item);
      }
      if (item.key !== key) { replaceGameContents(item.element, gameHtml(game)); item.key = key; }
      if (item.element !== nextElement) container.insertBefore(item.element, nextElement);
      nextElement = item.element.nextElementSibling;
    }
  }
  const matched = visible.filter(g => g.books.length === 2).length;
  $("board-summary").textContent = `${visible.length} ${visible.length === 1 ? "game" : "games"} shown · ${matched} matched · ${format === "decimal" ? "Decimal" : "American"} odds · Toronto time`;
  renderActivity(); lastHealthKey = healthKey;
}
function updateUrl() {
  const url = new URL(location.href);
  if (view === "best") url.searchParams.delete("view"); else url.searchParams.set("view", view);
  if (format === "american") url.searchParams.delete("odds"); else url.searchParams.set("odds", format);
  window.history.replaceState(null, "", url);
}
function setPreference(key, value) { preferences[key] = safePreference(key, value); storage.set(preferences[key], key); render(); }
function toggleStar(id) { favorites.has(id) ? favorites.delete(id) : favorites.add(id); storage.set(JSON.stringify([...favorites].slice(-100)), "favorites"); render(); }
function closeChart() { charts.clear(); savedHistory.close(); chartGraphicCache = null; }
function selectChart(gameId, market = "moneyline", side = "away") {
  charts.clear(); charts.set(gameId, { market, side }); savedHistory.select({ gameId, market, side }); render();
}
function selectView(value) { view = safeView(value); updateUrl(); render(); }
for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => selectView(button.dataset.view));
$("odds-format").addEventListener("change", event => { format = safeFormat(event.target.value); storage.set(format); updateUrl(); render(); });
window.addEventListener("popstate", () => { const p = new URLSearchParams(location.search); view = safeView(p.get("view")); format = safeFormat(p.get("odds") ?? storage.get()); render(); });
$("search").addEventListener("input", render); $("game-filter").addEventListener("change", render);
$("layout-choice").addEventListener("change", e => setPreference("layout", e.target.value));
$("sort-choice").addEventListener("change", e => setPreference("sort", e.target.value));
$("density-toggle").addEventListener("click", () => setPreference("density", preferences.density === "compact" ? "comfortable" : "compact"));
$("theme-toggle").addEventListener("click", () => setPreference("scheme", preferences.scheme === "dark" ? "light" : "dark"));
$("starred-toggle").addEventListener("click", () => { starredOnly = !starredOnly; render(); });
$("analytics-guide").addEventListener("toggle", () => { analyticsOpen = $("analytics-guide").open; render(); });
$("policy-toggle").addEventListener("click", () => { const open = $("policy").hidden; $("policy").hidden = !open; $("policy-toggle").setAttribute("aria-expanded", String(open)); });
$("help-toggle").addEventListener("click", () => $("keyboard-help").showModal());
$("help-close").addEventListener("click", () => $("keyboard-help").close());
document.addEventListener("keydown", event => {
  const action = shortcutAction(event); if (!action || ($("keyboard-help").open && action !== "escape")) return;
  if (action === "escape") {
    if ($("keyboard-help").open) return;
    if (document.activeElement === $("search") && $("search").value) { $("search").value = ""; render(); }
    else if (document.activeElement?.closest(".extras-panel")) { const id = extras.gameId; extras.close(); render(); rendered.get(id)?.element.querySelector("[data-toggle-extras]")?.focus(); }
    else if (document.activeElement?.closest(".history-panel")) { const id = [...charts.keys()][0]; closeChart(); render(); rendered.get(id)?.element.querySelector("[data-toggle-history]")?.focus(); }
    else return;
  } else if (action === "search") $("search").focus();
  else if (["best", "draftkings", "fanduel"].includes(action)) selectView(action);
  else if (action === "density") $("density-toggle").click();
  else if (action === "scheme") $("theme-toggle").click();
  else if (action === "help") $("keyboard-help").showModal();
  else if (action === "star") { const id = document.activeElement?.closest("[data-game-id]")?.dataset.gameId; if (!id) return; toggleStar(id); }
  event.preventDefault();
});
$("board").addEventListener("click", event => {
  const target = event.target.closest("button"); if (!target) return;
  if (target.dataset.chartGame) { selectChart(target.dataset.chartGame, target.dataset.chartMarket, target.dataset.chartSide); return; }
  if (target.dataset.starGame) { toggleStar(target.dataset.starGame); return; }
  if (target.dataset.toggleExtras) { const id = target.dataset.toggleExtras; extras.gameId === id ? extras.close() : extras.open(id); render(); if (target.classList.contains("close-history")) rendered.get(id)?.element.querySelector("[data-toggle-extras]")?.focus({ preventScroll: true }); return; }
  if (target.hasAttribute("data-extra-page")) { extras.setFilter({ page: Math.max(0, Number(target.dataset.extraPage)) }); return; }
  if (target.hasAttribute("data-retry-history")) { savedHistory.refresh(); return; }
  if (target.dataset.toggleHistory) { const id = target.dataset.toggleHistory; if (charts.has(id)) closeChart(); else { selectChart(id); return; } }
  else if (target.dataset.closeHistory) closeChart();
  else return;
  const closeId = target.dataset.closeHistory; render();
  if (closeId) rendered.get(closeId)?.element.querySelector("[data-toggle-history]")?.focus({ preventScroll: true });
});
$("board").addEventListener("change", event => {
  if (event.target.hasAttribute("data-extra-kind")) { extras.setFilter({ kind: event.target.value }); return; }
  if (!event.target.dataset.historySelect) return;
  const [market, side] = event.target.value.split(":"); selectChart(event.target.dataset.historySelect, market, side);
});
$("board").addEventListener("input", event => { if (event.target.hasAttribute("data-extra-search")) extras.setFilter({ query: event.target.value }); });
$("recent-moves").addEventListener("click", event => {
  const target = event.target.closest("[data-move-game]"); if (!target || !games.has(target.dataset.moveGame)) return;
  $("search").value = ""; $("game-filter").value = "all"; starredOnly = false;
  selectChart(target.dataset.moveGame, target.dataset.moveMarket, target.dataset.moveSide);
  const element = rendered.get(target.dataset.moveGame)?.element; element?.scrollIntoView({ block: "center", behavior: "instant" });
  element?.querySelector("[data-history-select]")?.focus({ preventScroll: true });
});
const syncClock = () => clockSync.sync();
function recordPaint(timing, changedGames) {
  if (!timing?.priceChanges || (view !== "best" && view !== timing.book) || document.visibilityState !== "visible" || !clockSync.estimate()) return;
  const visible = changedGames.some(game => { const element = rendered.get(game.id)?.element; if (!element) return false; const rect = element.getBoundingClientRect(); return rect.top < innerHeight && rect.bottom > 0; });
  if (!visible) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!connected || document.visibilityState !== "visible" || !clockSync.estimate()) return;
    const paintedAt = serverNow(), value = paintedAt - timing.receivedAt;
    $("paint-latency").textContent = `${Math.round(value)} ms · ${BOOK_NAMES[timing.book]}`;
    for (const phase of timing.phases) void fetch("/api/telemetry", { method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
      body: JSON.stringify({ book: timing.book, phase, backendToPaintMs: value, feedCreatedToPaintMs: timing.sourceCreatedAt ? paintedAt - timing.sourceCreatedAt : null,
        pushUpdatedToPaintUpperBoundMs: timing.sourceUpdatedAt ? paintedAt - timing.sourceUpdatedAt : null, clockUncertaintyMs: clockUncertainty }) }).catch(() => {});
  }));
}
function disconnected() {
  if (connected) history.disconnect();
  connected = false; render();
}
function applyStreamEvent(type, data) {
  if (type === "snapshot") {
    games = new Map(data.games.map(g => [g.id, g])); sources = data.sources; revision = data.revision;
    connected = true; loaded = true;
    history.recordGames(data.games.map(g => ({ ...g, quotes: g.quotes.filter(q => freshness(q.book)) })), { baseline: true, replaceAll: true }); render(); savedHistory.refresh();
  } else if (type === "delta") {
    if (data.revision <= revision) return; revision = data.revision;
    markSourceGaps();
    const removed = data.removeGameIds.map(id => ({ id, quotes: [] }));
    for (const id of data.removeGameIds) { games.delete(id); charts.delete(id); if (savedHistory.selection?.gameId === id) savedHistory.close(); }
    for (const game of data.upsertGames) games.set(game.id, game);
    const book = data.source.book; sources[book] = data.source;
    if (freshness(book)) {
      const baseline = observedHealth.get(book) === false;
      history.recordGames(baseline ? [...games.values()] : data.upsertGames, { baseline, book });
    } else history.disconnect(Date.now(), book);
    history.recordGames(removed);
    render(); recordPaint(data.timing, data.upsertGames);
    if (savedHistory.selection && data.upsertGames.some(g => g.id === savedHistory.selection.gameId)) savedHistory.refresh();
  } else if (type === "status") {
    if (data.revision <= revision) return; revision = data.revision; sources[data.source.book] = data.source;
    renderSource(data.source.book);
    if (JSON.stringify([freshness("draftkings"), freshness("fanduel")]) !== lastHealthKey) render();
  } else if (type === "freshness") {
    const patch = mergeFreshness(sources, data, revision);
    if (!patch) return;
    sources = patch.sources; revision = patch.revision;
    for (const book of patch.updatedBooks) renderSource(book);
    if (JSON.stringify([freshness("draftkings"), freshness("fanduel")]) !== lastHealthKey) render();
  }
}
const stream = new BoardStream({ getClock: () => clockSync.estimate(),
  onEvent: applyStreamEvent, onDisconnect: disconnected });
setInterval(() => {
  renderSource("draftkings"); renderSource("fanduel"); extras.tick(); renderExtraSources();
  if (Date.now() >= movementDeadline || JSON.stringify([freshness("draftkings"), freshness("fanduel")]) !== lastHealthKey) render();
  if (Date.now() - lastClockSync > 60000) { lastClockSync = Date.now(); void syncClock(); }
}, 1000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { stream.resume(); extras.resume(); savedHistory.refresh(); void syncClock(); render(); }
});
render(); stream.start(); void syncClock();
