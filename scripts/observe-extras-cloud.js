import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';

const base = 'https://fieldline-codex.onrender.com';
const [version, output] = process.argv.slice(2);
assert.match(version ?? '', /^[a-f\d]{7,40}$/i); assert.ok(output);
// Reserve the result path before opening cloud subscriptions; never discover an
// existing report only after the experiment has consumed three minutes.
const file = await open(output, 'wx');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const books = ['draftkings', 'fanduel'];
const get = async path => { const r = await fetch(base + path, { signal: AbortSignal.timeout(15000) }); assert.equal(r.status, 200); return r.json(); };
const stats = values => { const s = values.filter(Number.isFinite).sort((a, b) => a - b); const q = p => s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] ?? null; return { n: s.length, mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null, p50: q(.5), p95: q(.95), max: s.at(-1) ?? null }; };
const healthy = (s, at, uncertainty = 0) => s?.region === 'Ontario' && s.status === 'healthy' && Number.isFinite(s.lastConfirmedAt) && Number.isFinite(s.staleAfterMs) && s.staleAfterMs > 0 && Number.isFinite(at) && at - s.lastConfirmedAt >= -uncertainty && Math.max(0, at - s.lastConfirmedAt) + uncertainty < s.staleAfterMs;
const complete = s => s?.coverage?.requested > 0 && s.coverage.returned === s.coverage.requested && Array.isArray(s.coverage.missingIds) && s.coverage.missingIds.length === 0;
const policy = s => ({ games: s.games, quotes: s.quotes, requestedMarkets: s.coverage?.requested, pollMs: s.pollMs, intervalMs: s.channels?.polling?.intervalMs, pushVerified: s.channels?.push?.verified, pushStatus: s.channels?.push?.status, subscribedMarkets: s.channels?.push?.subscribedMarkets });
const delta = (after, before, name) => { assert.ok(Number.isFinite(after) && Number.isFinite(before) && after >= before, `Counter ${name} missing or reset`); return after - before; };
let streams = [], active = null, interrupted = null, calibration = null, mainSources = {}, initial = null;
const stop = signal => { interrupted = signal; for (const s of streams) s.close(); };
const onInt = () => stop('SIGINT'), onTerm = () => stop('SIGTERM');
process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
function assertRunning() { assert.ok(!interrupted, `Interrupted by ${interrupted}`); }
const serverClock = () => ({ now: calibration.serverAt + performance.now() - calibration.midpoint, uncertainty: calibration.rttMs / 2 });
async function calibrate() {
 const samples = [];
 for (let i = 0; i < 3; i++) { const begin = performance.now(), data = await get('/api/time'), end = performance.now(); assert.ok(Number.isFinite(data.now)); samples.push({ serverAt: data.now, midpoint: (begin + end) / 2, rttMs: end - begin }); }
 calibration = samples.sort((a, b) => a.rttMs - b.rttMs)[0]; assert.ok(calibration.rttMs < 5000, 'Clock uncertainty is too large for freshness checks'); return { ...calibration };
}
function stream(path, onFrame = () => {}) {
 const controller = new AbortController(), s = { snapshot: null, error: null, openedAt: performance.now(), lastFrameAt: null, lastSentAt: null, close: () => controller.abort() };
 s.done = (async () => { try {
  const r = await fetch(base + path, { signal: controller.signal }); assert.equal(r.status, 200); let buffer = ''; const decoder = new TextDecoder();
  for await (const chunk of r.body) {
   buffer += decoder.decode(chunk, { stream: true }); assert.ok(buffer.length < 3 * 1024 * 1024); let end;
   while ((end = buffer.indexOf('\n\n')) >= 0) {
    const frame = buffer.slice(0, end + 2); buffer = buffer.slice(end + 2);
    const type = frame.match(/^event: (.+)$/m)?.[1], raw = frame.match(/^data: (.+)$/m)?.[1]; if (!type || !raw) continue;
    const data = JSON.parse(raw), at = performance.now(); assert.ok(Number.isFinite(data.sentAt)); s.lastFrameAt = at; s.lastSentAt = data.sentAt;
    if (type === 'snapshot') s.snapshot = data;
    onFrame({ type, data, at, bytes: Buffer.byteLength(frame) });
   }
  }
  if (!controller.signal.aborted) throw Error('Stream ended unexpectedly');
 } catch (error) { if (!controller.signal.aborted) s.error = String(error); } })(); return s;
}
function checkStream(s) {
 assertRunning(); assert.ok(!s.error, s.error ?? 'Stream error');
 assert.ok(performance.now() - (s.lastFrameAt ?? s.openedAt) < 12000, 'SSE stream stopped responding');
 if (calibration && s.lastSentAt) { const clock = serverClock(); assert.ok(clock.now - s.lastSentAt < 12000 + clock.uncertainty, 'SSE frames arrived behind the live stream'); }
}
async function waitFor(predicate, observed, timeout, message) {
 const deadline = performance.now() + timeout;
 while (!predicate()) { assertRunning(); for (const s of observed) checkStream(s); assert.ok(performance.now() < deadline, message); await delay(200); }
}
function checkSources(sources, at, uncertainty = 0) {
 for (const book of books) assert.ok(healthy(sources[book], at, uncertainty), `${book} is not confirmed fresh in Ontario`);
 assert.ok(complete(sources.fanduel), 'Main FanDuel coverage is incomplete');
}
const report = { createdAt: new Date().toISOString(), base, expectedVersion: version,
 method: 'Same cloud instance: 60s extras closed, 60s after two extra-market games become healthy, 60s closed again. Main SSE and 10s metric sampling are identical. Cloud-clock calibration precedes each measured phase; source health and SSE silence are checked each second.',
 limitations: ['Sequential windows cannot remove upstream/network variation or prove causal zero overhead.', 'FanDuel completed polling cycles per second measure collector throughput, not bookmaker-change latency, push latency or browser paint.', 'SSE receive gaps include freshness and heartbeats and are transport continuity measurements only.', 'This run tests availability and error counters; independent quote-by-quote verification is a separate test.', 'No finite sample proves permanent zero overhead or 100% accuracy.', 'History persistence remains enabled in every phase; checkpoint timing is recorded but not controlled.'], trials: [], pass: false };
