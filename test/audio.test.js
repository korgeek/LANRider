import test from 'node:test';
import assert from 'node:assert/strict';
import { MUSIC_TRACKS } from '../shared/music.js';

const originalSound = await import('../public/audio.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const testTracks = MUSIC_TRACKS.length > 1 ? MUSIC_TRACKS.slice(0, 2) : [MUSIC_TRACKS[0], { id: 'test-other', title: 'Test other', artist: 'Test', src: '/test-other.mp3' }];
const sound = { ...originalSound, initAudio: (document, engines) => originalSound.initAudio(document, engines,
  { tracks: testTracks, cache: { remember: async () => {}, match: async () => null } }) };
const choose = (controller, index = 0) => controller.setMusic({ mode: 'sequence', track: testTracks[index].id }, 'room');
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup(header = '') {
  const document = new EventTarget(), elements = {};
  const cookies = new Map(header.split(';').filter(part=>part.trim()).map(part=>{
    const i=part.indexOf('=');return [part.slice(0,i).trim(),part.slice(i+1)];
  })), writes=[];
  Object.defineProperty(document,'cookie',{configurable:true,
    get:()=>[...cookies].map(([key,value])=>`${key}=${value}`).join('; '),
    set:value=>{writes.push(value);const pair=value.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));},
  });
  for (const id of ['ambient-audio','music-audio','ambient-volume','music-volume','ambient-mute','music-mute',
    'ambient-level','music-level','music-status','sound-status','sound-settings','sound-toggle','master-mute',
    'collision-audio','boost-audio','drift-d02-audio','drift-d03-audio','countdown-tick-audio','countdown-go-audio','finish-audio','sfx-volume','sfx-mute','sfx-level']) {
    const element = new EventTarget(); element.attributes = {};
    element.setAttribute = (key,value) => { element.attributes[key] = value; };
    element.contains = target => target === element;
    elements[id] = element;
  }
  elements['ambient-volume'].value = '30'; elements['music-volume'].value = '45';
  elements['sfx-volume'].value = '70';
  for (const id of ['ambient-audio','music-audio','collision-audio','boost-audio','drift-d02-audio','drift-d03-audio','countdown-tick-audio','countdown-go-audio','finish-audio']) {
    const audio = elements[id];
    Object.assign(audio, { paused: true, muted: false, volume: 1, plays: 0, failure: null, src: '' });
    audio.play = async () => {
      audio.plays++;
      if (audio.failure) throw new DOMException('Media unavailable', audio.failure);
      audio.paused = false; audio.dispatchEvent(new Event('playing'));
    };
    audio.pause = () => { audio.paused = true; audio.dispatchEvent(new Event('pause')); };
    audio.load = () => { audio.paused = true; };
    audio.removeAttribute = () => { audio.src = ''; };
  }
  document.getElementById = id => elements[id];
  elements['ambient-audio'].src = '/assets/audio/ambient-waves.mp3';
  return { document, elements, writes, ambient: elements['ambient-audio'], music: elements['music-audio'],
    click: id => elements[id].dispatchEvent(new Event('click')),
    volume(id,value) { elements[`${id}-volume`].value = String(value); elements[`${id}-volume`].dispatchEvent(new Event('input')); } };
}

test('public builds without optional music or ambient still play race and driving effects', () => {
  const ui = setup(); ui.ambient.src = '';
  const audio = originalSound.initAudio(ui.document, undefined, { tracks: [] });
  audio.setRace('beginner', 1);
  assert.equal(ui.music.plays, 0); assert.equal(ui.ambient.plays, 0);
  assert.equal(ui.elements['music-status'].hidden, true);
  audio.updateRace({ raceId: 1, phase: 'countdown', countdown: 3, raceTime: 0, serverNow: 0, stateTime: 0 });
  assert.equal(ui.elements['countdown-tick-audio'].plays, 1);
  audio.updateCar({ id: 'car', collisionTime: .2, boostTime: 1, drifting: false }, 1);
  assert.equal(ui.elements['collision-audio'].plays, 1);
  assert.equal(ui.elements['boost-audio'].plays, 1);
});

