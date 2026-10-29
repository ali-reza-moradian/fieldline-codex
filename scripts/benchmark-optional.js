#!/usr/bin/env node
/** Local paired replay, not a bookmaker/WAN speed race. Optional services are
 * disabled by injection in the control trial; both trials use the exact same
 * current store/SSE implementation and the same deterministic price changes. */
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/server.js';
import { OddsStore } from '../src/store.js';
import { PriceHistory } from '../src/price-history.js';
import { ExtrasService } from '../src/extras-service.js';

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const i = arg.indexOf('='); return [arg.slice(2, i), arg.slice(i + 1)]; }));
const integer = (key, fallback, min, max) => { const value = Number(args[key] ?? fallback); if (!Number.isInteger(value) || value < min || value > max) throw Error(`--${key} must be an integer between ${min} and ${max}`); return value; };
const config = { updatesPerTrial: integer('updates', 500, 20, 5000), intervalMs: integer('interval-ms', 32, 0, 500),
  pairedRounds: integer('rounds', 2, 1, 5), mainGames: 16, extraGames: 2, extraRowsPerBookPerGame: 700,
  extraPollMs: 15000, historyPoints: 150000, historySeries: 50, historySpanHours: 48,
  checkpointPerActiveTrial: 1, historyQueryEveryUpdates: 50 };
