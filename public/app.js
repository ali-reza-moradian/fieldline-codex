import { BOOK_NAMES, compareQuotes } from "/model.js";

const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const american = (n) =>
  n === null ? "—" : n > 0 ? `+${n}` : `−${Math.abs(n)}`;
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "PK");
const when = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
let games = new Map(),
  sources = {},
  view = "best",
  connected = false,
  loaded = false,
  revision = 0;
let clockOffset = 0,
  clockUncertainty = null,
  lastClockSync = 0;
const rendered = new Map();
function serverNow() {
  return Date.now() + clockOffset;
}
function effectiveSources() {
  return Object.fromEntries(
    Object.entries(sources).map(([k, s]) => [
      k,
      { ...s, status: connected ? s.status : "stale" },
    ]),
  );
}
function freshness(book) {
  const s = sources[book];
  return (
    connected &&
    s?.status === "healthy" &&
    serverNow() - s.lastConfirmedAt < s.staleAfterMs
  );
}
function renderSource(book) {
  const s = sources[book],
    healthy = freshness(book),
    label = s
      ? healthy
        ? "Connected"
        : s.status === "connecting" && connected
          ? "Connecting"
          : "Stale"
      : "Connecting";
  const age = s?.lastConfirmedAt
    ? Math.max(0, Math.floor((serverNow() - s.lastConfirmedAt) / 1000))
    : null;
  const ageText =
    age === null ? "Awaiting first response" : `Confirmed ${age}s ago`;
  const error =
    !connected && loaded
      ? "Browser disconnected. Reconnecting automatically."
      : s?.error;
  $(book + "-status").innerHTML =
    `<div class="source-title"><span class="book-logo ${book === "fanduel" ? "fd" : ""}">${book === "fanduel" ? "FD" : "DK"}</span>${BOOK_NAMES[book]}</div><span class="status-pill ${healthy ? "" : "stale"}">${label}</span><div class="source-details">${escape(s?.transport ?? "Establishing feed")} · ${escape(s?.region ?? "")}</div><div class="source-details right">${ageText}</div>${error ? `<div class="source-error">${escape(error)}</div>` : ""}${s?.warnings?.length ? `<div class="source-error">${s.warnings.length} item(s) excluded by validation. See measurement data.</div>` : ""}`;
}
function quoteHtml(q, books, { best = false, stale = false } = {}) {
  const line =
    q.market === "moneyline"
      ? ""
      : q.market === "spread"
        ? signed(q.line)
        : `${q.side === "over" ? "O" : "U"} ${q.line}`;
  const changed =
    serverNow() - q.changedAt < 1800 && q.previousAmerican !== null && !stale;
  const label = q.suspended ? "Suspended" : american(q.american);
  const extra = stale
    ? "STALE · excluded from best"
    : q.suspended
      ? "Market paused"
      : "";
  return `<div class="quote ${best ? "best" : ""} ${stale ? "stale" : ""} ${changed ? "changed" : ""}" title="${escape(`${q.market} ${q.side} ${line}; ${books.map((b) => BOOK_NAMES[b]).join(" & ")}${extra ? "; " + extra : ""}`)}"><span class="price">${line ? `<span class="points">${line}</span>` : ""}${label}${changed ? '<span class="price-arrow">↗</span>' : ""}</span><span class="book-name">${books.map((b) => BOOK_NAMES[b]).join(" + ")}</span>${extra ? `<small>${extra}</small>` : ""}</div>`;
}
function cell(game, market, side) {
  const matching = game.quotes.filter(
    (q) =>
      q.market === market &&
      q.side === side &&
      (view === "best" || q.book === view),
  );
  if (!matching.length)
    return '<div class="odds-cell"><div class="empty-quote" aria-label="Not offered">—</div></div>';
  const groups = compareQuotes(matching, effectiveSources(), serverNow()).sort(
    (a, b) => (a.offers[0].line ?? 0) - (b.offers[0].line ?? 0),
  );
  const contents = groups
    .map((group) => {
      if (view === "best" && group.bestBooks.length) {
        const winner = group.offers.find((q) =>
          group.bestBooks.includes(q.book),
        );
        const comparison =
          group.offers.length > 1
            ? `<div class="compare-strip">${group.offers.map((q) => `<span class="${q.stale || q.suspended ? "unavailable" : ""}">${q.book === "draftkings" ? "DK" : "FD"} ${q.suspended ? "paused" : american(q.american)}${q.stale ? " stale" : ""}</span>`).join("")}</div>`
            : "";
        return quoteHtml(winner, group.bestBooks, { best: true }) + comparison;
      }
      return group.offers
        .map((q) => quoteHtml(q, [q.book], { stale: q.stale }))
        .join("");
    })
    .join("");
  return `<div class="odds-cell">${groups.length > 1 ? '<div class="different">Different lines</div>' : ""}${contents}</div>`;
}
function gameHtml(game) {
  return `<div class="game-meta"><div class="game-meta-left"><time datetime="${escape(game.startsAt)}">${when.format(new Date(game.startsAt))}</time><span class="state-tag ${game.live ? "live" : ""}">${game.live ? "LIVE" : "PREGAME"}</span></div><span class="${game.books.length < 2 ? "one-book" : ""}">${game.matchWarning ? escape(game.matchWarning) : game.books.length === 2 ? "2 BOOKS" : `${BOOK_NAMES[game.books[0]]} ONLY`}</span></div>${["away", "home"].map((side, i) => `<div class="game-row"><div class="team"><span class="team-badge">${escape(game[side].id)}</span><span class="team-name">${escape(game[side].name)}<small>${side}</small></span></div>${cell(game, "moneyline", side)}${cell(game, "spread", side)}${cell(game, "total", i === 0 ? "over" : "under")}</div>`).join("")}`;
}
let lastHealthKey = "";
function render() {
  renderSource("draftkings");
  renderSource("fanduel");
  $("connection").textContent = connected
    ? "● Auto-updating"
    : loaded
      ? "○ Reconnecting"
      : "Connecting…";
  $("game-count").textContent = games.size || "—";
  const query = $("search").value.trim().toLowerCase(),
    filter = $("game-filter").value;
  const visible = [...games.values()]
    .filter(
      (g) =>
        (!query ||
          `${g.away.name} ${g.home.name} ${g.away.id} ${g.home.id}`
            .toLowerCase()
            .includes(query)) &&
        (filter === "all" || (filter === "live" ? g.live : !g.live)),
    )
    .sort(
      (a, b) =>
        Number(b.live) - Number(a.live) ||
        Date.parse(a.startsAt) - Date.parse(b.startsAt) ||
        a.id.localeCompare(b.id),
    );
  const healthKey = JSON.stringify([
    freshness("draftkings"),
    freshness("fanduel"),
  ]);
  const container = $("board");
  if (!visible.length) {
    rendered.clear();
    const title = games.size
      ? filter === "live"
        ? "No live NFL games right now"
        : "No matching games"
      : loaded
        ? "Waiting for available odds"
        : "Connecting to the books";
    container.innerHTML = `<div class="empty-state"><h2>${title}</h2><p>${games.size ? "The board updates automatically when games become available." : "Check the source status above. Each book connects independently."}</p></div>`;
  } else {
    container.querySelector(".empty-state")?.remove();
    const ids = new Set(visible.map((g) => g.id));
    for (const [id, item] of rendered)
      if (!ids.has(id)) {
        item.element.remove();
        rendered.delete(id);
      }
    for (const game of visible) {
      const key = JSON.stringify([game, view, healthKey]);
      let item = rendered.get(game.id);
      if (!item) {
        const element = document.createElement("article");
        element.className = "game";
        element.setAttribute(
          "aria-label",
          `${game.away.name} at ${game.home.name}`,
        );
        item = { element, key: null };
        rendered.set(game.id, item);
      }
      if (item.key !== key) {
        item.element.innerHTML = gameHtml(game);
        item.key = key;
      }
      container.append(item.element);
    }
  }
  const matched = visible.filter((g) => g.books.length === 2).length;
  $("board-summary").textContent =
    `${visible.length} games shown · ${matched} matched across both books · American odds · Toronto time`;
  lastHealthKey = healthKey;
}
for (const button of document.querySelectorAll("[data-view]"))
  button.addEventListener("click", () => {
    view = button.dataset.view;
    for (const other of document.querySelectorAll("[data-view]"))
      other.setAttribute("aria-pressed", String(other === button));
    render();
  });