test('ambient remains independent; selected music persists across race transitions and shows supplied credits', async () => {
  assert.equal(typeof sound.initAudio, 'function');
  const ui = setup(), controller = sound.initAudio(ui.document);
  assert.equal(ui.ambient.plays, 1); assert.equal(ui.music.plays, 0);
  assert.equal(ui.ambient.volume, .3); assert(ui.ambient.loop && !ui.music.loop);
  choose(controller); controller.setRace('beginner'); await settle();
  assert.equal(ui.music.src, testTracks[0].src); assert(!ui.music.paused);
  assert.equal(ui.elements['music-status'].textContent, `♪ ${testTracks[0].artist} · ${testTracks[0].title}`);
  assert.equal(ui.elements['music-status'].hidden, false);
  const plays = ui.music.plays;
  controller.setRace('beginner'); assert.equal(ui.music.plays, plays, 'room refresh must not restart music');
  controller.setRace('technical'); await settle();
  assert.equal(ui.music.src, testTracks[0].src, 'circuit changes do not choose or restart music');
  controller.setRace(null); assert(!ui.music.paused); assert(!ui.ambient.paused);
  controller.setMusic(null); await new Promise(resolve => setTimeout(resolve, 270)); assert(ui.music.paused);
  assert.equal(ui.elements['music-status'].hidden, true);
});

test('preview fades out in the lobby, countdown stays silent and race music starts after GO ends', async () => {
  const ui = setup(), controller = sound.initAudio(ui.document), choice = { mode: 'sequence', track: testTracks[0].id };
  controller.setMusic(choice, 'preview'); await settle(); assert.equal(ui.music.plays, 1);
  controller.setMusic(choice, 'room', 'lobby'); await new Promise(resolve => setTimeout(resolve, 270));
  assert(ui.music.paused);
  controller.setRace('beginner', 1); controller.setMusic(choice, 'room', 'countdown');
  const state = { raceId: 1, phase: 'countdown', countdown: 3, raceTime: 0, serverNow: 100, stateTime: 100 };
  controller.updateRace(state); assert.equal(ui.music.plays, 1);
  controller.setMusic(choice, 'room', 'racing'); controller.updateRace({ ...state, phase: 'racing' });
  const go = ui.elements['countdown-go-audio']; assert.equal(go.plays, 1); assert.equal(ui.music.plays, 1);
  go.paused = true; go.dispatchEvent(new Event('ended')); await settle();
  assert.equal(ui.music.plays, 2); assert(!ui.music.paused);
  for (let i = 0; i < 20; i++) controller.updateRace({ ...state, phase: 'racing', raceTime: 1 });
  assert.equal(ui.music.plays, 2, 'snapshots must not restart BGM');
  controller.setMusic(choice, 'room', 'finished'); await new Promise(resolve => setTimeout(resolve, 270)); assert(ui.music.paused);
  controller.setRace('beginner', 2); controller.setMusic(choice, 'room', 'racing');
  controller.updateRace({ ...state, raceId: 2, phase: 'racing', raceTime: 5 }); await settle();
  assert(!ui.music.paused, 'joining an ongoing race skips the already completed start signal');
});

test('the header master mute silences every channel, keeps individual levels and survives reload', async () => {
  const ui = setup(), controller = sound.initAudio(ui.document); choose(controller); await settle();
  const levels = [ui.ambient.volume, ui.music.volume, ui.elements['collision-audio'].volume];
  assert.deepEqual(levels, [.3, .5, .2]);
  ui.click('master-mute'); await settle();
  assert(ui.music.paused && ui.ambient.paused);
  assert.equal(ui.elements['master-mute'].attributes['aria-pressed'], 'true');
  assert.deepEqual([ui.ambient.volume, ui.music.volume, ui.elements['collision-audio'].volume], levels);
  ui.document.dispatchEvent(new Event('pointerdown')); await settle(); assert(ui.music.paused && ui.ambient.paused);
  const restored = setup(ui.document.cookie), next = sound.initAudio(restored.document); choose(next); await settle();
  assert(restored.music.paused && restored.ambient.paused);
  ui.click('master-mute'); await settle(); assert(!ui.music.paused && !ui.ambient.paused);
});

test('hidden tabs suspend music and waves, preserve position, and diagnostics detect extra music elements', async () => {
  const ui = setup(), controller = sound.initAudio(ui.document);
  choose(controller); await settle(); ui.music.currentTime = 42;
  ui.document.hidden = true; ui.document.dispatchEvent(new Event('visibilitychange'));
  assert(ui.music.paused, 'a hidden game tab must not add another BGM over the visible game');
  assert(ui.ambient.paused);
  ui.document.dispatchEvent(new Event('pointerdown')); await settle();
  assert(ui.music.paused && ui.ambient.paused, 'a hidden tab cannot resume from stray input');
  ui.document.hidden = false; ui.document.dispatchEvent(new Event('visibilitychange')); await settle();
  assert(!ui.music.paused && !ui.ambient.paused); assert.equal(ui.music.currentTime, 42);
  const extra = { id: 'extra-music', src: testTracks[1].src, paused: false, muted: false, volume: .4 };
  ui.music.id = 'music-audio'; ui.ambient.id = 'ambient-audio';
  ui.document.querySelectorAll = () => [ui.music, ui.ambient, extra];
  const info = controller.diagnostics();
  assert.equal(info.bgmElements, 2); assert.equal(info.activeBgm, 2);
  assert.deepEqual(info.activeMedia, ['music-audio', 'ambient-audio', 'extra-music']);
  assert.equal(info.music.file, `${testTracks[0].id}.mp3`);
});

