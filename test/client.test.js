import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { createGameServer } from '../server.js';
import { MUSIC_TRACKS } from '../shared/music.js';
import { isWrongWay, VEHICLES, STEP, createCar, stepCar, sampleTrack } from '../shared/game.js';
import { t as translate } from '../public/i18n.js';

test('vehicle performance stays visible below the selector while secondary details stay collapsed', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const lobby = html.match(/<section id="lobby"[\s\S]+?<\/section>/)?.[0]; assert(lobby);
  const details = lobby.match(/<details\b[\s\S]+?<\/details>/)?.[0]; assert(details);
  assert(!/<details\b[^>]*\bopen\b/.test(details));
  assert(details.includes('id="vehicle-info"'), 'mass and rebound remain secondary details');
  const visible = lobby.replace(details, '');
  assert.match(visible, /<select id="vehicle"><\/select>\s*<div id="vehicle-performance"/,
    'the primary stats are visible immediately after the vehicle selector');
});

test('vehicle performance updates speed and measured 0–100 time with selection, localization and fallback', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const description = source.match(/(?:const vehicleAccelerationTimes = [\s\S]+?)?function describeVehicle\(\) \{[\s\S]+?(?=\n\$\('vehicle'\)\.addEventListener)/)?.[0]; assert(description);
  const element = textContent => ({ textContent, children: [], append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; } });
  const elements = Object.fromEntries(['vehicle', 'vehicle-info', 'vehicle-performance', 'preview-name', 'preview-description'].map(id => [id, element()]));
  const text = item => item.children.length ? item.children.map(text).join(' ') : String(item.textContent);
  let language = 'ko', steps = 0, preview;
  const context = { VEHICLES, STEP, createCar, sampleTrack, world: { previewVehicle(id) { preview = id; } },
    stepCar(...args) { steps++; return stepCar(...args); }, $: id => elements[id],
    node: (_tag, _className, value) => element(value), t: (value, values) => translate(value, values, language) };
  runInNewContext(description, context);
  for (const id of ['PULSE', 'COMET', 'BOLT']) {
    elements.vehicle.value = id; runInNewContext('describeVehicle();', context);
    const car = createCar('measurement', 0, id); let ticks = 0;
    do { Object.assign(car, sampleTrack(5)); stepCar(car, { throttle: 1 }, STEP); ticks++; }
    while (car.speed < 100 / 3.6 && ticks < 1800);
    const stats = elements['vehicle-performance'].children;
    assert.equal(stats.length, 2);
    assert.equal(stats[0].children[1].textContent, `${Math.round(VEHICLES[id].maxSpeed * 3.6)} km/h`);
    assert.equal(stats[1].children[1].textContent, `${(ticks * STEP).toFixed(1)}초`);
    assert.equal(preview, id);
  }
  const measuredSteps = steps;
  elements.vehicle.value = 'PULSE'; language = 'en'; runInNewContext('describeVehicle();', context);
  assert.equal(steps, measuredSteps, 'revisiting a vehicle uses its cached measurement');
  assert.match(text(elements['vehicle-performance']), /Normal top speed/);
  assert.match(text(elements['vehicle-performance']), /0–100 km\/h acceleration.*\d+\.\d+s/);
  elements.vehicle.value = 'constructor'; runInNewContext('describeVehicle();', context);
  assert.equal(preview, 'PULSE'); assert.equal(elements['preview-name'].textContent, 'PULSE');
  assert.match(text(elements['vehicle-performance']), /190 km\/h/);
});

test('welcome name form rejects whitespace, saves a nickname and resumes the menu', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const submit = source.match(/function submitDriverName\(event\) \{[\s\S]+?(?=\nfunction )/)?.[0]; assert(submit);
  let saved = 0, resumed = 0, closed = 0, validity = '';
  const name = {}, input = { value: '   ', setCustomValidity(text) { validity = text; }, reportValidity() {} };
  const context = { nameConfirmed: false, $: id => id === 'welcome-name' ? input : id === 'name' ? name : { close() { closed++; } },
    t: text=>text, saveDriver() { saved++; }, updateUI() { resumed++; }, event: { preventDefault() {} } };
  runInNewContext(submit+'\nsubmitDriverName(event);',context);
  assert(validity); assert.equal(context.nameConfirmed,false); assert.equal(saved,0);
  input.value = '  하늘 레이서  ';
  runInNewContext('submitDriverName(event);',context);
  assert.equal(name.value,'하늘 레이서'); assert.equal(context.nameConfirmed,true);
  assert.equal(saved,1); assert.equal(resumed,1); assert.equal(closed,1);
});