$("search").addEventListener("input", render);
$("game-filter").addEventListener("change", render);
$("policy-toggle").addEventListener("click", () => {
  const open = $("policy").hidden;
  $("policy").hidden = !open;
  $("policy-toggle").setAttribute("aria-expanded", String(open));
});
async function syncClock() {
  let best;
  for (let i = 0; i < 5; i++) {
    const wallStart = Date.now(),
      start = performance.now();
    try {
      const response = await fetch("/api/time", { cache: "no-store" });
      const { now } = await response.json(),
        rtt = performance.now() - start;
      if (!best || rtt < best.rtt)
        best = { rtt, offset: now - (wallStart + rtt / 2) };
    } catch {
      /* SSE reconnect remains independent of optional measurement. */
    }
  }
  if (best) {
    clockOffset = best.offset;
    clockUncertainty = best.rtt / 2;
    lastClockSync = Date.now();
    $("clock-note").textContent =
      `Clock-sync uncertainty ≥ ±${clockUncertainty.toFixed(1)} ms`;
  }
}
function recordPaint(timing, changedGames) {
  if (
    !timing?.priceChanges ||
    (view !== "best" && view !== timing.book) ||
    document.visibilityState !== "visible" ||
    clockUncertainty === null
  )
    return;
  const visible = changedGames.some((game) => {
    const element = rendered.get(game.id)?.element;
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.top < innerHeight && rect.bottom > 0;
  });
  if (!visible) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (document.visibilityState !== "visible") return;
      const paintedAt = serverNow(),
        value = paintedAt - timing.receivedAt;
      $("paint-latency").textContent =
        `${Math.round(value)} ms · ${BOOK_NAMES[timing.book]}`;
      for (const phase of timing.phases) {
        const sample = {
          book: timing.book,
          phase,
          backendToPaintMs: value,
          feedCreatedToPaintMs: timing.sourceCreatedAt
            ? paintedAt - timing.sourceCreatedAt
            : null,
          pushUpdatedToPaintUpperBoundMs: timing.sourceUpdatedAt
            ? paintedAt - timing.sourceUpdatedAt
            : null,
          clockUncertaintyMs: clockUncertainty,
        };
        void fetch("/api/telemetry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sample),
          keepalive: true,
        }).catch(() => {});
      }
    }),
  );
}
const stream = new EventSource("/api/events");
stream.addEventListener("snapshot", (event) => {
  try {
    const data = JSON.parse(event.data);
    games = new Map(data.games.map((g) => [g.id, g]));
    sources = data.sources;
    revision = data.revision;
    connected = true;
    loaded = true;
    render();
  } catch {
    connected = false;
    render();
  }
});
stream.addEventListener("delta", (event) => {
  const data = JSON.parse(event.data);
  if (data.revision <= revision) return;
  revision = data.revision;
  for (const id of data.removeGameIds) games.delete(id);
  for (const game of data.upsertGames) games.set(game.id, game);
  sources[data.source.book] = data.source;
  render();
  recordPaint(data.timing, data.upsertGames);
});
stream.addEventListener("status", (event) => {
  const data = JSON.parse(event.data);
  if (data.revision <= revision) return;
  revision = data.revision;
  sources[data.source.book] = data.source;
  renderSource(data.source.book);
  if (
    JSON.stringify([freshness("draftkings"), freshness("fanduel")]) !==
    lastHealthKey
  )
    render();
});
stream.onerror = () => {
  connected = false;
  render();
};
setInterval(() => {
  renderSource("draftkings");
  renderSource("fanduel");
  if (
    JSON.stringify([freshness("draftkings"), freshness("fanduel")]) !==
    lastHealthKey
  )
    render();
  if (Date.now() - lastClockSync > 60000) {
    lastClockSync = Date.now();
    void syncClock();
  }
}, 1000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    void syncClock();
    render();
  }
});
render();
void syncClock();