test('two visible game windows only play music in the focused window and keep their positions', async () => {
  const first = setup(), second = setup();
  for (const [ui, focused] of [[first, true], [second, false]]) {
    ui.document.defaultView = new EventTarget();
    ui.document.hasFocus = () => focused;
  }
  const a = sound.initAudio(first.document), b = sound.initAudio(second.document);
  choose(a); choose(b, 1); await settle();
  first.music.currentTime = 42;
  assert(!first.music.paused); assert(second.music.paused, 'a visible but unfocused game cannot add a second BGM');
  first.document.defaultView.dispatchEvent(new Event('blur'));
  second.document.defaultView.dispatchEvent(new Event('focus')); await settle();
  assert(first.music.paused && first.ambient.paused); assert(!second.music.paused);
  first.document.dispatchEvent(new Event('keydown')); await settle();
  assert(first.music.paused, 'driving input cannot resume a window which lost focus');
  second.document.defaultView.dispatchEvent(new Event('blur'));
  first.document.defaultView.dispatchEvent(new Event('focus')); await settle();
  assert(!first.music.paused && second.music.paused); assert.equal(first.music.currentTime, 42);
});

test('B countdown follows snapshot time once per step; C cheers once at results, respecting mute and late entry', () => {
  const ui=setup(),audio=sound.initAudio(ui.document);
  const tick=ui.elements['countdown-tick-audio'],go=ui.elements['countdown-go-audio'],cheer=ui.elements['finish-audio'];
  assert.equal(typeof audio.updateRace,'function');
  audio.setRace('beginner',1);
  const state={raceId:1,phase:'countdown',countdown:2.98,raceTime:0,serverNow:1000,stateTime:980};
  audio.updateRace(state,0);audio.updateRace(state,.1);assert.equal(tick.plays,1);
  audio.updateRace({...state,countdown:2.6},.7);assert.equal(tick.plays,2,'receipt age advances the same countdown as the HUD');
  audio.updateRace({...state,countdown:1.99},0);assert.equal(tick.plays,2,'clock jitter cannot replay a tick');
  audio.updateRace({...state,countdown:1.2},.3);assert.equal(tick.plays,3);
  const racing={...state,phase:'racing',raceTime:0};
  audio.updateRace(racing,0);audio.updateRace(racing,.05);assert.equal(go.plays,1);
  audio.updateRace({...racing,phase:'finished',raceTime:50});
  audio.updateCar(null,50);audio.updateRace({...racing,phase:'finished',raceTime:50});
  assert.equal(cheer.plays,1);assert(!cheer.paused,'car cleanup must not cut off the results cheer');
  audio.setRace('beginner',2);assert(cheer.paused,'same-circuit rematch stops the previous cheer');
  audio.updateRace({...state,raceId:2},0,false);
  audio.updateRace({...state,raceId:2},0,true);assert.equal(tick.plays,3,'tab return does not replay a hidden tick');
  audio.updateRace({...state,raceId:2,countdown:1.9},0);assert.equal(tick.plays,4);
  ui.volume('sfx',23);ui.click('sfx-mute');
  for(const item of [tick,go,cheer]) {assert.equal(item.volume,.23);assert(item.muted);assert(!item.loop);}
  audio.updateRace({...racing,raceId:2},0);assert.equal(go.plays,1);
  ui.click('sfx-mute');audio.updateRace({...racing,raceId:2},.1);assert.equal(go.plays,1,'unmute does not replay a consumed cue');
  audio.setRace(null);assert(tick.paused && go.paused && cheer.paused);
  audio.setRace('technical',3);audio.updateRace({...racing,raceId:3,raceTime:5});assert.equal(go.plays,1,'late join skips GO');
  audio.setRace(null);audio.setRace('technical',4);
  audio.updateRace({...racing,raceId:4,phase:'finished'});assert.equal(cheer.plays,1,'joining results does not replay a past celebration');
  audio.setRace('technical',5);audio.updateRace({...racing,raceId:5,raceTime:5});
  ui.document.hidden=true;ui.document.dispatchEvent(new Event('visibilitychange'));
  audio.updateRace({...racing,raceId:5,phase:'finished'},0,false);
  ui.document.hidden=false;audio.updateRace({...racing,raceId:5,phase:'finished'},0,true);
  assert.equal(cheer.plays,1,'finish received while hidden is consumed before visible frames resume');
});

