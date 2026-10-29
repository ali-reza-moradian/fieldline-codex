import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.js';
import { selectFanDuelMarkets, normalizeFanDuel } from '../src/adapters/fanduel.js';

const json=name=>JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`,import.meta.url)));
const dataset=()=>normalizeFanDuel(selectFanDuelMarkets(json('fanduel-ontario-discovery')),json('fanduel-ontario-prices'));
async function until(fn) { const end=Date.now()+2000; for(;;) { const result=fn();if(result)return result;if(Date.now()>end)throw Error('Timed out waiting for local stream');await delay(2); } }
function scheduler() {
  const jobs=new Map();let id=0;
  return {jobs,setInterval:(fn,ms)=>{jobs.set(++id,{fn,ms});return id;},clearInterval:id=>jobs.delete(id),
    fire(ms){for(const job of jobs.values())if(job.ms===ms)job.fn();}};
}
async function fixture(options={}) {
  const schedule=scheduler(), app=createApp({ingest:false,streamScheduler:schedule,...options});
  const responses=[];app.server.on('request',(req,res)=>{if(req.url==='/api/events')responses.push(res);});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`, streams=[];
  async function open() {
    const controller=new AbortController(), response=await fetch(base+'/api/events',{signal:controller.signal});
    assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-transform/);
    const frames=[], decoder=new TextDecoder();let buffer='';
    const done=(async()=>{try {for await(const chunk of response.body){buffer+=decoder.decode(chunk,{stream:true});let end;
      while((end=buffer.indexOf('\n\n'))>=0){const raw=buffer.slice(0,end+2);buffer=buffer.slice(end+2);
        const type=/^event: (.+)$/m.exec(raw)?.[1], data=/^data: (.+)$/m.exec(raw)?.[1];
        if(type&&data)frames.push({type,data:JSON.parse(data),bytes:Buffer.byteLength(raw)});
      }} } catch(error) {if(!controller.signal.aborted)frames.ended=error.message;} })();
    const stream={frames,close:()=>controller.abort(),done};streams.push(stream);
    await until(()=>frames.some(f=>f.type==='snapshot'));return stream;
  }
  const publish=(value=dataset())=>app.store.update('fanduel',value,{receivedAt:Date.now(),kind:'poll',pollMs:250,decodedBytes:100000});
  function seed(){publish();app.store.details('fanduel',{coverage:{requested:87,returned:87,batches:2,missingIds:[]},
    transport:'Live push · polling backup', channels:{push:{status:'subscribed',verified:true,generation:1,subscribedMarkets:87,region:'on',counters:{messages:0}},polling:{intervalMs:250,error:null,successfulCycles:1},discovery:{error:null}}});}
  return {app,schedule,base,responses,open,publish,seed,async close(){for(const s of streams)s.close();await Promise.all(streams.map(s=>s.done));await app.shutdown();assert.equal(schedule.jobs.size,0);}};
}

test('routine status traffic is compact, ordered after the latest delta, and preserves full API diagnostics',async()=>{
  const f=await fixture();try{
    f.seed();const client=await f.open();
    f.app.store.confirm('fanduel');
    f.app.store.details('fanduel',{updates:999,requestMs:12,channels:{...f.app.store.sources.fanduel.channels,
      polling:{...f.app.store.sources.fanduel.channels.polling,successfulCycles:999}}});
    await delay(10);assert.equal(client.frames.length,1,'routine metadata is not sent as a full source frame');
    const next=dataset();next.quotes[0].american=175;next.quotes[0].decimal=2.75;f.publish(next);
    const delta=await until(()=>client.frames.find(x=>x.type==='delta'));assert.equal(delta.data.upsertGames.flatMap(g=>g.quotes).find(q=>q.id===next.quotes[0].id).american,175);
    f.schedule.fire(250);const beat=await until(()=>client.frames.find(x=>x.type==='freshness'));
    assert.equal(beat.data.revision,f.app.store.revision);assert.ok(beat.data.revision>=delta.data.revision);
    assert.equal(beat.data.sources.fanduel.lastConfirmedAt,f.app.store.sources.fanduel.lastConfirmedAt);
    assert.deepEqual(Object.keys(beat.data.sources.fanduel).sort(),['lastChangeAt','lastConfirmedAt','lastDataAt']);
    const api=await(await fetch(f.base+'/api/metrics')).json();assert.equal(api.sources.fanduel.channels.polling.successfulCycles,999);
  }finally{await f.close();}
});