test('host start asks before forcing an unready grid and confirmation sends the force request once', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const request = source.match(/function requestStart\(force = false\) \{[\s\S]+?(?=\nfunction )/)?.[0];
  assert(request, 'start action must handle the confirmation');
  let opened = 0; const sent = [];
  const context = { room: { hostId: 'host', players: [{ ready: true }, { ready: false }], phase: 'lobby' },
    localId: 'host', phase: () => context.room.phase, clearInput() {}, send: message => sent.push(message),
    $: () => ({ showModal() { opened++; } }) };
  runInNewContext(request + '\nrequestStart();', context);
  assert.equal(opened, 1); assert.equal(sent.length, 0);
  runInNewContext('requestStart(true);', context); assert.equal(sent[0].force, true);
  context.room.forceStarting = true;
  runInNewContext('requestStart(true);', context); assert.equal(sent.length, 1);
  context.room.forceStarting = false; context.localId = 'peer';
  runInNewContext('requestStart(true);', context); assert.equal(sent.length, 1);
  context.localId = 'host'; context.room.players[1].ready = true;
  runInNewContext('requestStart();', context); assert.equal(sent[1].force, false); assert.equal(opened, 1);
});

test('wrong-way warning waits for sustained reverse travel and clears on correction, finish or leaving', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const update = source.match(/function updateWrongWay\(now\) \{[\s\S]+?(?=\nfunction )/)?.[0];
  assert(update);
  const warning = { hidden: true }, car = { x: 0, z: -40, trackId: 'beginner', vx: 0, vz: 10 };
  const context = { isWrongWay, predicted: car, wrongWaySince: null, racing: () => true,
    snapshot: { cars: [{ id: 'me', finished: false }] }, localId: 'me', document: { hidden: false }, $: () => warning };
  runInNewContext(update, context);
  const tick = now => runInNewContext(`updateWrongWay(${now});`, context);
  tick(1000); tick(1500); assert.equal(warning.hidden, true, 'brief reverse motion is ignored');
  tick(1700); assert.equal(warning.hidden, false);
  car.vz = -10; tick(1800); assert.equal(warning.hidden, true);
  car.vz = 10; tick(2000); tick(2700); assert.equal(warning.hidden, false);
  context.snapshot.cars[0].finished = true; tick(2800); assert.equal(warning.hidden, true);
  context.snapshot.cars[0].finished = false; tick(3000); tick(3700); assert.equal(warning.hidden, false);
  context.racing = () => false; tick(3800); assert.equal(warning.hidden, true, 'spectators and menus never show the warning');
});

test('force-start counts down in the waiting panel without covering its heading and re-enables readiness after cancellation', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const update = source.match(/function updateForcedStartUI\(now = performance.now\(\)\) \{[\s\S]+?(?=\nfunction )/)?.[0]; assert(update);
  const elements = Object.fromEntries(['ready','result-ready','waiting','result-waiting','force-start-notice'].map(id=>[id,{}]));
  const context = { room: { forceStarting: true, raceId: 1 }, snapshot: { raceId: 1, forceStartRemaining: 5 },
    connected: true, fatal: false, phase: ()=>'lobby', queued: ()=>false, lastSnapshotAt: 1000,
    performance: { now: ()=>1000 }, $: id=>elements[id], t:(text,values)=>text.replace('{seconds}', values.seconds) };
  runInNewContext(update+'\nupdateForcedStartUI();', context);
  assert.equal(elements.ready.textContent, '게임 준비 (5)'); assert.equal(elements.ready.disabled, true);
  assert.equal(elements['force-start-notice'].hidden, true, 'drivers have an inline message instead of a floating duplicate');
  assert.match(elements.waiting.textContent, /5초/);
  runInNewContext('updateForcedStartUI(2000);',context); assert.equal(elements.ready.textContent, '게임 준비 (4)');
  context.room.forceStarting = false;
  runInNewContext('updateForcedStartUI(2000);',context); assert.equal(elements.ready.disabled,false);
  context.room.forceStarting = true; context.queued=()=>true;
  runInNewContext('updateForcedStartUI(2000);',context); assert.equal(elements['force-start-notice'].hidden,false);
});