test('sound cookies restore each channel volume and mute before playback without replacing driver cookies', async () => {
  const ui=setup('nextrider_name=NIK; other=1');sound.initAudio(ui.document);
  ui.volume('ambient',0);ui.volume('music',18);ui.click('music-mute');ui.volume('sfx',92);ui.click('sfx-mute');
  assert(ui.writes.length>0,'user changes must write a persistent cookie');
  for(const cookie of ui.writes)assert.match(cookie,/; Path=\/; Max-Age=31536000; SameSite=Lax$/);
  assert.match(ui.document.cookie,/nextrider_name=NIK/);
  const restored=setup(ui.document.cookie),controller=sound.initAudio(restored.document);
  assert.equal(restored.elements['ambient-volume'].value,'0');
  assert.equal(restored.ambient.volume,0);assert.equal(restored.ambient.plays,0);
  assert.equal(restored.elements['music-volume'].value,'18');
  assert.equal(restored.music.volume,.18);assert(restored.music.muted);
  choose(controller);controller.setRace('beginner');await settle();assert.equal(restored.music.plays,0,'restored mute prevents playback');
  for(const id of ['collision-audio','boost-audio','drift-d02-audio','drift-d03-audio']){
    assert.equal(restored.elements[id].volume,.92);assert(restored.elements[id].muted);
  }
  assert.equal(restored.elements['sfx-level'].textContent,'92%');
  assert.equal(restored.elements['sfx-mute'].attributes['aria-pressed'],'true');
  restored.click('music-mute');await settle();assert(!restored.music.muted && !restored.music.paused);
  const again=setup(restored.document.cookie);sound.initAudio(again.document);
  assert.equal(again.music.volume,.18);assert(!again.music.muted,'unmute also persists');
});

test('malformed, out-of-range or blocked sound cookies leave usable defaults', () => {
  for(const value of ['%ZZ',encodeURIComponent('null'),encodeURIComponent('[]'),encodeURIComponent('{broken'),
    encodeURIComponent(JSON.stringify({ambient:{volume:101,muted:'true'},music:{volume:-5},sfx:{volume:'25'}}))]) {
    const ui=setup(`nextrider_audio=${value}`);sound.initAudio(ui.document);
    assert.equal(ui.ambient.volume,.3);assert.equal(ui.music.volume,.5);assert.equal(ui.elements['boost-audio'].volume,.2);
    assert(!ui.ambient.muted && !ui.music.muted && !ui.elements['boost-audio'].muted);
  }
  const ui=setup();Object.defineProperty(ui.document,'cookie',{
    get(){throw new Error('Cookies disabled');},set(){throw new Error('Cookies disabled');},
  });
  assert.doesNotThrow(()=>{sound.initAudio(ui.document);ui.volume('music',22);ui.click('music-mute');});
  assert.equal(ui.music.volume,.22);assert(ui.music.muted);
});

test('engine audio follows the saved effects channel, race identity and hidden-tab cleanup', () => {
  const ui=setup('nextrider_audio='+encodeURIComponent(JSON.stringify({sfx:{volume:24,muted:true}})));
  const calls={volume:[],audible:[],clear:0,updates:[],unlocks:0};
  const engines={setVolume(...args){calls.volume.push(args);},clear(){calls.clear++;},
    setAudible(value){calls.audible.push(value);},update(...args){calls.updates.push(args);},unlock(){calls.unlocks++;return Promise.resolve(true);}};
  const controller=sound.initAudio(ui.document,engines);
  assert.deepEqual(calls.volume.at(-1),[.24,true]);
  ui.click('sfx-mute');assert.deepEqual(calls.volume.at(-1),[.24,false]);
  ui.volume('sfx',31);assert.deepEqual(calls.volume.at(-1),[.31,false]);
  controller.setRace('beginner','race1');const clears=calls.clear;
  controller.setRace('beginner','race1');assert.equal(calls.clear,clears);
  controller.setRace('beginner','race2');assert.equal(calls.clear,clears+1);
  assert.equal(typeof controller.updateEngines,'function');
  const car={id:'local',speed:25};controller.updateEngines(car,[],1,true);
  assert.deepEqual(calls.updates.at(-1),[car,[],1,true]);
  ui.document.dispatchEvent(new Event('keydown'));assert.equal(calls.unlocks,1);
  ui.document.hidden=true;ui.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls.audible.at(-1),false,'suspended RAF cannot leave an engine audible');
});

