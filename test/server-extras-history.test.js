import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/server.js';
import { ExtrasService } from '../src/extras-service.js';
import { DraftKingsState } from '../src/adapters/draftkings.js';
import { normalizeFanDuel, selectFanDuelMarkets } from '../src/adapters/fanduel.js';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
async function setup() {
  let workers = 0, savesClosed = 0;
  const app = createApp({ ingest: false,
    persistenceFactory: () => ({ start() {}, status: () => ({ configured:false, status:'memory' }), async close() { savesClosed++; } }),
    extrasFactory: ({store}) => new ExtrasService({ store, workerFactory: () => {
      workers++; const worker = new EventEmitter(); worker.send = () => {}; worker.kill = () => {}; return worker;
    }}),
  });
  const timing = { receivedAt:Date.now(), kind:'fixture', durationMs:1, decodedBytes:100 };
  const dk = new DraftKingsState(); dk.replace(fixture('draftkings-snapshot'));
  app.store.update('draftkings', dk.normalize(), timing);
  app.store.update('fanduel', normalizeFanDuel(selectFanDuelMarkets(fixture('fanduel-ontario-discovery')), fixture('fanduel-ontario-prices')), timing);
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async path => { const response=await fetch(base+path);return {status:response.status,body:await response.json()}; };
  return {app,base,get,workers:()=>workers,async close(){await app.shutdown();assert.equal(savesClosed,1);}};
}

test('history is shared across requests, bounded to a valid selection, and never starts optional collectors', async () => {
  const f = await setup();
  try {
    const board = await f.get('/api/board'), game = board.body.games.find(g => g.quotes.some(q => q.market === 'moneyline'));
    const query = new URLSearchParams({gameId:game.id,market:'moneyline',side:'away',hours:'48'});
    const first = await f.get('/api/history?'+query), second = await f.get('/api/history?'+query);
    assert.equal(first.status,200); assert.ok(first.body.series.length>0);
    assert.equal(first.body.retentionHours,48);assert.equal(first.body.storage.status,'memory');
    assert.deepEqual(first.body.series,second.body.series);
    assert.ok(first.body.series.every(series=>series.gameId===game.id&&series.market==='moneyline'&&series.side==='away'));
    const invalidHours = new URLSearchParams(query); invalidHours.set('hours','NaN');
    for(const suffix of ['', '?gameId=x', '?gameId=x&market=total&side=home', '?'+query+'&maxPoints=100000', '?'+invalidHours])
      assert.equal((await f.get('/api/history'+suffix)).status,400);
    assert.equal(f.workers(),0);
    assert.equal((await f.get('/api/board')).body.games.length,board.body.games.length);
  } finally { await f.close(); }
});

test('optional stream rejects unknown games without starting workers and serves browser modules', async () => {
  const f=await setup();
  try {
    assert.equal((await f.get('/api/extras/events')).status,400);
    assert.equal((await f.get('/api/extras/events?gameId=not-a-game')).status,404);
    assert.equal(f.workers(),0);
    for(const path of ['/analytics.js','/ui-controls.js','/extras-panel.js']) {
      const response=await fetch(f.base+path); assert.equal(response.status,200);
      assert.match(response.headers.get('content-type'),/javascript/); assert.ok((await response.text()).length>100);
    }
    const metrics=await f.get('/api/metrics');assert.equal(metrics.body.extras.region,'Ontario');
    assert.equal(metrics.body.extras.activeGames,0);assert.equal(metrics.body.history.retentionHours,48);
  } finally { await f.close(); }
});