test('music picker defaults to Random and arrows cycle through all songs and back to Random', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const choose = source.match(/function chooseMusic\(direction\) \{[\s\S]+?(?=\n\$\('music-previous'\))/)?.[0];
  assert(choose);
  const title = {}, context = { MUSIC_TRACKS, musicChoiceIndex: 0,
    selectedMusic: { mode: 'random', track: MUSIC_TRACKS[0].id },
    $: () => title, t: text => text, audio: { setMusic() {} } };
  runInNewContext(choose, context);
  const select = direction => runInNewContext(`chooseMusic(${direction})`, context);
  select(0); assert.equal(title.textContent, '랜덤'); assert.equal(context.selectedMusic.mode, 'random');
  for (const song of MUSIC_TRACKS) {
    select(1); assert.equal(title.textContent, song.title); assert.equal(context.selectedMusic.track, song.id);
    assert.equal(context.selectedMusic.mode, 'sequence');
  }
  select(1); assert.equal(title.textContent, '랜덤'); assert.equal(context.selectedMusic.mode, 'random');
  select(-1); assert.equal(context.selectedMusic.track, MUSIC_TRACKS.at(-1).id);
  select(0); assert.equal(title.textContent, '랜덤');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert(!html.includes('id="music-random"'), 'Random is a picker choice, not an extra button');
});