const noopPersistence = () => ({ start() {}, close: async () => {}, status: () => ({ enabled: false, state: 'disabled', available: false }) });
const noopHistory = () => ({ attach: () => () => {}, limits: () => ({}), query: () => ({ series: [] }) });
const noopExtras = () => ({ heartbeat() {}, stop() {}, report: () => ({ viewers: 0, activeGames: 0 }) });
class FakeWorker extends EventEmitter { connected = true; send(_message, done) { done?.(); } kill() { this.connected = false; } }
const round = value => Number(value.toFixed(4));
function stats(values) { const sorted = [...values].sort((a, b) => a - b); const q = p => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]; return { n: sorted.length, mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length), p50: round(q(.5)), p95: round(q(.95)), p99: round(q(.99)), max: round(sorted.at(-1)) }; }
function dataset(book, epoch) {
  const games = Array.from({ length: config.mainGames }, (_, i) => ({ id: `benchmark-game-${i}`, sourceId: String(10000 + i), away: { id: `A${i}`, name: `Away ${i}` }, home: { id: `H${i}`, name: `Home ${i}` }, startsAt: new Date(epoch + 3600000 + i * 60000).toISOString(), live: i === 0 }));
  const quotes = games.flatMap(game => ['moneyline', 'spread', 'total'].flatMap(market => (market === 'total' ? ['over', 'under'] : ['away', 'home']).map(side => ({ id: `${book}:${game.id}:${market}:${side}`, gameId: game.id, book, market, side, period: 'full_game', settlement: 'including_overtime', line: market === 'moneyline' ? null : market === 'total' ? 45.5 : side === 'away' ? -3.5 : 3.5, american: -110, decimal: 1 + 100 / 110, suspended: false }))));
  return { games, quotes, warnings: [] };
}
function checkpoint(epoch) {
  return { schema: 1, savedAt: epoch, retentionMs: 48 * 3600000, series: Array.from({ length: config.historySeries }, (_, j) => ({ gameId: `historical-${j}`, book: j % 2 ? 'fanduel' : 'draftkings', period: 'full_game', settlement: 'including_overtime', market: 'moneyline', side: 'away', points: Array.from({ length: 3000 }, (_, i) => {
    const at = epoch - 48 * 3600000 + 1000 + i * ((48 * 3600000 - 2000) / 3000);
    return i > 0 && i % 750 === 0 ? { at, line: null, gap: true, missing: true, american: null, decimal: null } : { at, line: null, american: 100 + i % 11, decimal: 2 + (i % 11) / 100 };
  }) })) };
}
function extraResult(game, book, sequence) {
  const observedAt = Date.now();
  const rows = Array.from({ length: config.extraRowsPerBookPerGame }, (_, i) => {
    const subject = i % 2 ? 'over' : 'under', line = 10.5 + Math.floor(i / 2) * .5, american = 100 + sequence % 10;
    return { id: `${book}:synthetic:${i}`, key: [game.id, 'full_game', 'alt-total', subject, line, ''].join('|'), kind: 'alt-total', subject, name: subject, line, period: 'full_game', rules: 'including_overtime', american, decimal: 1 + american / 100, suspended: false, observedAt };
  });
  return { type: 'result', gameId: game.id, generation: game.generation, book, sequence,
    data: { gameId: game.id, book, region: 'Ontario', rows, observedAt, coverage: { complete: true }, warnings: [], decodedBytes: 200000 } };
}
function openSse(url, onFrame, parse = true) {
  let request, response, bytes = 0, closed = false;
  const ready = new Promise((resolve, reject) => {
    request = http.get(url, res => { response = res;
      if (res.statusCode !== 200) { res.resume(); reject(Error(`SSE ${res.statusCode}`)); return; }
      let buffer = '', first = true; res.setEncoding('utf8');
      res.on('data', chunk => { bytes += Buffer.byteLength(chunk);
        if (!parse) { if (first) { first = false; resolve(); } return; }
        buffer += chunk; let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const type = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
          if (type && data) { onFrame(type, JSON.parse(data)); if (first) { first = false; resolve(); } }
        }
      });
      res.on('error', error => { if (!closed) reject(error); });
    }); request.on('error', error => { if (!closed) reject(error); });
  });
  return { ready, bytes: () => bytes, close() { closed = true; response?.destroy(); request?.destroy(); } };
}
async function trial(enabled, index) {
  const store = new OddsStore(), epoch = Date.now(), values = { draftkings: dataset('draftkings', epoch), fanduel: dataset('fanduel', epoch) };
  for (const book of Object.keys(values)) { store.update(book, values[book], { receivedAt: epoch, kind: 'synthetic', decodedBytes: 100000 }); store.details(book, { coverage: { requested: 48, returned: 48, missingIds: [] } }); }
  const history = enabled ? new PriceHistory() : noopHistory();
  const loaded = enabled ? history.load(checkpoint(epoch)) : null;
  let worker;
  const app = createApp({ store, ingest: false, priceHistory: history, persistenceFactory: noopPersistence,
    extrasFactory: enabled ? options => new ExtrasService({ ...options, workerFactory: () => (worker = new FakeWorker()) }) : noopExtras });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, pending = new Map(), arrival = [], scheduledArrival = [], durations = [], lateness = [], digest = createHash('sha256'), streams = [];
  let extrasPolls = 0, checkpointTask = null, checkpointBytes = 0, checkpointRows = 0, historyQueries = 0, historyQueryMs = 0, checkpointMs = null;
  const main = openSse(base + '/api/events', (type, data) => {
    if (type !== 'delta') return;
    const waiting = pending.get(data.revision); if (!waiting) return;
    pending.delete(data.revision); clearTimeout(waiting.timer);
    const received = performance.now(); arrival.push(received - waiting.at); scheduledArrival.push(received - waiting.due);
    const prices = data.upsertGames.flatMap(g => g.quotes.map(q => [q.id, q.american, q.line, q.suspended]));
    digest.update(JSON.stringify(prices));
    const changed = data.upsertGames.flatMap(g => g.quotes).find(q => q.id === waiting.quote.id);
    if (!changed || changed.american !== waiting.quote.american) waiting.reject(Error('Replay changed price was lost or corrupted'));
    else waiting.resolve();
  }); streams.push(main);
  try {
    await main.ready;
    if (enabled) for (let i = 0; i < config.extraGames; i++) { const s = openSse(base + `/api/extras/events?gameId=benchmark-game-${i}`, () => {}, false); streams.push(s); await s.ready; }
    await new Promise(resolve => setImmediate(resolve));
    const beforeMemory = process.memoryUsage(); let peakHeap = beforeMemory.heapUsed, peakRss = beforeMemory.rss;
    const loop = monitorEventLoopDelay({ resolution: 1 }); loop.enable();
    const start = performance.now(), cpuStart = process.cpuUsage(), utilizationStart = performance.eventLoopUtilization(); let nextPoll = start;
    for (let i = 0; i < config.updatesPerTrial; i++) {
      const due = start + i * config.intervalMs, remaining = due - performance.now(); if (remaining > 0) await delay(remaining);
      lateness.push(Math.max(0, performance.now() - due));
      if (enabled && performance.now() >= nextPoll) {
        extrasPolls++; nextPoll += config.extraPollMs;
        for (const game of app.extras.games.values()) for (const book of ['draftkings', 'fanduel']) worker.emit('message', extraResult(game, book, extrasPolls));
      }
      if (enabled && i === Math.floor(config.updatesPerTrial / 2)) checkpointTask = (async () => {
        const began = performance.now();
        for await (const entry of history.serializeRows()) { checkpointBytes += Buffer.byteLength(JSON.stringify(entry.checkpoint)); checkpointRows++; }
        checkpointMs = performance.now() - began;
      })();
      if (enabled && i % config.historyQueryEveryUpdates === 0) {
        const began = performance.now();
        JSON.stringify(history.query({ gameId: `historical-${25 + Math.floor(i / config.historyQueryEveryUpdates) % 20}`, market: 'moneyline', side: 'away' }));
        historyQueryMs += performance.now() - began; historyQueries++;
      }
      const book = i % 2 ? 'fanduel' : 'draftkings', position = Math.floor(i / 2) % values[book].quotes.length;
      const american = 100 + i % 17 * 5, quote = { ...values[book].quotes[position], american, decimal: 1 + american / 100 };
      values[book] = { ...values[book], quotes: values[book].quotes.map((q, n) => n === position ? quote : q) };
      const at = performance.now(), expectedRevision = store.revision + 1;
      const delivered = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Main SSE replay exceeded 5 seconds')), 5000); pending.set(expectedRevision, { at, due, quote, resolve, reject, timer }); });
      store.update(book, values[book], { receivedAt: Date.now(), kind: 'synthetic', decodedBytes: 100000 });
      durations.push(performance.now() - at); await delivered;
      if (i % 25 === 0) { const memory = process.memoryUsage(); peakHeap = Math.max(peakHeap, memory.heapUsed); peakRss = Math.max(peakRss, memory.rss); }
    }
    await checkpointTask;
    const elapsedMs = performance.now() - start, cpu = process.cpuUsage(cpuStart), utilization = performance.eventLoopUtilization(utilizationStart);
    loop.disable();
    if (arrival.length !== config.updatesPerTrial) throw Error('Replay observation count mismatch');
    const report = { trial: index, optionalFeatures: enabled, measuredUpdates: arrival.length, priceDigest: digest.digest('hex'), elapsedMs: round(elapsedMs), storeCallMs: stats(durations), loopbackSseMs: stats(arrival), scheduledToSseMs: stats(scheduledArrival), scheduledUpdateLatenessMs: stats(lateness),
      eventLoopDelayMs: { mean: round(loop.mean / 1e6), p50: round(loop.percentile(50) / 1e6), p95: round(loop.percentile(95) / 1e6), p99: round(loop.percentile(99) / 1e6), max: round(loop.max / 1e6) },
      cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 }, eventLoopUtilization: round(utilization.utilization),
      memoryBytes: { beforeHeap: beforeMemory.heapUsed, peakHeap, peakRss }, mainSseBytes: main.bytes(), extrasSseBytes: streams.slice(1).reduce((total, s) => total + s.bytes(), 0),
      extras: enabled ? { ...app.extras.report(), injectedPollCycles: extrasPolls, collectorProcessSimulated: true } : null,
      history: enabled ? { initialImport: loaded, limits: history.limits(), checkpointBytes, checkpointRows, checkpointElapsedMs: round(checkpointMs), historyQueries, totalQueryMs: round(historyQueryMs) } : null };
    return { report, raw: { arrival, durations } };
  } finally { for (const s of streams) s.close(); for (const value of pending.values()) clearTimeout(value.timer); await app.shutdown(); }
}

