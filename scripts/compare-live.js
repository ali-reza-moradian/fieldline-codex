import { mkdir, writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { BoardObserver, coverage, pairChanges, valueOf, compatibleGames } from './comparison-model.js';

const seconds = Number(process.argv[2] ?? 300);
if (!Number.isFinite(seconds) || seconds < 10 || seconds > 3600) throw new Error('Duration must be 10–3600 seconds');
const apps = {
  codex: { base: process.argv[3] ?? 'https://fieldline-codex.onrender.com', stream: '/api/events' },
  claude: { base: process.argv[4] ?? 'https://nfl-odds-board-hgim.onrender.com', stream: '/api/stream' },
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = async url => {
  const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
};
const stamp = new Date().toISOString();
const dir = `data/comparison-${stamp.replace(/[:.]/g, '-')}`;
await mkdir(dir, { recursive: true });
console.log('Warming both apps and recording their current settings; no application changes.');
const before = Object.fromEntries(await Promise.all(Object.entries(apps).map(async ([name, a]) =>
  [name, await json(a.base + '/api/metrics')])));
for (const [app, metrics] of Object.entries(before)) {
  for (const book of ['draftkings', 'fanduel']) {
    const s = metrics.sources?.[book];
    if (!(app === 'codex' ? s?.status === 'healthy' : s?.stale === false && s?.state !== 'down'))
      throw new Error(`${app}/${book} is not ready. Retry after both sources recover.`);
  }
}
const controller = new AbortController();
const records = [], errors = [], connections = {};
let sequence = 0;
const epochMs = Date.now(), originMs = performance.now();
const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
const readers = Object.entries(apps).map(async ([app, a]) => {
  try {
    const r = await fetch(a.base + a.stream, { signal: controller.signal });
    if (!r.ok) throw new Error(`Stream HTTP ${r.status}`);
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of r.body) {
      // Timestamp receipt BEFORE parsing or normalizing, on one monotonic clock.
      const atMs = performance.now() - originMs;
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/); buffer = parts.pop();
      for (const part of parts) {
        const lines = part.split(/\r?\n/);
        const type = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
        const raw = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!raw) continue;
        const data = JSON.parse(raw);
        records.push({ app, atMs, batch: ++sequence, type, data });
        if (type === 'snapshot') {
          if (connections[app]) throw new Error('Unexpected second snapshot: stream reset');
          connections[app] = { atMs, initialQuotes: app === 'codex' ? data.games.reduce((n, g) => n + g.quotes.length, 0) : data.quotes.length };
        }
      }
    }
    if (!controller.signal.aborted) errors.push({ app, error: 'Stream ended early' });
  } catch (error) {
    if (!controller.signal.aborted) errors.push({ app, error: error.message });
  }
});
let startMs, endMs, captureEndMs, interrupted = false;
try {
  const deadline = performance.now() + 90000;
  while (Object.keys(connections).length < 2) {
    if (errors.length) throw new Error(JSON.stringify(errors));
    if (performance.now() > deadline) throw new Error('Both stream snapshots did not arrive');
    await sleep(100);
  }
  // Two-second warm-up: neither initial snapshot counts as a price change.
  await sleep(2000);
  startMs = performance.now() - originMs;
  endMs = startMs + seconds * 1000;
  console.log(`Both streams ready. Comparing ${seconds}s plus 15s to match changes near the end.`);
  let nextProgress = startMs + 30000;
  while (performance.now() - originMs < endMs + 15000) {
    if (errors.length) { interrupted = true; break; }
    await sleep(500);
    const now = performance.now() - originMs;
    if (now >= nextProgress) {
      console.log(`${Math.round((now - startMs) / 1000)}s: received ${records.length} stream events (includes heartbeats, not speed samples).`);
      nextProgress += 30000;
    }
  }
} catch (error) {
  errors.push({ error: error.message }); interrupted = true;
} finally {
  captureEndMs = performance.now() - originMs;
  controller.abort();
  await Promise.all(readers);
  delay.disable();
}
const after = Object.fromEntries(await Promise.all(Object.entries(apps).map(async ([name, a]) => {
  try { return [name, await json(a.base + '/api/metrics')]; }
  catch (e) { return [name, { error: e.message }]; }
})));
if (before.codex.startedAt !== after.codex.startedAt ||
    before.claude.version !== after.claude.version ||
    after.claude.uptimeSec < before.claude.uptimeSec) {
  errors.push({ error: 'A server restarted or changed version during observation' });
  interrupted = true;
}
const states = { codex: new BoardObserver('codex'), claude: new BoardObserver('claude') };
records.sort((a, b) => a.atMs - b.atMs || a.batch - b.batch);
let initialCoverage, eligible;
const changes = [], outOfBaseline = [];
const sourceStatesSeen = { codex: {}, claude: {} };
for (const row of records) {
  if (row.atMs >= startMs && !initialCoverage) {
    initialCoverage = coverage(states.codex, states.claude);
    eligible = new Set([...states.codex.quotes].filter(([k, q]) => {
      const other = states.claude.quotes.get(k);
      return other && compatibleGames(q, other) && !q.suspended && !other.suspended && Number.isFinite(q.odds) && valueOf(q) === valueOf(other);
    }).map(([k]) => k));
  }
  const updates = states[row.app].apply(row.type, row.data);
  for (const [book, source] of Object.entries(states[row.app].sources)) {
    const status = row.app === 'codex' ? source.status : `${source.state}; stale=${source.stale}`;
    (sourceStatesSeen[row.app][book] ??= new Set()).add(status);
  }
  if (row.atMs < startMs || !eligible) continue;
  for (const update of updates) {
    const change = { ...update, app: row.app, atMs: row.atMs, batch: row.batch };
    (eligible.has(update.key) ? changes : outOfBaseline).push(change);
  }
}
const result = {
  method: 'Same-process simultaneous SSE arrival race of identical active old-to-new quote transitions; negative delta means Codex arrived first.',
  apps, startedAt: new Date(epochMs + (startMs ?? 0)).toISOString(), seconds,
  observedSeconds: Math.max(0, Math.min(seconds, (captureEndMs - startMs) / 1000)),
  windowMonotonicMs: { startMs, endMs, captureEndMs },
  finishedAt: new Date().toISOString(), matchWindowMs: 15000, connections, interrupted, errors,
  observerEventLoopDelayMs: { mean: delay.mean / 1e6, p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 },
  initialCoverage, finalCoverage: coverage(states.codex, states.claude),
  sourceStatesSeen: Object.fromEntries(Object.entries(sourceStatesSeen).map(([app, books]) =>
    [app, Object.fromEntries(Object.entries(books).map(([book, values]) => [book, [...values]]))])),
  ...pairChanges(changes, { startMs, endMs }), outOfBaseline,
  limits: [
    'Measures arrival at one HTTP client, not browser paint or absolute bookmaker-change latency.',
    'One network location; paths and jitter affect results. No server/provider clock timestamps used.',
    'Multiple quotes in one update are correlated; distinct batch-pair counts are also reported.',
    'Only initially identical active quotes, same local date/teams with kickoff within 90 seconds, and identical old-to-new transitions are eligible.',
    'Unmatched changes may mean skipped intermediate prices, different scope, or delay beyond 15s; they are not assigned an invented latency.',
    'A quiet pregame window may yield no or very few paired changes. No general winner can be inferred from that.',
  ], before, after,
};
await writeFile(`${dir}/events.json`, JSON.stringify({ epochMs, records }));
await writeFile(`${dir}/result.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ directory: dir, interrupted, errors,
  initialCoverage: Object.fromEntries(Object.entries(initialCoverage ?? {}).map(([book, c]) => [book, { codex: c.codex, claude: c.claude, shared: c.shared, identicalActive: c.identicalActive, kickoffConflicts: c.kickoffConflicts.length }])),
  summary: result.summary, observerEventLoopDelayMs: result.observerEventLoopDelayMs }, null, 2));
if (interrupted) process.exitCode = 1;