test('Settings debug switch and F3 share visibility, with keyboard repeat ignored', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const binding = source.match(/const debugToggle = [\s\S]+?(?=const graphicsSelect)/)?.[0];
  assert(binding, 'debug is available in Settings');
  const change = {}, elements = { 'debug-toggle': { checked: false, addEventListener: (_, handler) => { change.run = handler; } },
    'debug-status': { hidden: true }, 'net-stats': { hidden: true } };
  let keydown;
  const context = { world: null, $: id => elements[id], addEventListener: (_, handler) => { keydown = handler; } };
  runInNewContext(binding, context);
  elements['debug-toggle'].checked = true; change.run();
  assert.equal(elements['debug-status'].hidden, false); assert.equal(elements['net-stats'].hidden, false);
  const keyboard = source.match(/addEventListener\('keydown', event => \{[\s\S]+?(?=\naddEventListener\('keyup')/)?.[0];
  runInNewContext(keyboard, context);
  keydown({ code: 'F3', repeat: true, preventDefault() {} }); assert.equal(elements['debug-toggle'].checked, true);
  keydown({ code: 'F3', repeat: false, preventDefault() {} });
  assert.equal(elements['debug-toggle'].checked, false); assert.equal(elements['debug-status'].hidden, true);
  keydown({ code: 'F3', repeat: false, preventDefault() {} }); assert.equal(elements['debug-status'].hidden, false);
});

test('waiting-room arrows orbit horizontally, release cleanly and leave form controls alone', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const keyboard = source.match(/addEventListener\('keydown', event => \{[\s\S]+?(?=\naddEventListener\('blur')/)?.[0];
  const input = source.match(/function input\(\) \{[\s\S]+?(?=\nfunction )/)?.[0];
  const render = source.match(/world\.render\(states,[\s\S]+?\);/)?.[0];
  assert(keyboard && input && render);
  const handlers = {}, calls = [], context = { keys: new Set(), drivingKeys: new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','KeyA','KeyD','KeyW','KeyS']),
    room: { phase: 'lobby', players: [{ id: 'me' }] }, localId: 'me', states: [], watchId: null,
    phase: () => context.room?.phase || 'lobby', racing: () => context.room?.phase === 'racing', healthy: () => true,
    queued: () => false, document: { hidden: false }, dt: 1 / 60, now: 1000, frameMs: 1000 / 60,
    world: { render: (...args) => calls.push(args) }, addEventListener: (name, handler) => { handlers[name] = handler; } };
  runInNewContext(input + '\n' + keyboard, context);
  const event = (code, tagName = 'BODY') => ({ code, target: { tagName }, preventDefault() {} });
  handlers.keydown(event('ArrowRight', 'BUTTON')); runInNewContext(render, context);
  assert.equal(calls.at(-1)[7], 1, 'ready-button focus does not block looking around');
  handlers.keydown(event('ArrowLeft')); runInNewContext(render, context); assert.equal(calls.at(-1)[7], 0);
  handlers.keyup(event('ArrowRight')); runInNewContext(render, context); assert.equal(calls.at(-1)[7], -1);
  handlers.keyup(event('ArrowLeft')); runInNewContext(render, context); assert.equal(calls.at(-1)[7], 0);
  for (const code of ['ArrowUp','ArrowDown','KeyW','KeyS']) handlers.keydown(event(code));
  assert.equal(context.keys.size, 0, 'waiting-room up/down never drive or tilt the camera');
  for (const tag of ['INPUT','TEXTAREA','SELECT']) handlers.keydown(event('ArrowRight', tag));
  assert.equal(context.keys.size, 0, 'text editing and selection keep their arrow keys');
  handlers.keydown(event('KeyD')); runInNewContext(render, context); assert.equal(calls.at(-1)[7], 1);
  for (const phase of ['countdown','racing','finished']) {
    context.room.phase = phase; runInNewContext(render, context); assert.equal(calls.at(-1)[7], 0);
  }
  context.room = null; runInNewContext(render, context); assert.equal(calls.at(-1)[7], 0);
});

test('waiting camera rotates around the car at fixed height and restores chase view on departure', async () => {
  const source = await readFile(new URL('../public/scene.js', import.meta.url), 'utf8');
  const block = source.match(/      const focus = shown\.find[\s\S]+?(?=\n      sky\.update)/)?.[0];
  const angle = source.match(/const angle = [^\n]+/)?.[0]; assert(block && angle);
  const car = { id: 'me', x: 10, z: 20, yaw: .2, boostTime: 0 };
  const context = { THREE, shown: [car], localId: 'me', racing: false, dt: 1 / 60, cameraDt: 1 / 60, now: 0,
    cameraTurn: 0, cameraYaw: car.yaw, cameraReady: false, wasRacing: false, camera: new THREE.PerspectiveCamera(55),
    camPosition: new THREE.Vector3(), camLook: new THREE.Vector3(), wantedPosition: new THREE.Vector3(), wantedLook: new THREE.Vector3() };
  runInNewContext(angle + '\nfunction updateCamera() {\n' + block + '\n}', context);
  const tick = () => runInNewContext('updateCamera();', context);
  tick(); const initial = context.wantedPosition.clone();
  context.cameraTurn = 1;
  for (let i = 0; i < 60; i++) {
    context.now += context.dt; tick();
    assert.equal(context.camera.position.y, 3); assert.equal(context.wantedLook.y, .8);
    assert.ok(Math.abs(Math.hypot(context.wantedPosition.x - car.x, context.wantedPosition.z - car.z) - Math.sqrt(67.25)) < 1e-9);
  }
  assert.ok(context.cameraYaw > car.yaw + .8); assert.ok(context.wantedPosition.distanceTo(initial) > 3);
  context.cameraTurn = 0; const stopped = context.cameraYaw;
  for (let i = 0; i < 60; i++) tick();
  assert.equal(context.cameraYaw, stopped, 'releasing the key stops orbiting');
  context.cameraTurn = -1; for (let i = 0; i < 60; i++) tick();
  assert.ok(Math.abs(context.cameraYaw - car.yaw) < 1e-9, 'left reverses the horizontal orbit');
  context.racing = true; context.cameraTurn = 1; for (let i = 0; i < 60; i++) tick();
  assert.equal(context.cameraYaw, car.yaw); assert.equal(context.camera.position.y, 4.2);
});

test('countdown forward keys report real edges, ignore key repeat and stay held across GO', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const launch = source.match(/function sendStartInput\(\) \{[\s\S]+?(?=\nfunction )/)?.[0];
  assert.ok(launch, 'countdown forward presses must reach the server');
  const keyboard = source.match(/addEventListener\('keydown', event => \{[\s\S]+?(?=\naddEventListener\('blur')/)?.[0];
  const change = source.match(/function changePhase\(nextPhase\) \{[\s\S]+?(?=\nfunction )/)?.[0];
  const sent = [], handlers = {};
  const context = { keys: new Set(), drivingKeys: new Set(['KeyW', 'ArrowUp', 'KeyS', 'ArrowLeft']),
    room: { phase: 'countdown', raceId: 7, players: [{ id: 'me' }] }, localId: 'me', document: { hidden: false },
    healthy: () => true, phase: () => context.room.phase, racing: () => context.room.phase === 'racing',
    send: message => sent.push(message), addEventListener: (name, handler) => { handlers[name] = handler; },
    clearInput: () => { context.keys.clear(); }, updateUI() {}, resetNetwork() {}, clearCelebration() {} };
  runInNewContext(launch + '\n' + keyboard + '\n' + change, context);
  const event = (code, repeat = false) => ({ code, repeat, target: { tagName: 'BODY' }, preventDefault() {} });
  handlers.keydown(event('KeyW'));
  assert.equal(sent.at(-1).type, 'launch'); assert.equal(sent.at(-1).pressed, true); assert.equal(sent.at(-1).raceId, 7);
  handlers.keydown(event('KeyW', true)); assert.equal(sent.length, 1, 'auto-repeat is not a fresh timed press');
  runInNewContext("changePhase('racing')", context);
  assert(context.keys.has('KeyW'), 'ordinary held acceleration survives GO without a second keydown');
  handlers.keyup(event('KeyW')); assert.equal(sent.at(-1).pressed, false);
  handlers.keydown(event('ArrowUp')); assert.equal(sent.at(-1).pressed, true);
  const count = sent.length; context.document.hidden = true;
  handlers.keydown(event('KeyW')); assert.equal(sent.length, count, 'hidden pages cannot time a launch');
});

test('copy uses the clipboard or a gesture fallback, cleans up and reports a blocked copy', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const copy = source.match(/async function copyText\(text\) \{[\s\S]+?(?=\nfunction fail)/)?.[0];
  assert(copy);
  for (const mode of ['clipboard', 'http', 'modal', 'blocked']) {
    let copied, removed = false, focused = false, selected = false, inDialog = false;
    const textarea = { style: {}, select() { selected = true; }, remove() { removed = true; } };
    const context = { navigator: mode === 'clipboard' ? { clipboard: { async writeText(text) { copied = text; } } } : {},
      document: { activeElement: { focus() { focused = true; } }, createElement: () => textarea, body: { append() {} },
        querySelector: () => mode === 'modal' ? { append() { inDialog = true; } } : null,
        execCommand(command) { assert.equal(command, 'copy'); assert(selected); copied = textarea.value; return mode !== 'blocked'; } } };
    runInNewContext(copy, context);
    const result = runInNewContext("copyText('http://game.test/ABC123')", context);
    if (mode === 'blocked') await assert.rejects(result);
    else { await result; assert.equal(copied, 'http://game.test/ABC123'); }
    if (mode !== 'clipboard') { assert(removed); assert(focused); }
    if (mode === 'modal') assert(inDialog, 'HTTP copying stays inside the active modal');
  }
});

test('exit warns before leaving, including host transfer, last member and spectators', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const request = source.match(/function requestExit\(\) \{[\s\S]+?(?=\nfunction exitRoom)/)?.[0];
  assert(request);
  for (const [host, waiting, others, phase, expected] of [
    [true, false, true, 'racing', /방장이 넘어갑니다/], [true, false, false, 'racing', /방이 닫히고/],
    [false, false, true, 'racing', /경주 참여가 중단/], [false, true, true, 'racing', /관전과 다음 경기 대기가 종료/],
    [false, false, true, 'lobby', /현재 방과의 연결이 종료/],
  ]) {
    let opened = 0, cleared = 0; const message = {};
    const context = { room: { hostId: host ? 'me' : 'other', players: [{ id: 'me' }, ...(others ? [{ id: 'other' }] : [])], waiting: [] },
      localId: 'me', queued: () => waiting, phase: () => phase, clearInput: () => { cleared++; }, t: text => text,
      $: id => id === 'leave-message' ? message : { showModal() { opened++; } } };
    runInNewContext(request + '\nrequestExit();', context);
    assert.match(message.textContent, expected); assert.equal(opened, 1); assert.equal(cleared, 1);
  }
});

test('rematch shows the remaining seconds on an unready button and keeps vehicle-changing time before host readiness', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const ui = source.match(/function updateRematchUI\(now = performance.now\(\)\) \{[\s\S]+?(?=\nfunction updateStandings)/)?.[0]; assert(ui);
  const elements = { 'result-ready': { setAttribute() {} }, 'result-waiting': {} }, me = { id: 'me', ready: false };
  const context = { room: { raceId: 1, players: [me], waiting: [] }, phase: () => 'finished', localId: 'me',
    snapshot: { raceId: 1, readyRemaining: null }, lastSnapshotAt: 1000, $: id => elements[id],
    t: (text, values = {}) => text.replace(/\{seconds\}/g, values.seconds), performance: { now: () => 1000 } };
  runInNewContext(ui + '\nupdateRematchUI();', context);
  assert.match(elements['result-waiting'].textContent, /차량을 변경/);
  context.snapshot.readyRemaining = 10;
  runInNewContext('updateRematchUI();', context); assert.match(elements['result-ready'].textContent, /\(10\)/);
  runInNewContext('updateRematchUI(2000);', context); assert.match(elements['result-ready'].textContent, /\(9\)/);
  me.ready = true;
  runInNewContext('updateRematchUI(2000);', context);
  assert.equal(elements['result-ready'].textContent, '준비 완료');
});

test('incoming race audio transitions are consumed while a hidden tab has no animation frames', async () => {
  const source=await readFile(new URL('../public/main.js',import.meta.url),'utf8');
  const receive=source.match(/function receiveSnapshot\(message\) \{[\s\S]*?(?=\nfunction exitRoom)/)?.[0];
  assert(receive);
  const calls=[],document={hidden:true};
  const message={tick:2,raceId:1,phase:'finished'};
  const context={room:{},latestTick:1,lastSnapshotAt:0,snapshot:{phase:'racing',raceId:1},message,document,
    performance:{now:()=>100},healthy:()=>true,changePhase(){},updateWatchTarget(){},finishAnnouncements:()=>[],announced:{},
    snapshots:{push(){}},updateStandings(){},updateRematchUI(){},audio:{updateRace(...args){calls.push(args);}}};
  runInNewContext(receive+'\nreceiveSnapshot(message);',context);
  assert.equal(calls.length,1,'server transitions must not depend on requestAnimationFrame');
  assert.equal(calls[0][0],message);assert.equal(calls[0][1],0);assert.equal(calls[0][2],false);
  document.hidden=false;message.tick=3;message.raceId=2;message.phase='countdown';
  runInNewContext('receiveSnapshot(message);',context);assert.equal(calls.at(-1)[2],true);
});

test('Settings keeps sound controls and restores, validates and applies graphics quality', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="sound-toggle"[^>]*>설정</);
  assert.match(html, /id="sound-title">설정 /);
  assert.match(html, /<label for="graphics-quality">그래픽 품질<\/label>/);
  assert.match(html, /<select id="graphics-quality">/);
  assert(!html.includes('id="graphics-description"'));
  for (const [value, label] of [['high', '상'], ['medium', '중'], ['low', '하']]) {
    assert(html.includes(`<option value="${value}">${label}</option>`));
  }
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const settings = source.match(/const graphicsSelect = [\s\S]+?(?=const keys =)/)?.[0];
  assert(settings, 'exercise the graphics controls at app startup');
  assert.match(source, /\.then\(async scene => \{ world = scene; world\.setGraphicsQuality\(graphicsSelect\.value\);[\s\S]*?await autoGraphicsQuality\(\);[\s\S]*?assetsReady = true; updateUI\(\);/);
  for (const saved of [null, 'high', 'medium', 'low', 'invalid', 'HIGH']) {
    let change;
    const applied = [], writes = [];
    const select = { value: 'high', addEventListener(event, handler) { assert.equal(event, 'change'); change = handler; } };
    const context = { $: id => id === 'graphics-quality' ? select : {}, t: value => value, world: undefined,
      localStorage: { getItem: key => { assert.equal(key, 'nextrider.graphicsQuality'); return saved; },
        setItem: (...args) => writes.push(args) } };
    runInNewContext(settings, context);
    assert.equal(select.value, ['high', 'medium', 'low'].includes(saved) ? saved : 'high');
    select.value = 'low'; change();
    assert.deepEqual(writes.pop(), ['nextrider.graphicsQuality', 'low']);
    context.world = { setGraphicsQuality: quality => applied.push(quality) };
    select.value = 'medium'; change();
    assert.deepEqual(applied, ['medium']);
    select.value = 'invalid'; change();
    assert.deepEqual(applied, ['medium'], 'invalid values never reach the renderer');
  }
  let change;
  const select = { value: 'high', addEventListener: (_, handler) => { change = handler; } }, applied = [];
  const blocked = new Proxy({}, { get() { throw new Error('Storage blocked'); } });
  runInNewContext(settings, { $: id => id === 'graphics-quality' ? select : {}, t: value => value, localStorage: blocked, world: { setGraphicsQuality: value => applied.push(value) } });
  select.value = 'low'; assert.doesNotThrow(change); assert.deepEqual(applied, ['low']);
});

test('first-visit quality measurement persists success, skips saved choices and respects manual changes or failures', async () => {
  const source = await readFile(new URL('../public/main.js', import.meta.url), 'utf8');
  const settings = source.match(/const graphicsSelect = [\s\S]+?(?=const keys =)/)?.[0];
  for (const mode of ['automatic', 'saved', 'manual', 'manual-abort', 'early-manual', 'failed', 'invalid']) {
    let change, finish, fail, measurements = 0;
    const select = { value: 'high', addEventListener: (_, handler) => { change = handler; } };
    const status = {}, applied = [], writes = [];
    const context = { $: id => id === 'graphics-quality' ? select : status, t: value => value,
      localStorage: { getItem: () => mode === 'saved' ? 'medium' : null, setItem: (...args) => writes.push(args) },
      world: { setGraphicsQuality: value => applied.push(value), benchmarkGraphicsQuality() {
        measurements++; return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      } } };
    runInNewContext(settings, context);
    if (mode === 'early-manual') { select.value = 'low'; change(); }
    const pending = runInNewContext('autoGraphicsQuality()', context);
    if (mode === 'saved' || mode === 'early-manual') { await pending; assert.equal(measurements, 0); continue; }
    assert.equal(measurements, 1); assert.equal(status.textContent, '자동 측정 중…');
    if (mode.startsWith('manual')) { select.value = 'low'; change(); }
    if (mode === 'failed' || mode === 'manual-abort') fail(new Error('Measurement interrupted'));
    else finish({ quality: mode === 'invalid' ? 'ultra' : 'medium' });
    await pending;
    if (mode === 'failed' || mode === 'invalid') {
      assert.equal(select.value, 'high'); assert.deepEqual(writes, []); assert.deepEqual(applied, []);
      assert.match(status.textContent, /완료하지 못했습니다/);
    } else {
      const expected = mode.startsWith('manual') ? 'low' : 'medium';
      assert.equal(select.value, expected); assert.deepEqual(applied, [expected]);
      assert.deepEqual(writes, [['nextrider.graphicsQuality', expected]]);
      if (mode.startsWith('manual')) assert.equal(status.textContent, '직접 선택한 그래픽 품질을 사용합니다.');
    }
  }
});

test('browser entry, modules and original GLB assets are served with usable MIME types', async t => {
  const server = await createGameServer({ host: '127.0.0.1', port: 0 });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;
  await t.test('audio controls, optional music and cleared effects are served consistently', async () => {
    const html = await (await fetch(base)).text();
    const audioModule = await (await fetch(`${base}/audio.js`)).text();
    assert.match(html, /<audio[^>]+id="ambient-audio"[^>]+loop/);
    assert(html.includes('src="/assets/audio/ambient-waves.mp3?v=685ceeac28a4"'), "updated waves must bypass the previous browser cache");
    assert.match(html, /<button[^>]+id="sound-toggle"/);
    for (const id of ['ambient-volume', 'music-volume', 'ambient-mute', 'music-mute', 'music-status']) assert(html.includes(`id="${id}"`), id);
    for (const [file, bytes] of [['ambient-waves.mp3', 706351], ['bongo-rave.mp3', 9334110], ['you-know-me.mp3', 8233833]]) {
      const url = `/assets/audio/${file}`, configured = html.includes(url) || audioModule.includes(url);
      const music = await fetch(`${base}${url}`);
      assert.equal(music.status, configured ? 200 : 404, file);
      if (configured) {
        assert.equal(music.headers.get('content-type'), 'audio/mpeg');
        assert.equal((await music.arrayBuffer()).byteLength, bytes);
      }
    }
    for(const file of ['collision-c02','boost-b01','drift-d02','drift-d03']) {
      assert(html.includes(`/assets/audio/sfx/${file}.mp3`));
      const effect = await fetch(`${base}/assets/audio/sfx/${file}.mp3`);
      assert.equal(effect.status,200); assert.equal(effect.headers.get('content-type'),'audio/mpeg');
      const bytes = (await effect.arrayBuffer()).byteLength;
      assert(bytes>1000 && bytes<25000,'effects stay compact');
    }
    for(const id of ['sfx-volume','sfx-mute']) assert(html.includes(`id="${id}"`));
    for(const [id,file,mime] of [['countdown-tick','countdown-b-tick.wav','audio/wav'],
      ['countdown-go','countdown-b-go.wav','audio/wav'],['finish','finish-c-cheer.mp3','audio/mpeg']]) {
      assert(html.includes(`id="${id}-audio" src="/assets/audio/sfx/${file}"`));
      const response=await fetch(`${base}/assets/audio/sfx/${file}`);
      assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),mime);
      assert((await response.arrayBuffer()).byteLength<20000,'race cues stay compact');
    }
    for(const file of ['engine-sport-loop.wav','engine-rough-loop.wav']) {
      const engine=await fetch(`${base}/assets/audio/engines/${file}`);
      assert.equal(engine.status,200);assert.equal(engine.headers.get('content-type'),'audio/wav');
      assert((await engine.arrayBuffer()).byteLength<20000);
    }
  });
  await t.test('retired samples and development tools are not served in production', async () => {
    for (const url of ['/assets/driver.glb', '/assets/coast.glb', '/tools/qa/beach-review.mjs',
      '/tools/qa/sky-review.html', '/tools/qa/vehicle-review.html', '/docs/beach-review.html', '/test/client.test.js', '/art/review/serve.mjs',
      ...['pulse','bolt','comet','bulwark','slide','ignis','rally'].map(id=>`/assets/${id}.glb`)]) {
      assert.equal((await fetch(`${base}${url}`)).status, 404, url);
    }
  });
  await t.test('HTML entry', async () => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.match(await response.text(), /<html[^>]*lang="ko"/);
  });
  await t.test('JavaScript entry', async () => {
    const response = await fetch(`${base}/main.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^(text|application)\/javascript/);
  });
  await t.test('current browser modules are served without stale application caching', async () => {
    for (const module of ['main', 'models', 'netcode', 'i18n', 'driver-motion', 'sky', 'environment', 'night-lights']) {
      const response = await fetch(`${base}/${module}.js`);
      assert.equal(response.status, 200, module);
      assert.match(response.headers.get('content-type'), /^(text|application)\/javascript/);
      assert.equal(response.headers.get('cache-control'), 'no-store', module);
    }
  });
  await t.test('browser imports resolve through the actual HTML import map', async () => {
    const html = await (await fetch(base)).text();
    const { imports } = JSON.parse(html.match(/<script type="importmap">(.*?)<\/script>/s)[1]);
    const queue = ['/main.js', '/i18n.js'], seen = new Set();
    for (const url of queue) {
      if (seen.has(url)) continue;
      seen.add(url);
      const response = await fetch(`${base}${url}`);
      assert.equal(response.status, 200, url);
      assert.match(response.headers.get('content-type'), /javascript/, url);
      const source = (await response.text()).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const [, specifier] of source.matchAll(/(?:\b(?:import|export)\s+(?:[\w*{},\s]+?\s+from\s*)?|\bimport\s*\(\s*)["']([^"']+)["']/g)) {
        const prefix = Object.keys(imports).find(key => key.endsWith('/') && specifier.startsWith(key));
        const mapped = imports[specifier] || (prefix ? imports[prefix] + specifier.slice(prefix.length) : specifier);
        assert(mapped.startsWith('.') || mapped.startsWith('/'), `Unmapped browser import: ${specifier} in ${url}`);
        queue.push(new URL(mapped, `${base}${url}`).pathname);
      }
    }
  });
  await t.test('literal asset references in the scene, model map and CSS are served', async () => {
    const references = new Set();
    for (const file of ['scene.js', 'models.js', 'style.css']) {
      const source = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
      for (const [, url] of source.matchAll(/["'](\/assets\/[^"'$`]+)["']/g)) references.add(url);
    }
    assert(references.has('/assets/asphalt.png'));
    assert(references.has('/assets/sky-stars.json'));
    assert(references.has('/assets/boost-lines.svg'));
    for (const url of references) {
      const response = await fetch(`${base}${url}`);
      assert.equal(response.status, 200, url);
      assert.ok(Number(response.headers.get('content-length')) > 0, url);
      await response.arrayBuffer();
    }
  });
  await t.test('driver motion and boost overlay', async () => {
    for (const [path, mime] of [['/driver-motion.js', /javascript/], ['/assets/boost-lines.svg', /image\/svg\+xml/]]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), mime);
    }
  });
  await t.test('linear beach packages are available to the actual scene loader', async () => {
    const { BEACH_MODELS } = await import('../public/beach.js');
    for (const name of BEACH_MODELS) {
      const response = await fetch(`${base}/assets/beach/${name}.glb`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get('content-type'), 'model/gltf-binary');
      assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), 'glTF');
    }
    assert.equal((await fetch(`${base}/beach.js`)).status, 200);
  });
  await t.test('new tropical and cloud modules are served from local runtime assets', async () => {
    const { TROPICAL_MODELS, INLAND_MODELS, CLOUD_MODELS } = await import('../public/beach.js');
    for (const path of [...TROPICAL_MODELS.map(name => `tropical/${name}`), ...INLAND_MODELS.map(name => `inland/${name}`),
      ...CLOUD_MODELS.flatMap(name => ['pc', 'mobile'].map(lod => `clouds/${name}_${lod}`))]) {
      const response = await fetch(`${base}/assets/${path}.glb`);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), 'model/gltf-binary');
    }
  });
  await t.test('missing track props are served locally without optional collision proxies', async () => {
    for (const name of ['barrier_bluewhite_2m', 'bunting_span_6m', 'red_flag_pole_3m', 'wood_crate_1m',
      'wood_barrel_1m', 'boost_chevrons_visual_3m', 'road_forward_arrow_visual']) {
      const response = await fetch(`${base}/assets/track-props/${name}.glb`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get('content-type'), 'model/gltf-binary');
    }
  });
  const {VEHICLE_MODELS,VEHICLE_LIGHT_MODELS,COAST_MODELS}=await import('../public/models.js');
  for (const asset of [...Object.values({...VEHICLE_MODELS,...Object.fromEntries(Object.entries(VEHICLE_LIGHT_MODELS).map(([id,url])=>[id+'-light',url]))}).map(url=>url.slice('/assets/'.length,-4)),
    'drivers/vnext/driver_lod0', ...COAST_MODELS.map(name => `coast/${name}`)]) await t.test(`${asset} GLB`, async () => {
    const response = await fetch(`${base}/assets/${asset}.glb`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'model/gltf-binary');
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), 'glTF');
  });
});