const cwd = new URL('../', import.meta.url), sourceHash = createHash('sha256');
const sourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' }).trim().split('\n').filter(path => /^(src\/|public\/|scripts\/benchmark-optional\.js$|package(?:-lock)?\.json$)/.test(path)).sort();
for (const path of sourceFiles) { sourceHash.update(path); sourceHash.update(await readFile(new URL(path, cwd))); }
const version = { gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim()), sourceSha256: sourceHash.digest('hex'), node: process.version, platform: process.platform, arch: process.arch };
const results = [];
for (let roundIndex = 0; roundIndex < config.pairedRounds; roundIndex++) for (const enabled of roundIndex % 2 ? [true, false] : [false, true]) {
  process.stderr.write(`Replay ${results.length + 1}/${config.pairedRounds * 2}: optional features ${enabled ? 'enabled' : 'disabled'}\n`);
  results.push(await trial(enabled, results.length + 1));
}
if (new Set(results.map(x => x.report.priceDigest)).size !== 1) throw Error('Trials did not deliver identical price sequences');
const aggregate = enabled => ({ loopbackSseMs: stats(results.filter(x => x.report.optionalFeatures === enabled).flatMap(x => x.raw.arrival)), storeCallMs: stats(results.filter(x => x.report.optionalFeatures === enabled).flatMap(x => x.raw.durations)) });
const disabled = aggregate(false), enabled = aggregate(true);
const report = { generatedAt: new Date().toISOString(), version, config,
  scope: 'Synthetic current-code control vs optional features; loopback server-to-SSE-consumer latency. Identical complete price sequence verified in every trial. No upstream/WAN or browser paint comparison.',
  limitations: ['Source collection is represented by validated synthetic worker results; no bookmaker HTTP traffic is performed.', 'Main SSE JSON parsing runs in the benchmark process. Extras viewers drain bytes without rendering.', 'Synthetic extra-result processing runs immediately before a scheduled main update; scheduledToSseMs includes that competing work, while loopbackSseMs begins at store.update.', 'Database network, actual restart restore, and operating-system scheduling on production hosts are not measured.', 'Checkpoint serialization and history queries run in enabled trials; database writes are stubbed.', 'Memory uses one sequential process without forced garbage collection; peak heap is descriptive, not a controlled memory delta.'],
  trials: results.map(x => x.report), aggregate: { disabled, enabled,
    enabledMinusDisabledMs: { loopbackMean: round(enabled.loopbackSseMs.mean - disabled.loopbackSseMs.mean), loopbackP95: round(enabled.loopbackSseMs.p95 - disabled.loopbackSseMs.p95), storeMean: round(enabled.storeCallMs.mean - disabled.storeCallMs.mean), storeP95: round(enabled.storeCallMs.p95 - disabled.storeCallMs.p95) } } };
const output = JSON.stringify(report, null, 2) + '\n';
if (args.output) await writeFile(args.output, output);
process.stdout.write(output);
