import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioMix } from '../public/audio-mix.js';

test('all media and engine output share headroom, compression and a bounded final output; fades do not change saved volume', async () => {
  const nodes = [], media = [{ volume: .45 }, { volume: .7 }];
  const param = () => ({ value: 1, cancelAndHoldAtTime() {}, setValueAtTime(value) { this.value = value; },
    linearRampToValueAtTime(value) { this.value = value; } });
  const node = extras => { const n = { connect(destination) { this.destination = destination; }, ...extras }; nodes.push(n); return n; };
  let creations = 0;
  const context = { currentTime: 1, destination: {}, resume: async () => {},
    createGain: () => node({ gain: param() }),
    createDynamicsCompressor: () => node(Object.fromEntries(['threshold','knee','ratio','attack','release'].map(key => [key,param()]))),
    createWaveShaper: () => node({}), createMediaElementSource: element => node({ element }) };
  const mix = createAudioMix({ createContext: () => { creations++; return context; } });
  mix.attach(media, media[0]); assert.equal(creations, 0, 'no audio device before a gesture');
  await mix.unlock(); await mix.unlock(); assert.equal(creations, 1);
  const inputs = nodes.filter(n => n.element), ceiling = nodes.find(n => n.curve);
  assert.equal(inputs.length, media.length);
  assert(inputs.every(source => { let n=source; for(let i=0;i<6&&n;i++,n=n.destination)if(n===mix.input)return true; return false; }));
  assert.equal(ceiling.destination, context.destination); assert(Math.max(...ceiling.curve) <= .9);
  mix.fadeMusic(0,.25); mix.fadeMusic(1,.4); assert.equal(media[0].volume,.45);
  assert.equal(mix.context, context); assert(mix.input.gain.value < 1);
  mix.setMuted(true); assert.equal(mix.input.gain.value, 0);
  mix.setMuted(false); assert.equal(mix.input.gain.value, .65);
});
