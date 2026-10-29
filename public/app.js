import { BOOK_NAMES, compareQuotes } from "/model.js";
import { formatOdds, safeView, safeFormat, sourceFresh, SessionHistory, historySegments, selectionKey } from "/presentation.js";

const $ = id => document.getElementById(id);
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const signed = n => n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "PK";
const lineText = q => q.market === "moneyline" ? "" : q.market === "total" ? `${q.side === "over" ? "O" : "U"} ${q.line}` : signed(q.line);
const marketName = { moneyline: "Moneyline", spread: "Spread", total: "Total" };
const when = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const shortTime = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const storage = { get() { try { return localStorage.getItem("fieldline.odds"); } catch { return null; } }, set(value) { try { localStorage.setItem("fieldline.odds", value); } catch { /* optional preference */ } } };
const params = new URLSearchParams(location.search);
let games = new Map(), sources = {}, view = safeView(params.get("view")), format = safeFormat(params.get("odds") ?? storage.get());
let connected = false, loaded = false, revision = 0, clockOffset = 0, clockUncertainty = null, lastClockSync = 0;
let lastHealthKey = "", movementDeadline = Infinity;
const rendered = new Map(), charts = new Map(), history = new SessionHistory();
const observedHealth = new Map();
const openedAt = Date.now();
const serverNow = () => Date.now() + clockOffset;
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
function chartHtml(game) {
  const chosen = charts.get(game.id);
  if (!chosen) return "";
  const entries = history.forSelection(game.id, chosen.market, chosen.side).filter(s => view === "best" || s.book === view);
  const data = entries.map(s => ({ ...s, segments: historySegments(s.points) }));
  const points = data.flatMap(s => s.segments.flat());
  const options = ["moneyline", "spread", "total"].flatMap(market => (market === "total" ? ["over", "under"] : ["away", "home"]).map(side => `<option value="${market}:${side}"${chosen.market === market && chosen.side === side ? " selected" : ""}>${marketName[market]} · ${market === "total" ? side : game[side].id}</option>`)).join("");
  const legend = data.map(s => {
    const q = game.quotes.find(q => q.book === s.book && q.market === chosen.market && q.side === chosen.side);
    return `<span class="chart-legend ${s.book}">${BOOK_NAMES[s.book]} <strong>${q ? `${escape(lineText(q))} ${q.suspended ? "Paused" : escape(odds(q.american))}` : "Not offered"}</strong>${!freshness(s.book) ? " · stale" : ""}</span>`;
  }).join("");
  let graphic = '<p class="chart-empty">No price observations for this selection yet.</p>';
  if (points.length) {
    const from = Math.min(...points.map(p => p.at)), to = Math.max(Date.now(), from + 1000);
    const low = Math.min(...points.map(p => p.decimal)), high = Math.max(...points.map(p => p.decimal));
    const padding = Math.max(.025, (high - low) * .15), bottom = low - padding, top = high + padding;
    const x = p => 44 + 632 * (p.at - from) / (to - from), y = p => 132 - 104 * (p.decimal - bottom) / (top - bottom);
    const paths = data.map(s => s.segments.map(segment => {
      const path = segment.map((p, i) => i ? `H${x(p).toFixed(2)}V${y(p).toFixed(2)}` : `M${x(p).toFixed(2)},${y(p).toFixed(2)}`).join("");
      return `<path class="chart-line ${s.book}" d="${path}"/>${segment.map(p => `<circle class="chart-point ${s.book}" cx="${x(p).toFixed(2)}" cy="${y(p).toFixed(2)}" r="3"><title>${BOOK_NAMES[s.book]} · ${escape(shortTime.format(p.at))} · ${p.decimal.toFixed(3)}${p.line == null ? "" : ` · line ${p.line}`}</title></circle>`).join("")}`;
    }).join("")).join("");
    graphic = `<svg class="history-chart" viewBox="0 0 720 164" role="img" aria-label="Observed decimal odds for ${escape(`${game.away.id} at ${game.home.id}, ${marketName[chosen.market]}, ${chosen.side}`)}. ${points.length} observations since this page opened. Gaps and line changes are not joined."><line class="chart-grid" x1="44" x2="676" y1="28" y2="28"/><line class="chart-grid" x1="44" x2="676" y1="132" y2="132"/><text class="chart-axis" x="4" y="32">${top.toFixed(2)}</text><text class="chart-axis" x="4" y="136">${bottom.toFixed(2)}</text>${paths}<text class="chart-axis" x="44" y="157">${escape(shortTime.format(from))}</text><text class="chart-axis chart-end" x="676" y="157">${escape(shortTime.format(to))} ET</text></svg>`;
  }
  return `<section class="history-panel" id="${historyId(game.id)}" aria-label="Price history"><div class="history-heading"><div><strong>Price history</strong><span>Observed in this tab · decimal odds</span></div><label class="sr-only" for="history-select-${encodeURIComponent(game.id)}">Selection to chart</label><select id="history-select-${encodeURIComponent(game.id)}" data-history-select="${escape(game.id)}" data-focus="history-select">${options}</select><button class="close-history" type="button" data-close-history="${escape(game.id)}" data-focus="close-history" aria-label="Close price history">×</button></div><div class="chart-legends">${legend}</div>${graphic}<p class="history-note">Since this page opened at ${escape(shortTime.format(openedAt))} ET. Last 60 minutes, up to 120 observations per book. A dot is an observation; gaps and line changes start a new segment. No history is invented before this tab opened.</p></section>`;
}
function gameHtml(game) {
  return `<div class="game-meta"><div class="game-meta-left"><time datetime="${escape(game.startsAt)}">${when.format(new Date(game.startsAt))}</time><span class="state-tag ${game.live ? "live" : ""}">${game.live ? "LIVE" : "PREGAME"}</span></div><div class="game-meta-right"><span class="${game.books.length < 2 ? "one-book" : ""}">${game.matchWarning ? escape(game.matchWarning) : game.books.length === 2 ? "2 books" : `${BOOK_NAMES[game.books[0]]} only`}</span><button type="button" class="history-toggle" data-toggle-history="${escape(game.id)}" data-focus="history-toggle" aria-expanded="${charts.has(game.id)}" aria-controls="${historyId(game.id)}">${charts.has(game.id) ? "Close history" : "Price history"} <span aria-hidden="true">⌁</span></button></div></div>${["away", "home"].map((side, i) => `<div class="game-row"><div class="team"><span class="team-badge">${escape(game[side].id)}</span><span class="team-name">${escape(game[side].name)}<small>${side}</small></span></div>${cell(game, "moneyline", side)}${cell(game, "spread", side)}${cell(game, "total", i === 0 ? "over" : "under")}</div>`).join("")}${chartHtml(game)}`;
}
function replaceGameContents(element, html) {
  const focused = element.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  element.innerHTML = html;
  if (focused) element.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
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
  const query = $("search").value.trim().toLowerCase(), filter = $("game-filter").value;
  const visible = [...games.values()].filter(g => (!query || `${g.away.name} ${g.home.name} ${g.away.id} ${g.home.id}`.toLowerCase().includes(query)) && (filter === "all" || (filter === "live" ? g.live : !g.live)))
    .sort((a, b) => Number(b.live) - Number(a.live) || Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id));
  const healthKey = JSON.stringify([freshness("draftkings"), freshness("fanduel")]);
  const container = $("board");
  if (!visible.length) {
    rendered.clear();
    const title = games.size ? filter === "live" ? "No live NFL games right now" : "No matching games" : loaded ? "Waiting for available odds" : "Connecting to the books";
    container.innerHTML = `<div class="empty-state"><h2>${title}</h2><p>${games.size ? "Clear the search or choose All games to see more." : "Each book connects independently. Check the source status above."}</p></div>`;
  } else {
    container.querySelector(".empty-state")?.remove();
    const ids = new Set(visible.map(g => g.id));
    for (const [id, item] of rendered) if (!ids.has(id)) { item.element.remove(); rendered.delete(id); }
    let nextElement = container.firstElementChild;
    for (const game of visible) {
      const cues = game.quotes.map(q => { const move = history.changeFor(q); if (move) movementDeadline = Math.min(movementDeadline, move.at + 8000); return move?.at ?? null; });
      const key = JSON.stringify([game, view, format, healthKey, charts.get(game.id), cues, charts.has(game.id) ? history.version : null]);
      let item = rendered.get(game.id);
      if (!item) {
        const element = document.createElement("article"); element.className = "game";
        element.setAttribute("aria-label", `${game.away.name} at ${game.home.name}`);
        item = { element, key: null }; rendered.set(game.id, item);
      }
      if (item.key !== key) { replaceGameContents(item.element, gameHtml(game)); item.key = key; }
      if (item.element !== nextElement) container.insertBefore(item.element, nextElement);
      nextElement = item.element.nextElementSibling;
    }
  }
  const matched = visible.filter(g => g.books.length === 2).length;
  $("board-summary").textContent = `${visible.length} games shown · ${matched} matched · ${format === "decimal" ? "Decimal" : "American"} odds · Toronto time`;
  renderActivity(); lastHealthKey = healthKey;
}
function updateUrl() {
  const url = new URL(location.href);
  if (view === "best") url.searchParams.delete("view"); else url.searchParams.set("view", view);
  if (format === "american") url.searchParams.delete("odds"); else url.searchParams.set("odds", format);
  window.history.replaceState(null, "", url);
}
for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => { view = safeView(button.dataset.view); updateUrl(); render(); });
$("odds-format").addEventListener("change", event => { format = safeFormat(event.target.value); storage.set(format); updateUrl(); render(); });
window.addEventListener("popstate", () => { const p = new URLSearchParams(location.search); view = safeView(p.get("view")); format = safeFormat(p.get("odds") ?? storage.get()); render(); });
$("search").addEventListener("input", render); $("game-filter").addEventListener("change", render);
$("policy-toggle").addEventListener("click", () => { const open = $("policy").hidden; $("policy").hidden = !open; $("policy-toggle").setAttribute("aria-expanded", String(open)); });
$("board").addEventListener("click", event => {
  const target = event.target.closest("button"); if (!target) return;
  if (target.dataset.chartGame) charts.set(target.dataset.chartGame, { market: target.dataset.chartMarket, side: target.dataset.chartSide });
  else if (target.dataset.toggleHistory) { const id = target.dataset.toggleHistory; charts.has(id) ? charts.delete(id) : charts.set(id, { market: "moneyline", side: "away" }); }
  else if (target.dataset.closeHistory) charts.delete(target.dataset.closeHistory);
  else return;
  const closeId = target.dataset.closeHistory;
  render();
  if (closeId) rendered.get(closeId)?.element.querySelector("[data-toggle-history]")?.focus({ preventScroll: true });
});
$("board").addEventListener("change", event => {
  if (!event.target.dataset.historySelect) return;
  const [market, side] = event.target.value.split(":"); charts.set(event.target.dataset.historySelect, { market, side }); render();
});
$("recent-moves").addEventListener("click", event => {
  const target = event.target.closest("[data-move-game]"); if (!target || !games.has(target.dataset.moveGame)) return;
  $("search").value = ""; $("game-filter").value = "all";
  charts.set(target.dataset.moveGame, { market: target.dataset.moveMarket, side: target.dataset.moveSide }); render();
  const element = rendered.get(target.dataset.moveGame)?.element; element?.scrollIntoView({ block: "center", behavior: "instant" });
  element?.querySelector("[data-history-select]")?.focus({ preventScroll: true });
});
async function syncClock() {
  let best;
  for (let i = 0; i < 5; i++) {
    const wallStart = Date.now(), start = performance.now();
    try { const response = await fetch("/api/time", { cache: "no-store" }); const { now } = await response.json(), rtt = performance.now() - start;
      if (!best || rtt < best.rtt) best = { rtt, offset: now - (wallStart + rtt / 2) };
    } catch { /* Source streaming does not wait for optional clock calibration. */ }
  }
  if (best) { clockOffset = best.offset; clockUncertainty = best.rtt / 2; lastClockSync = Date.now(); $("clock-note").textContent = `Clock-sync uncertainty ≥ ±${clockUncertainty.toFixed(1)} ms`; }
}
function recordPaint(timing, changedGames) {
  if (!timing?.priceChanges || (view !== "best" && view !== timing.book) || document.visibilityState !== "visible" || clockUncertainty === null) return;
  const visible = changedGames.some(game => { const element = rendered.get(game.id)?.element; if (!element) return false; const rect = element.getBoundingClientRect(); return rect.top < innerHeight && rect.bottom > 0; });
  if (!visible) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (document.visibilityState !== "visible") return;
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
const stream = new EventSource("/api/events");
stream.addEventListener("snapshot", event => {
  try {
    const data = JSON.parse(event.data); games = new Map(data.games.map(g => [g.id, g])); sources = data.sources; revision = data.revision;
    connected = true; loaded = true;
    history.recordGames(data.games.map(g => ({ ...g, quotes: g.quotes.filter(q => freshness(q.book)) })), { baseline: true, replaceAll: true }); render();
  } catch { disconnected(); }
});
stream.addEventListener("delta", event => {
  try {
    const data = JSON.parse(event.data); if (data.revision <= revision) return; revision = data.revision;
    markSourceGaps();
    const removed = data.removeGameIds.map(id => ({ id, quotes: [] }));
    for (const id of data.removeGameIds) { games.delete(id); charts.delete(id); }
    for (const game of data.upsertGames) games.set(game.id, game);
    const book = data.source.book; sources[book] = data.source;
    if (freshness(book)) {
      const baseline = observedHealth.get(book) === false;
      history.recordGames(baseline ? [...games.values()] : data.upsertGames, { baseline, book });
    } else history.disconnect(Date.now(), book);
    history.recordGames(removed);
    render(); recordPaint(data.timing, data.upsertGames);
  } catch { disconnected(); }
});
stream.addEventListener("status", event => {
  try {
    const data = JSON.parse(event.data); if (data.revision <= revision) return; revision = data.revision; sources[data.source.book] = data.source;
    renderSource(data.source.book);
    if (JSON.stringify([freshness("draftkings"), freshness("fanduel")]) !== lastHealthKey) render();
  } catch { disconnected(); }
});
stream.onerror = disconnected;
setInterval(() => {
  renderSource("draftkings"); renderSource("fanduel");
  if (Date.now() >= movementDeadline || JSON.stringify([freshness("draftkings"), freshness("fanduel")]) !== lastHealthKey) render();
  if (Date.now() - lastClockSync > 60000) { lastClockSync = Date.now(); void syncClock(); }
}, 1000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { void syncClock(); render(); } });
render(); void syncClock();
