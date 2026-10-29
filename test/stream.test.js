import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardStream, ClockSync, mergeFreshness } from '../public/stream.js';

test('default browser APIs retain a valid receiver for timers and clock fetches', async () => {
  const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, fetch: globalThis.fetch };
  const receiver = value => assert.ok(value === undefined || value === globalThis, 'Browser API called as a method of the stream controller');
  globalThis.setTimeout = function(...args) { receiver(this); return original.setTimeout(...args); };
  globalThis.clearTimeout = function(...args) { receiver(this); return original.clearTimeout(...args); };
  globalThis.fetch = async function() { receiver(this); return { ok: true, json: async () => ({ now: Date.now() }) }; };
  const stream = new BoardStream({ createEventSource: () => ({ addEventListener() {}, close() {} }) });
  const clock = new ClockSync({ samples: 1 });
  try {
    stream.start();
    assert.ok(stream.watchTimer);
    assert.ok(await clock.sync());
    assert.ok(clock.estimate());
  } finally {
    stream.stop(); clock.stop();
    Object.assign(globalThis, original);
  }
});
import { sourceFresh, SessionHistory, historySegments } from '../public/presentation.js';

const epoch = 1700000000000;
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function timers() {
  let time = 0, id = 0;
  const jobs = new Map();
  return {
    now: () => time, jobs,
    setTimeout: (fn, delay) => { jobs.set(++id, { fn, at: time + delay }); return id; },
    clearTimeout: id => jobs.delete(id),
    jump: ms => { time += ms; },
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        await settle();
        const next = [...jobs].sort((a,b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        jobs.delete(next[0]); time = Math.max(time, next[1].at); next[1].fn();
      }
      time = end; await settle();
    },
  };
}
class FakeSource {
  constructor() { this.listeners = new Map(); this.closed = false; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  close() { this.closed = true; }
  emit(type, data) { this.listeners.get(type)?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  error() { this.onerror?.(); }
}
function fixture(options = {}) {
  const t = timers(), sockets = [], events = [], failures = [];
  const stream = new BoardStream({ now:t.now, setTimeoutFn:t.setTimeout, clearTimeoutFn:t.clearTimeout,
    createEventSource: () => { const s = new FakeSource(); sockets.push(s); return s; },
    onEvent: (type,data) => events.push({type,data}), onDisconnect: reason => failures.push(reason), ...options });
  const frame = (extra={}) => ({ sentAt:epoch+t.now(), revision:1, ...extra });
  const snapshot = (s=sockets.at(-1), extra={}) => s.emit('snapshot',frame({games:[],sources:{},...extra}));
  stream.start(); return { t,sockets,events,failures,stream,frame,snapshot };
}

test('named keepalives keep a quiet connection open without renewing bookmaker freshness', async () => {
  const f=fixture(), source={status:'healthy',lastConfirmedAt:epoch,staleAfterMs:10000};
  try {
    f.snapshot();
    for(let i=0;i<15;i++) { await f.t.advance(2000); f.sockets[0].emit('heartbeat',{sentAt:epoch+f.t.now()}); }
    assert.equal(f.stream.ready,true); assert.equal(f.sockets.length,1); assert.equal(f.events.length,1);
    assert.equal(sourceFresh(source,{connected:true,now:epoch+f.t.now()}),false);
  } finally { f.stream.stop(); }
});

test('silent-open streams are closed, late old events ignored, and recovery requires a full snapshot', async () => {
  const f=fixture();
  f.snapshot(); await f.t.advance(12000);
  assert.equal(f.failures.length,1); assert.equal(f.stream.ready,false); assert.equal(f.sockets[0].closed,true);
  f.snapshot(f.sockets[0],{revision:100}); assert.equal(f.events.length,1);
  await f.t.advance(1000); assert.equal(f.sockets.length,2);
  f.sockets[1].emit('freshness',f.frame({revision:200,sources:{}}));
  f.sockets[1].emit('delta',f.frame({revision:201,source:{book:'fanduel'},upsertGames:[],removeGameIds:[]}));
  assert.equal(f.stream.ready,false); assert.equal(f.events.length,1);
  f.snapshot(f.sockets[1],{revision:0}); assert.equal(f.stream.ready,true);
  assert.equal(f.events.length,2); assert.equal(f.stream.revision,0);
  f.stream.stop(); await f.t.advance(60000); assert.equal(f.sockets.length,2); assert.equal(f.t.jobs.size,0);
});

test('heartbeats cannot hide a missing initial snapshot, and repeated failures back off to a bound', async () => {
  const f=fixture();
  for(let i=0;i<6;i++) { await f.t.advance(1900); f.sockets[0].emit('heartbeat',{sentAt:epoch+f.t.now()}); }
  await f.t.advance(600); assert.match(f.failures[0],/snapshot/);
  await f.t.advance(1000);
  for(const delay of [2000,4000,8000,15000,15000]) {
    const before=f.sockets.length; f.sockets.at(-1).error(); f.sockets.at(-1).error();
    await f.t.advance(delay-1); assert.equal(f.sockets.length,before);
    await f.t.advance(1); assert.equal(f.sockets.length,before+1);
  }
  assert.equal(f.sockets.filter(s=>!s.closed).length,1); f.stream.stop();
});

test('tab resume detects silence immediately, even when its timers were suspended', () => {
  const f=fixture(); f.snapshot(); f.t.jump(20000); f.stream.resume();
  assert.equal(f.stream.ready,false); assert.equal(f.sockets[0].closed,true);
  assert.equal(f.failures.length,1); f.stream.resume(); assert.equal(f.failures.length,1); f.stream.stop();
});

test('calibrated backlog is rejected, while uncalibrated wall time cannot falsely reject a snapshot', async () => {
  const f=fixture({getClock:()=>({now:epoch+30000,uncertaintyMs:10})});
  f.snapshot(); assert.equal(f.events.length,0); assert.match(f.failures[0],/behind/); f.stream.stop();
  const g=fixture({getClock:()=>null}); g.snapshot(); assert.equal(g.stream.ready,true);
  for(let i=0;i<6;i++) { await g.t.advance(1900); g.snapshot(g.sockets[0]); }
  await g.t.advance(600); assert.equal(g.stream.ready,false,'duplicate revisions do not keep a stale stream alive'); g.stream.stop();
});

test('malformed messages and application errors fail closed and stop old sockets', () => {
  for(const bad of ['not JSON',{}, {sentAt:epoch,revision:2,source:null}]) {
    const f=fixture(); f.snapshot(); f.sockets[0].emit('status',bad);
    assert.equal(f.stream.ready,false); assert.equal(f.sockets[0].closed,true); f.stream.stop();
  }
  const f=fixture({onEvent:()=>{throw Error('broken shape');}}); f.snapshot();
  assert.equal(f.stream.ready,false); assert.match(f.failures[0],/apply/); f.stream.stop();
});

test('freshness patches cannot revive a failed source, regress time or overwrite critical fields', () => {
  const sources={fanduel:{status:'stale',error:'down',lastConfirmedAt:100,lastDataAt:90,lastChangeAt:80}};
  const patch={revision:3,sources:{fanduel:{status:'healthy',error:null,lastConfirmedAt:120,lastDataAt:40,lastChangeAt:110},unknown:{status:'healthy'}}};
  assert.equal(mergeFreshness(sources,patch,4),null);
  const next=mergeFreshness(sources,patch,3);
  assert.deepEqual(next.sources.fanduel,{status:'stale',error:'down',lastConfirmedAt:120,lastDataAt:90,lastChangeAt:110});
  assert.deepEqual(next.updatedBooks,['fanduel']); assert.equal(sources.fanduel.lastConfirmedAt,100);
});

test('a reconnect creates a history gap and baseline, never a made-up price move', async () => {
  const history=new SessionHistory();
  const game=odds=>({id:'g',away:{id:'CAR'},home:{id:'GB'},quotes:[{gameId:'g',book:'fanduel',period:'full_game',market:'moneyline',side:'away',line:null,american:odds}]});
  const f=fixture({onEvent:(type,data)=>history.recordGames(data.games??data.upsertGames,{baseline:type==='snapshot'}),onDisconnect:()=>history.disconnect(epoch+12000)});
  f.snapshot(f.sockets[0],{games:[game(150)]});
  f.sockets[0].emit('delta',f.frame({revision:2,upsertGames:[game(175)],removeGameIds:[],source:{book:'fanduel'}}));
  assert.equal(history.recent.length,1);
  await f.t.advance(13000); f.snapshot(f.sockets[1],{games:[game(200)]});
  assert.equal(history.recent.length,1);
  assert.equal(historySegments([...history.series.values()][0].points).length,2); f.stream.stop();
});

test('clock synchronization is single flight and times out even if a fetch ignores abort', async () => {
  const t=timers(), signals=[];
  const clock=new ClockSync({now:t.now,wallNow:()=>epoch+t.now(),setTimeoutFn:t.setTimeout,clearTimeoutFn:t.clearTimeout,
    samples:2,timeoutMs:100,fetchFn:(_url,{signal})=>{signals.push(signal);return new Promise(()=>{});}});
  const first=clock.sync(); assert.equal(clock.sync(),first);
  await t.advance(200); assert.equal(await first,null); assert.equal(signals.length,2);
  assert.ok(signals.every(s=>s.aborted)); assert.equal(clock.estimate(),null);
  const again=clock.sync(); clock.stop(); assert.equal(await again,null); assert.equal(t.jobs.size,0);
});

test('clock calibration validates responses, survives wall-clock jumps, and expires safely', async () => {
  const t=timers(); let drift=0,calls=0;
  const clock=new ClockSync({now:t.now,wallNow:()=>epoch+t.now()+drift,setTimeoutFn:t.setTimeout,clearTimeoutFn:t.clearTimeout,
    samples:3,maxAgeMs:1000,fetchFn:async()=> {
      calls++;
      if(calls===1)return {ok:false,json:async()=>({now:epoch})};
      if(calls===2)return {ok:true,json:async()=>({now:'bad'})};
      await new Promise(r=>t.setTimeout(r,20));
      return {ok:true,json:async()=>({now:epoch+t.now()+200})};
    }});
  const pending=clock.sync(); await t.advance(30); const best=await pending;
  assert.equal(calls,3); assert.equal(best.rtt,20); assert.equal(clock.estimate().uncertaintyMs,10);
  const before=clock.estimate().now; drift=3600000; await t.advance(100);
  assert.equal(clock.estimate().now,before+100,'a wall-clock adjustment cannot age incoming data by an hour');
  await t.advance(1000); assert.equal(clock.estimate(),null); clock.stop();
});
