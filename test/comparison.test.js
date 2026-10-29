import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardObserver, coverage, pairChanges } from '../scripts/comparison-model.js';

const q = { game: 'game', startsAt: '2026-10-30T00:15:00.000Z', book: 'draftkings', market: 'spread', side: 'home', line: -3.5, odds: -110, suspended: false };
const change = (app, atMs, batch, overrides = {}) => ({ key: 'quote', book: q.book, from: q, to: { ...q, odds: -115 }, healthy: true, app, atMs, batch, ...overrides });
const opts = { startMs: 0, endMs: 1000, maxLagMs: 200 };

test('comparison counts a matched transition once and reports the correct winner', () => {
  const r = pairChanges([change('codex', 100, 1), change('claude', 150, 2)], opts);
  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].codexMinusClaudeMs, -50);
  assert.equal(r.summary.draftkings.codexFirst, 1);
});
test('comparison rejects different starting values, not merely matching final odds', () => {
  const r = pairChanges([change('codex', 100, 1), change('claude', 150, 2, { from: { ...q, odds: -105 } })], opts);
  assert.equal(r.pairs.length, 0);
  assert.equal(r.unmatched.length, 2);
});
test('comparison rejects ambiguous repeated transitions and unhealthy sources', () => {
  const ambiguous = pairChanges([change('codex', 100, 1), change('claude', 110, 2), change('codex', 150, 3)], opts);
  assert.equal(ambiguous.pairs.length, 0);
  assert.equal(ambiguous.excluded.length, 3);
  assert.equal(pairChanges([change('codex', 100, 1, { healthy: false }), change('claude', 110, 2)], opts).pairs.length, 0);
});
test('comparison includes late counterpart during grace period, but not a new race after cutoff', () => {
  assert.equal(pairChanges([change('codex', 950, 1), change('claude', 1050, 2)], opts).pairs.length, 1);
  assert.equal(pairChanges([change('codex', 1050, 1), change('claude', 1100, 2)], opts).pairs.length, 0);
});
test('comparison does not inflate independent batch counts with correlated quotes', () => {
  const r = pairChanges([change('codex', 100, 1), change('claude', 150, 2), change('codex', 100, 1, { key: 'other' }), change('claude', 150, 2, { key: 'other' })], opts);
  assert.equal(r.summary.draftkings.pairedQuoteTransitions, 2);
  assert.equal(r.summary.draftkings.distinctBatchPairs, 1);
});
test('comparison accepts a one-minute kickoff difference but rejects larger conflicts', () => {
  const later = { ...q, odds: -115, startsAt: '2026-10-30T00:16:00.000Z' };
  assert.equal(pairChanges([change('codex', 100, 1), change('claude', 150, 2, { to: later })], opts).pairs.length, 1);
  assert.equal(pairChanges([change('codex', 100, 1), change('claude', 150, 2, { to: { ...later, startsAt: '2026-10-30T00:20:00.000Z' } })], opts).pairs.length, 0);
});
test('app adapters agree on game identity and ignore initial loads, timestamps, and heartbeats', () => {
  const codex = new BoardObserver('codex'), claude = new BoardObserver('claude');
  const teamA = { name: 'Carolina Panthers' }, teamB = { name: 'Green Bay Packers' };
  const cg = { id: 'c', away: teamA, home: teamB, startsAt: '2026-10-30T00:15:00.000Z', quotes: [{ ...q, period: 'full_game', american: -110 }] };
  const ag = { key: 'a', away: teamA, home: teamB, start: '2026-10-30T00:15:00.0000000Z' };
  assert.deepEqual(codex.apply('snapshot', { games: [cg], sources: { draftkings: { status: 'healthy' } } }), []);
  assert.deepEqual(claude.apply('snapshot', { games: [ag], quotes: [{ ...q, gameKey: 'a' }], sources: { draftkings: { stale: false } } }), []);
  assert.equal(coverage(codex, claude).draftkings.identicalActive, 1);
  assert.deepEqual(codex.apply('delta', { upsertGames: [{ ...cg, quotes: cg.quotes.map(q => ({ ...q, changedAt: 99 })) }] }), []);
  assert.deepEqual(claude.apply('batch', { quotes: [{ ...q, gameKey: 'a', updatedAt: 99 }] }), []);
  assert.deepEqual(claude.apply('batch', { quotes: [], sources: { draftkings: { stale: false } } }), []);
  const c = codex.apply('delta', { upsertGames: [{ ...cg, quotes: cg.quotes.map(q => ({ ...q, american: -115 })) }] });
  const a = claude.apply('batch', { quotes: [{ ...q, gameKey: 'a', odds: -115 }] });
  assert.equal(c.length, 1); assert.equal(a.length, 1); assert.deepEqual(c[0], a[0]);
});

test('compact freshness preserves comparison health and cannot revive failed sources', () => {
  const observer = new BoardObserver('codex');
  observer.apply('snapshot', { games: [], sources: { fanduel: { status: 'healthy', region: 'Ontario', lastConfirmedAt: 100 } } });
  assert.deepEqual(observer.apply('freshness', { sources: { fanduel: { lastConfirmedAt: 200 }, unknown: { status: 'healthy' } } }), []);
  assert.deepEqual(observer.sources.fanduel, { status: 'healthy', region: 'Ontario', lastConfirmedAt: 200 });
  assert.equal(observer.sources.unknown, undefined);
  observer.apply('status', { source: { book: 'fanduel', status: 'stale', error: 'disconnected', lastConfirmedAt: 200 } });
  observer.apply('freshness', { sources: { fanduel: { status: 'healthy', error: null, lastConfirmedAt: 300 } } });
  observer.apply('freshness', { sources: { fanduel: { lastConfirmedAt: 100 } } });
  observer.apply('heartbeat', { sources: { fanduel: { status: 'healthy', lastConfirmedAt: 999 } } });
  assert.equal(observer.sources.fanduel.status, 'stale');
  assert.equal(observer.sources.fanduel.error, 'disconnected');
  assert.equal(observer.sources.fanduel.lastConfirmedAt, 300);
});