test('failure, recovery and incomplete coverage bypass routine coalescing immediately',async()=>{
  const f=await fixture();try{
    f.seed();const client=await f.open();f.app.store.failure('fanduel',Error('local failure'));
    const failed=await until(()=>client.frames.find(x=>x.type==='status'&&x.data.source.status==='stale'));
    assert.equal(failed.data.source.error,'local failure');
    f.publish();await until(()=>client.frames.find(x=>x.type==='status'&&x.data.source.status==='healthy'));
    f.app.store.details('fanduel',{coverage:{requested:87,returned:80,batches:2,missingIds:['missing']}});
    await until(()=>client.frames.find(x=>x.type==='status'&&x.data.source.coverage?.returned===80));
    assert.equal((await fetch(f.base+'/api/health')).status,503);
  }finally{await f.close();}
});

test('transport heartbeats are observable without changing revision or renewing either book',async()=>{
  const f=await fixture();try{
    f.seed();const client=await f.open(), before=structuredClone(f.app.store.sources),revision=f.app.store.revision;
    f.schedule.fire(2000);const heartbeat=await until(()=>client.frames.find(x=>x.type==='heartbeat'));
    assert.ok(Number.isFinite(heartbeat.data.sentAt));assert.equal(heartbeat.data.revision,undefined);
    assert.equal(f.app.store.revision,revision);assert.deepEqual(f.app.store.sources,before);
    const module=await fetch(f.base+'/stream.js');assert.equal(module.status,200);assert.match(await module.text(),/export class BoardStream/);
  }finally{await f.close();}
});

for(const kind of ['heartbeat','freshness','delta'])test(`slow viewers are removed on ${kind} writes`,async()=>{
  const f=await fixture();try{
    f.seed();await f.open();await until(()=>f.responses.length===1);
    Object.defineProperty(f.responses[0],'writableLength',{configurable:true,get:()=>256*1024});
    if(kind==='heartbeat')f.schedule.fire(2000);
    else if(kind==='freshness'){f.app.store.confirm('fanduel');f.schedule.fire(250);}
    else{const next=dataset();next.quotes[0].american=175;f.publish(next);}
    await until(()=>f.responses[0].destroyed);
    const metrics=await(await fetch(f.base+'/api/metrics')).json();assert.equal(metrics.viewers,0);
  }finally{await f.close();}
});

test('multiple viewers share the same collector pair and immediately receive the same changed game',async()=>{
  let factories=0,started=0,stopped=0;
  const f=await fixture({ingest:true,collectorFactory:()=>{factories++;return [1,2].map(()=>({start(){started++;},stop(){stopped++;}}));}});
  try{
    f.seed();const clients=await Promise.all([f.open(),f.open(),f.open()]);
    assert.equal(factories,1);assert.equal(started,2);
    const next=dataset();next.quotes[0].american=175;f.publish(next);
    const deltas=await Promise.all(clients.map(c=>until(()=>c.frames.find(x=>x.type==='delta'))));
    assert.deepEqual(deltas[0].data,deltas[1].data);assert.deepEqual(deltas[1].data,deltas[2].data);
  }finally{await f.close();}assert.equal(stopped,2);
});

test('compact status frames reduce bytes for an identical 50-cycle quiet replay',async t=>{
  const f=await fixture();try{
    f.seed();const client=await f.open();let baselineBytes=0;
    const baseline=({type,data})=>{baselineBytes+=Buffer.byteLength(`id: ${data.revision}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);};
    f.app.store.on('message',baseline);
    for(let i=1;i<=50;i++){
      f.publish();const source=f.app.store.sources.fanduel;
      f.app.store.details('fanduel',{channels:{...source.channels,polling:{...source.channels.polling,successfulCycles:i+1}}});
      f.schedule.fire(250);
    }
    await until(()=>client.frames.filter(x=>x.type==='freshness').length===50);
    const current=client.frames.filter(x=>x.type!=='snapshot'), currentBytes=current.reduce((n,x)=>n+x.bytes,0);
    assert.ok(current.every(x=>x.type==='freshness'));assert.ok(currentBytes<baselineBytes*.4);
    assert.equal(f.app.store.datasets.fanduel.quotes.length,174);
    t.diagnostic(JSON.stringify({cycles:50,baselineBytes,currentBytes,reductionPercent:100*(1-currentBytes/baselineBytes),scope:'SSE application bytes excluding identical initial snapshots; no price changes or WAN latency measured'}));
    f.app.store.off('message',baseline);
  }finally{await f.close();}
});