try {
 const main = stream('/api/events', frame => {
  if (frame.type === 'snapshot') mainSources = frame.data.sources;
  else if (frame.data.source) mainSources[frame.data.source.book] = frame.data.source;
  else if (frame.type === 'freshness') for (const [book, patch] of Object.entries(frame.data.sources ?? {})) if (mainSources[book]) for (const key of ['lastConfirmedAt', 'lastDataAt', 'lastChangeAt']) if (Number.isFinite(patch[key]) && patch[key] > (mainSources[book][key] ?? 0)) mainSources[book][key] = patch[key];
  if (active && frame.at >= active.start && frame.at <= active.end) {
   checkSources(mainSources, frame.data.sentAt);
   for (const book of books) assert.deepEqual(policy(mainSources[book]), policy(initial.sources[book]), `${book} workload or transport policy changed`);
   active.frames.push({ type: frame.type, elapsedMs: frame.at - active.start, bytes: frame.bytes, book: frame.data.source?.book ?? null, priceChanges: frame.data.timing?.priceChanges ?? null });
  }
 }); streams.push(main);
 await waitFor(() => main.snapshot, [main], 15000, 'Main SSE snapshot timeout');
 initial = await get('/api/metrics'); assert.ok(initial.version.startsWith(version));
 assert.equal(initial.extras.activeGames, 0, 'Close visual extra panels before running the controlled test'); assert.equal(initial.extras.viewers, 0);
 report.instanceStartedAt = initial.startedAt; report.version = initial.version; report.initialMainViewers = initial.viewers;
 const board = await get('/api/board'), games = [['CAR', 'GB'], ['BAL', 'BUF']].map(([away, home]) => board.games.find(g => g.away.id === away && g.home.id === home && books.every(b => g.books.includes(b))));
 assert.ok(games.every(Boolean), 'Both selected games must have both books'); report.games = games.map(g => g.id);
 const check = (m, expectedExtras) => {
  assertRunning(); assert.equal(m.version, initial.version); assert.equal(m.startedAt, initial.startedAt); checkSources(m.sources, m.generatedAt);
  assert.equal(m.viewers, initial.viewers, 'Main viewer count changed during the controlled observation');
  assert.equal(m.extras.activeGames, expectedExtras); assert.equal(m.extras.viewers, expectedExtras, 'Another extra-market viewer joined');
  assert.equal(m.history.storage.available, true); assert.ok(Number.isFinite(m.history.storage.lastSavedAt)); assert.equal(m.history.queueOverflows, initial.history.queueOverflows);
  for (const book of books) { assert.deepEqual(policy(m.sources[book]), policy(initial.sources[book]), `${book} workload or transport policy changed`); assert.equal(m.sources[book].lastErrorAt, initial.sources[book].lastErrorAt, `${book} had a source failure during the experiment`); }
 };
 let extras = [];
 for (const mode of ['closed-before', 'two-games-open', 'closed-after']) {
  await calibrate();
  if (mode === 'two-games-open') {
   extras = games.map(g => stream('/api/extras/events?gameId=' + encodeURIComponent(g.id))); streams.push(...extras);
   await waitFor(() => { const clock = serverClock(); return extras.every(s => s.snapshot && books.every(book => healthy(s.snapshot.sources[book], clock.now, clock.uncertainty) && s.snapshot.sources[book].coverage?.complete === true)); }, [main, ...extras], 90000, 'Extra-market warmup timeout');
  } else if (extras.length) {
   for (const s of extras) s.close(); await Promise.all(extras.map(s => s.done)); extras = [];
   // Confirm actual service release instead of assuming a fixed cleanup delay.
   const deadline = performance.now() + 15000;
   for (;;) { const metrics = await get('/api/metrics'); if (metrics.extras.activeGames === 0 && metrics.extras.viewers === 0) break; assert.ok(performance.now() < deadline, 'Extra subscriptions did not release'); await delay(250); }
  }
  const clockCalibration = await calibrate(), before = await get('/api/metrics'); check(before, extras.length); checkStream(main);
  const trial = { mode, startedAt: new Date().toISOString(), clockCalibration, before, samples: [], frames: [], extraRequests: [] };
  const start = performance.now(); active = { start, end: start + 60000, frames: trial.frames }; report.trials.push(trial);
  console.log(JSON.stringify({ phase: mode, startedAt: trial.startedAt })); let next = start + 10000; const seen = new Set();
  while (performance.now() < active.end) {
   await delay(Math.min(1000, Math.max(1, active.end - performance.now()))); checkStream(main);
   const clock = serverClock(); checkSources(mainSources, clock.now, clock.uncertainty);
   for (const s of extras) {
    checkStream(s);
    for (const book of books) {
     const source = s.snapshot.sources[book]; assert.ok(healthy(source, clock.now, clock.uncertainty) && source.coverage?.complete === true, `${book} extra-market data is not fresh and complete`);
     const key = `${s.snapshot.gameId}|${book}|${source.lastConfirmedAt}`;
     if (!seen.has(key)) { seen.add(key); trial.extraRequests.push({ gameId: s.snapshot.gameId, book, lastConfirmedAt: source.lastConfirmedAt, requestMs: source.requestMs }); }
    }
   }
   if (performance.now() >= next && performance.now() < active.end - 1000) {
    const m = await get('/api/metrics'); check(m, extras.length);
    trial.samples.push({ at: m.generatedAt, sourceAges: Object.fromEntries(books.map(book => [book, m.generatedAt - m.sources[book].lastConfirmedAt])), extras: m.extras, storage: m.history.storage }); next += 10000;
   }
  }
  active = null; const after = await get('/api/metrics'); check(after, extras.length); trial.after = after;
  const bp = before.sources.fanduel.channels.polling, ap = after.sources.fanduel.channels.polling;
  trial.pollingDelta = Object.fromEntries(['successfulCycles', 'failedCycles', 'partialCycles', 'rateLimitedCycles'].map(key => [key, delta(ap[key], bp[key], key)]));
  trial.metricsWindowMs = after.generatedAt - before.generatedAt; assert.ok(trial.metricsWindowMs > 0);
  trial.cyclesPerSecond = trial.pollingDelta.successfulCycles / (trial.metricsWindowMs / 1000);
  const frameTimes = [0, ...trial.frames.map(f => f.elapsedMs), 60000];
  trial.receiveGapsMs = stats(frameTimes.slice(1).map((at, i) => at - frameTimes[i]));
  trial.priceChanges = Object.fromEntries(books.map(book => [book, delta(after.sources[book].priceChanges, before.sources[book].priceChanges, book + 'priceChanges')]));
  trial.extraRequestMs = Object.fromEntries(books.map(book => [book, stats(trial.extraRequests.filter(r => r.book === book && r.lastConfirmedAt >= before.generatedAt && r.lastConfirmedAt <= after.generatedAt).map(r => r.requestMs))]));
  assert.ok(trial.frames.length > 0); assert.ok(trial.pollingDelta.successfulCycles > 0);
  for (const key of ['failedCycles', 'partialCycles', 'rateLimitedCycles']) assert.equal(trial.pollingDelta[key], 0, `${key} occurred`);
  assert.equal(after.extras.failures, before.extras.failures); assert.equal(after.extras.workerRestarts, before.extras.workerRestarts);
  console.log(JSON.stringify({ mode, cyclesPerSecond: trial.cyclesPerSecond, polling: trial.pollingDelta, gaps: trial.receiveGapsMs, extraRequestMs: trial.extraRequestMs, priceChanges: trial.priceChanges }));
 }
 const [a, b, c] = report.trials;
 const closedRate = (a.pollingDelta.successfulCycles + c.pollingDelta.successfulCycles) / ((a.metricsWindowMs + c.metricsWindowMs) / 1000);
 report.summary = { closedCombinedCyclesPerSecond: closedRate, openCyclesPerSecond: b.cyclesPerSecond, openVsClosedPercent: (b.cyclesPerSecond / closedRate - 1) * 100, interpretation: 'Observed polling-throughput difference under checked health/workload conditions; not a measured change in upstream odds latency or proof of zero overhead.' };
 report.pass = true;
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; console.log(report.error); }
finally {
 active = null; for (const s of streams) s.close();
 let cleanupTimer;
 const cleaned = await Promise.race([Promise.all(streams.map(s => s.done)).then(() => true), new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(false), 5000); })]); clearTimeout(cleanupTimer);
 report.observersClosed = cleaned; if (!cleaned) { report.pass = false; report.cleanupError = 'Observer shutdown exceeded five seconds'; process.exitCode = 1; }
 report.finishedAt = new Date().toISOString();
 await file.write(JSON.stringify(report, null, 2) + '\n', 0, 'utf8'); await file.close();
 process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
 console.log(JSON.stringify({ pass: report.pass, output, summary: report.summary }));
}