test('driving effects fire on real state changes, choose both drift takes and stop when driving ends', async t => {
  const ui = setup(), controller = sound.initAudio(ui.document);
  assert.equal(typeof controller.updateCar, 'function');
  controller.setRace('beginner');
  const car = {id:'me',resetId:0,collisionTime:0,boostTime:0,drifting:false};
  const update = (patch, time) => { Object.assign(car,patch); controller.updateCar(car,time); };
  update({},0);
  update({collisionTime:.38,boostTime:1.4},1); await settle();
  assert.equal(ui.elements['collision-audio'].plays,1);
  assert.equal(ui.elements['boost-audio'].plays,1);
  update({collisionTime:.36,boostTime:1.38},1.02);
  assert.equal(ui.elements['collision-audio'].plays,1,'decaying recovery is not a new impact');
  update({collisionTime:.38},1.04);
  assert.equal(ui.elements['collision-audio'].plays,1,'network correction does not repeat an impact');
  update({collisionTime:0},1.5); update({collisionTime:.38},2);
  assert.equal(ui.elements['collision-audio'].plays,2);
  update({boostTime:.3,boostPadInside:false},2.1);
  update({boostTime:.85,boostPadInside:true},2.2);
  assert.equal(ui.elements['boost-audio'].plays,2,'a pad extending an active boost starts its sound');
  t.mock.method(Math,'random',()=>0);
  update({drifting:true},3); await settle();
  assert.equal(ui.elements['drift-d02-audio'].plays,1);
  update({},3.02); assert.equal(ui.elements['drift-d02-audio'].plays,1);
  t.mock.method(Math,'random',()=>.99);
  ui.elements['drift-d02-audio'].paused=true;
  ui.elements['drift-d02-audio'].dispatchEvent(new Event('ended')); await settle();
  assert.equal(ui.elements['drift-d03-audio'].plays,1,'sustained drift picks another one-shot');
  ui.volume('sfx',25); ui.click('sfx-mute');
  for(const id of ['collision-audio','boost-audio','drift-d02-audio','drift-d03-audio']) {
    assert.equal(ui.elements[id].volume,.25); assert(ui.elements[id].muted); assert(!ui.elements[id].loop);
  }
  assert.equal(ui.music.volume,.5); assert(!ui.music.muted);
  ui.click('sfx-mute'); update({drifting:false},4);
  assert(ui.elements['drift-d03-audio'].paused,'releasing drift stops the tyre sound immediately');
  update({boostTime:0,drifting:true},5);
  controller.updateCar(null,6);
  assert(ui.elements['drift-d03-audio'].paused);
  const count=ui.elements['drift-d03-audio'].plays;
  ui.elements['drift-d03-audio'].dispatchEvent(new Event('ended'));
  assert.equal(ui.elements['drift-d03-audio'].plays,count,'leaving cannot restart drift');
});

test('blocked autoplay retries on input and independent mute/volume never restart disabled audio', async () => {
  assert.equal(typeof sound.initAudio, 'function');
  const ui = setup(); ui.ambient.failure = ui.music.failure = 'NotAllowedError';
  const controller = sound.initAudio(ui.document); choose(controller); controller.setRace('technical');
  await settle(); assert(ui.ambient.paused && ui.music.paused);
  ui.click('ambient-mute');
  ui.ambient.failure = ui.music.failure = null;
  ui.document.dispatchEvent(new Event('keydown')); await settle();
  assert(ui.ambient.paused, 'muted ambient cannot restart on driving input'); assert(!ui.music.paused);
  assert.equal(ui.elements['ambient-mute'].attributes['aria-pressed'], 'true');
  ui.volume('music', 15); assert.equal(ui.music.volume, .15); assert.equal(ui.ambient.volume, .3);
  ui.click('music-mute'); assert(ui.music.muted); assert(ui.elements['music-status'].hidden);
  ui.volume('ambient', 55); await settle();
  assert(!ui.ambient.muted && !ui.ambient.paused); assert.equal(ui.ambient.volume, .55); assert(ui.music.muted);
  ui.click('music-mute'); await settle(); assert(!ui.music.muted); assert.equal(ui.music.volume, .15);
  ui.volume('ambient', 0); ui.click('ambient-mute'); await settle();
  assert(ui.ambient.volume > 0 && !ui.ambient.muted, 'unmute can recover a zero-volume slider');
});
