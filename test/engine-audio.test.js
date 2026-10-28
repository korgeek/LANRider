import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VEHICLES } from '../shared/game.js';

const engine = await import('../public/engine-audio.js').catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {};});
function setup() {
  const nodes=[],sources=[],requests=[];
  const param=()=>({value:0,events:[],setTargetAtTime(value,time,tau){this.events.push({value,time,tau});}});
  const node=()=>{const n={connect(){},disconnect(){this.disconnected=true;}};nodes.push(n);return n;};
  const context={currentTime:0,state:'running',destination:{},resume:async()=>{},
    createGain(){return Object.assign(node(),{gain:param()});},
    createBiquadFilter(){return Object.assign(node(),{frequency:param(),Q:param()});},
    createBufferSource(){const n=Object.assign(node(),{playbackRate:param(),start(...args){this.started=args;},stop(time){this.stopped=time;}});sources.push(n);return n;},
    async decodeAudioData(){return {duration:.35};},
  };
  let rolls=0;
  const controller=engine.createEngineAudio({createContext:()=>context,random:()=>{rolls++;return .5;},
    fetch:async url=>{requests.push(url);return {ok:true,arrayBuffer:async()=>new ArrayBuffer(4)};},
  });
  return {controller,context,nodes,sources,requests,rolls:()=>rolls};
}
const latest=param=>param.events.at(-1)?.value ?? param.value;
const own={id:'me',vehicle:'PULSE',x:0,z:0,speed:30};

test('engine voices retain their source and variation while speed controls pitch and throttle controls power',async()=>{
  assert.equal(typeof engine.createEngineAudio,'function');
  assert.deepEqual(Object.keys(engine.ENGINE_VEHICLES).sort(),Object.keys(VEHICLES).sort());
  const s=setup();await s.controller.unlock();
  s.controller.update(own,[],1,true);
  assert.equal(s.sources.length,1);const source=s.sources[0],filter=s.nodes.find(n=>n.frequency),voiceGain=s.nodes.filter(n=>n.gain)[1];
  assert(source.loop);assert(source.started[1]>=0&&source.started[1]<.35);
  const pitch=latest(source.playbackRate),loud=latest(voiceGain.gain),bright=latest(filter.frequency);
  assert(pitch>.85&&pitch<1.45);
  s.context.currentTime=1;s.controller.update(own,[],0,true);
  assert.equal(latest(source.playbackRate),pitch,'lifting throttle at constant speed does not drop to idle pitch');
  assert(latest(voiceGain.gain)<loud);assert(latest(filter.frequency)<bright);
  assert.equal(voiceGain.gain.events.at(-1).tau,.5,'power falls smoothly');
  s.context.currentTime=2;s.controller.update({...own,speed:40},[],1,true);
  assert(latest(source.playbackRate)>pitch);assert.equal(source.playbackRate.events.at(-1).tau,.2);
  for(let i=0;i<500;i++){s.context.currentTime+=1/60;s.controller.update(own,[],1,true);}
  assert.equal(s.sources.length,1,'frame updates do not restart a loop');assert.equal(s.rolls(),3,'variation is chosen only when a voice is created');
  s.controller.setVolume(.25,true);assert.equal(latest(s.nodes[0].gain),0);
  s.controller.setVolume(.25,false);assert.equal(latest(s.nodes[0].gain),.25);
  s.controller.setAudible(false);assert.equal(latest(s.nodes[0].gain),0);assert.equal(s.sources.length,1);
  s.controller.setAudible(true);assert.equal(latest(s.nodes[0].gain),.25);
  s.controller.clear();assert(s.sources[0].stopped>s.context.currentTime,'stop follows a short gain fade');
});

test('opponents keep their vehicle timbre and fall below the local engine as distance grows',async()=>{
  assert.equal(typeof engine.createEngineAudio,'function');
  const s=setup();await s.controller.unlock();
  const peer={id:'other',vehicle:'BULWARK',x:4,z:0,speed:30};
  s.controller.update(own,[peer],1,true);
  assert.equal(s.sources.length,2);assert.notEqual(s.sources[0].buffer,s.sources[1].buffer);
  const gains=s.nodes.filter(n=>n.gain),near=latest(gains[2].gain);
  assert(near<latest(gains[1].gain)*.3,'remote engines cannot bury the local engine');
  s.context.currentTime=1;s.controller.update(own,[{...peer,x:60}],1,true);
  assert(latest(gains[2].gain)<near/5);
  s.context.currentTime=2;s.controller.update({...own,speed:0},[{...peer,x:3,speed:49}],0,true);
  assert(latest(gains[2].gain)<=latest(gains[1].gain)*.3,'a nearby fast opponent cannot drown out local idle');
  s.controller.update(own,[],1,true);assert(s.sources[1].stopped>s.context.currentTime);
  s.controller.update({...own,vehicle:'RALLY'},[],1,true);assert.equal(s.sources.length,3);
  assert.equal(s.requests.length,2,'buffers are shared across all cars');
});

test('engine loading is lazy, retryable, and muted before its first source starts',async()=>{
  assert.equal(typeof engine.createEngineAudio,'function');
  const s=setup();s.controller.setVolume(.7,true);s.controller.update(own,[],1,true);
  assert.equal(s.requests.length,0);assert.equal(s.sources.length,0);
  await Promise.all([s.controller.unlock(),s.controller.unlock()]);s.controller.update(own,[],1,true);
  assert.equal(s.requests.length,2);assert.equal(latest(s.nodes[0].gain),0);
  let tries=0;const retry=engine.createEngineAudio({createContext:()=>s.context,fetch:async()=>{if(tries++<2)throw Error('offline');return {ok:true,arrayBuffer:async()=>new ArrayBuffer(4)};}});
  await assert.rejects(retry.unlock(),/offline/);await retry.unlock();
});

test('short PCM loops have no silence, level collapse, or exceptional sample jump at the seam',async()=>{
  for(const name of ['sport','rough']) {
    const wav=await readFile(new URL(`../public/assets/audio/engines/engine-${name}-loop.wav`,import.meta.url));
    assert(wav.length<20000);assert.equal(wav.toString('ascii',0,4),'RIFF');
    assert.equal(wav.readUInt32LE(24),22050);assert.equal(wav.readUInt16LE(22),1);
    const samples=Array.from({length:(wav.length-44)/2},(_,i)=>wav.readInt16LE(44+i*2)/32768);
    assert(samples.length/22050>=.3 && samples.length/22050<=.8);
    const steps=samples.slice(1).map((v,i)=>Math.abs(v-samples[i])).sort((a,b)=>a-b);
    assert(Math.abs(samples[0]-samples.at(-1))<steps[Math.floor(steps.length*.99)]);
    const levels=[];for(let start=0;start<samples.length;start+=441) {
      const chunk=Array.from({length:1323},(_,i)=>samples[(start+i)%samples.length]);
      levels.push(20*Math.log10(Math.sqrt(chunk.reduce((sum,v)=>sum+v*v,0)/chunk.length)));
    }
    assert(Math.max(...levels)-Math.min(...levels)<1,'steady speed cannot periodically fade away');
  }
});
