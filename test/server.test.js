import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import http from 'node:http';
import WebSocket from 'ws';
import { networkInterfaces } from 'node:os';
import * as game from '../shared/game.js';
import { MUSIC_TRACKS } from '../shared/music.js';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { calculateSky } from '../shared/sky.js';

const { createGameServer } = await import('../server.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

async function setup(t) {
  assert.equal(typeof createGameServer, 'function', 'server must export createGameServer');
  const server = await createGameServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, connect: async (options = {}) => {
    const socket = new WebSocket(url.replace('http:', 'ws:'), options);
    const messages = [];
    const waiting = new Set();
    socket.on('message', data => {
      messages.push(JSON.parse(data));
      for (const notify of [...waiting]) notify();
    });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const client = { socket, messages, mark: () => messages.length,
      send: message => socket.send(JSON.stringify(message)),
      next: (predicate, after = 0, timeout = 2000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(check); reject(new Error('Timed out waiting for server message')); }, timeout);
        function check() {
          const message = messages.slice(after).find(predicate);
          if (message) { clearTimeout(timer); waiting.delete(check); resolve(message); }
        }
        waiting.add(check); check();
      }) };
    client.id = (await client.next(m => m.type === 'welcome')).id;
    return client;
  } };
}

test('host force-start gives every participant five seconds, cannot be reset or skipped, and readies the grid', { timeout: 12000 }, async t => {
  const { connect } = await setup(t), host = await connect(), peer = await connect(), late = await connect();
  host.send({ type: 'create' });
  const room = await host.next(m => m.type === 'room');
  peer.send({ type: 'join', code: room.code }); await peer.next(m => m.type === 'room');
  peer.send({ type: 'start', force: true });
  assert.match((await peer.next(m => m.type === 'error')).message, /host/i);
  host.send({ type: 'start', force: 'true' });
  assert.match((await host.next(m => m.type === 'error')).message, /force/i);
  const mark = host.mark(), requestedAt = performance.now();
  host.send({ type: 'start', force: true });
  await host.next(m => m.type === 'room' && m.forceStarting, mark);
  const first = await peer.next(m => m.type === 'snapshot' && m.forceStartRemaining > 4);
  assert.equal(first.phase, 'lobby'); assert.equal(first.raceId, 0);
  late.send({ type: 'join', code: room.code });
  assert.equal((await late.next(m => m.type === 'room')).forceStarting, true);
  await late.next(m => m.type === 'snapshot' && m.forceStartRemaining > 0);
  const next = host.mark(); host.send({ type: 'start', force: true });
  peer.send({ type: 'ready', ready: true }); late.send({ type: 'ready', ready: true });
  await host.next(m => m.type === 'room' && m.players.length === 3 && m.players.every(p => p.ready), next);
  const ticking = await host.next(m => m.type === 'snapshot' && m.forceStartRemaining < 3, next, 4000);
  assert(ticking.forceStartRemaining > 0); assert.equal(ticking.phase, 'lobby');
  late.send({ type: 'ready', ready: false });
  await host.next(m => m.type === 'room' && m.players.some(p => !p.ready), next);
  const started = await host.next(m => m.type === 'room' && m.phase === 'countdown', mark, 5000);
  assert(performance.now() - requestedAt >= 4900);
  assert.equal(started.raceId, 1); assert.equal(started.forceStarting, false);
  assert(started.players.every(p => p.ready)); assert(started.racePlayers.every(p => p.ready));
  const frame = await late.next(m => m.type === 'snapshot' && m.phase === 'countdown', 0, 2000);
  assert.equal(frame.forceStartRemaining, null); assert(frame.countdown > 2.8);
});

test('GO launch timing is server-authoritative, free, once per race and ignores held or late presses', { timeout: 8000 }, async t => {
  const { connect } = await setup(t), [host, early, held, late] = await Promise.all([connect(), connect(), connect(), connect()]);
  host.send({ type: 'create' }); const room = await host.next(m => m.type === 'room');
  for (const peer of [early, held, late]) { peer.send({ type: 'join', code: room.code }); await peer.next(m => m.type === 'room'); peer.send({ type: 'ready', ready: true }); }
  await host.next(m => m.type === 'room' && m.players.length === 4 && m.players.every(p => p.ready));
  host.send({ type: 'start' }); const countdown = await host.next(m => m.type === 'snapshot' && m.phase === 'countdown');
  const press = (client, pressed, extra = {}) => client.send({ type: 'launch', raceId: countdown.raceId, pressed, ...extra });
  press(held, true);
  const bad = host.mark(); press(host, 'yes');
  assert.match((await host.next(m => m.type === 'error', bad)).message, /launch/i);
  await early.next(m => m.type === 'snapshot' && m.phase === 'countdown' && m.countdown < .15, 0, 4000);
  press(early, true, { time: 999999, duration: 999999 });
  const racing = await host.next(m => m.type === 'snapshot' && m.phase === 'racing', 0, 4000);
  press(host, true); press(held, true);
  const boosted = await host.next(m => m.type === 'snapshot' && m.cars.find(c => c.id === host.id)?.startBoosted);
  for (const client of [host, early]) {
    const car = boosted.cars.find(c => c.id === client.id);
    assert.equal(car.startBoosted, true); assert(car.boostTime > .5 && car.boostTime <= game.BOOST_PAD.duration);
    assert.equal(car.charge, 50);
  }
  assert.equal(boosted.cars.find(c => c.id === held.id).startBoosted, false);
  await late.next(m => m.type === 'snapshot' && m.raceTime > .6);
  press(late, true, { time: 0 });
  const mark = late.mark(), unchanged = await late.next(m => m.type === 'snapshot' && m.raceTime > .75, mark);
  assert.equal(unchanged.cars.find(c => c.id === late.id).startBoosted, false, 'client timestamps cannot claim a late launch');
});

test('host departure cancels force-start and a replacement host must start explicitly', async t => {
  const { connect } = await setup(t), host = await connect(), peer = await connect();
  host.send({ type: 'create' }); const room = await host.next(m => m.type === 'room');
  peer.send({ type: 'join', code: room.code }); await peer.next(m => m.type === 'room');
  host.send({ type: 'start', force: true }); await peer.next(m => m.type === 'room' && m.forceStarting);
  const mark = peer.mark(); host.send({ type: 'leave' });
  const changed = await peer.next(m => m.type === 'room' && m.hostId === peer.id, mark);
  assert.equal(changed.forceStarting, false); assert.equal(changed.phase, 'lobby');
  const frame = await peer.next(m => m.type === 'snapshot', peer.messages.indexOf(changed) + 1);
  assert.equal(frame.forceStartRemaining, null);
});

test('room lap choices are validated, shared and preserved when a race starts or the host leaves', async t => {
  const { connect } = await setup(t), host = await connect(), peer = await connect();
  for (const [trackId, options] of Object.entries({ beginner: [3, 5, 7], technical: [1, 3, 5], mandalika: [1, 3, 5] })) {
    for (const laps of options) {
      const mark = host.mark(); host.send({ type: 'create', trackId, laps });
      const room = await host.next(m => m.type === 'room', mark);
      assert.equal(room.laps, laps);
      const frame = await host.next(m => m.type === 'snapshot', host.messages.indexOf(room) + 1);
      assert.equal(frame.laps, laps); assert.equal(frame.cars[0].laps, laps);
    }
  }
  const original = host.messages.filter(m => m.type === 'room').at(-1);
  for (const laps of [0, 2, 4, 6, 8, '3', null]) {
    const mark = host.mark(); host.send({ type: 'create', trackId: 'technical', laps });
    assert.match((await host.next(m => m.type === 'error', mark)).message, /lap/i);
  }
  peer.send({ type: 'join', code: original.code, laps: 1 });
  assert.equal((await peer.next(m => m.type === 'room')).laps, 5);
  peer.send({ type: 'ready', ready: true });
  await host.next(m => m.type === 'room' && m.players.length === 2 && m.players.every(p => p.ready));
  host.send({ type: 'start' });
  const started = await host.next(m => m.type === 'snapshot' && m.phase === 'countdown');
  assert.equal(started.laps, 5); assert(started.cars.every(car => car.laps === 5));
  host.send({ type: 'leave' });
  assert.equal((await peer.next(m => m.type === 'room' && m.hostId === peer.id)).laps, 5);
});

test('room music defaults stay valid and selected music reaches joiners, spectators and the next host', async t => {
  const { connect } = await setup(t), [host, peer, watcher] = await Promise.all([connect(), connect(), connect()]);
  const ids = MUSIC_TRACKS.map(track => track.id);
  for (const options of [{}, { musicMode: 'sequence' }, { musicMode: 'random', musicTrack: ids[1] ?? ids[0] },
    { musicMode: 'sequence', musicTrack: ids[0] }, { musicMode: 'sequence', musicTrack: ids.at(-1) }]) {
    const mark = host.mark(); host.send({ type: 'create', ...options });
    const room = await host.next(m => m.type === 'room', mark);
    assert.equal(room.musicMode, options.musicMode ?? 'random');
    assert(ids.includes(room.musicTrack));
    if (options.musicTrack) assert.equal(room.musicTrack, options.musicTrack);
    const snapshot = await host.next(m => m.type === 'snapshot', host.messages.indexOf(room) + 1);
    assert.equal(snapshot.musicMode, room.musicMode); assert.equal(snapshot.musicTrack, room.musicTrack);
  }
  const room = host.messages.filter(m => m.type === 'room').at(-1);
  peer.send({ type: 'join', code: room.code, musicMode: 'random', musicTrack: ids[0] });
  const joined = await peer.next(m => m.type === 'room');
  assert.equal(joined.musicMode, 'sequence'); assert.equal(joined.musicTrack, ids.at(-1));
  peer.send({ type: 'ready', ready: true });
  await host.next(m => m.type === 'room' && m.players.length === 2 && m.players.every(p => p.ready));
  host.send({ type: 'start' });
  const countdown = await host.next(m => m.type === 'snapshot' && m.phase === 'countdown');
  assert.equal(countdown.musicMode, 'sequence'); assert.equal(countdown.musicTrack, ids.at(-1));
  watcher.send({ type: 'join', code: room.code, wait: true });
  const watching = await watcher.next(m => m.type === 'room');
  assert.equal(watching.musicTrack, ids.at(-1)); assert.equal(watching.musicMode, 'sequence');
  const seen = await watcher.next(m => m.type === 'snapshot');
  assert.equal(seen.musicTrack, ids.at(-1)); assert.equal(seen.musicMode, 'sequence');
  const mark = peer.mark(); host.send({ type: 'leave' });
  const inherited = await peer.next(m => m.type === 'room' && m.hostId === peer.id, mark);
  assert.equal(inherited.musicTrack, ids.at(-1)); assert.equal(inherited.musicMode, 'sequence');
});

test('invalid room music choices preserve current membership and room settings', async t => {
  const { connect } = await setup(t), host = await connect();
  host.send({ type: 'create', name: 'Host', musicMode: 'sequence', musicTrack: MUSIC_TRACKS[0].id });
  const room = await host.next(m => m.type === 'room');
  for (const options of [
    ...['', 'shuffle', '__proto__', null, 7, {}, ['random']].map(musicMode => ({ musicMode })),
    ...['', 'unlicensed-song', '__proto__', null, 7, {}, [MUSIC_TRACKS[0].id]].map(musicTrack => ({ musicTrack })),
  ]) {
    const mark = host.mark(); host.send({ type: 'create', name: 'Changed', ...options });
    assert.match((await host.next(m => m.type === 'error', mark)).message, /music/i);
    host.send({ type: 'ready', ready: true });
    const unchanged = await host.next(m => m.type === 'room', mark);
    assert.equal(unchanged.code, room.code); assert.equal(unchanged.players[0].name, 'Host');
    assert.equal(unchanged.musicMode, 'sequence'); assert.equal(unchanged.musicTrack, MUSIC_TRACKS[0].id);
  }
});

test('audio HTTP serves byte ranges, full HEAD metadata and private cache headers', async t => {
  const { url } = await setup(t);
  for (const filename of ['ambient-waves.mp3', 'sfx/boost-b01.mp3', 'sfx/countdown-b-go.wav', ...MUSIC_TRACKS.map(track => `music/${track.id}.mp3`)]) {
    const body = await readFile(new URL(`../public/assets/audio/${filename}`, import.meta.url));
    const resource = `${url}/assets/audio/${filename}${filename.startsWith('music/') || filename === 'ambient-waves.mp3' ? '?v=replacement' : ''}`;
    const head = await fetch(resource, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), body.length);
    assert.equal(head.headers.get('accept-ranges'), 'bytes'); assert.match(head.headers.get('cache-control'), /private.*max-age=86400/);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const rangedHead = await fetch(resource, { method: 'HEAD', headers: { Range: 'bytes=0-31' } });
    assert.equal(rangedHead.status, 200); assert.equal(Number(rangedHead.headers.get('content-length')), body.length);
    assert.equal(rangedHead.headers.get('content-range'), null);
    const full = await fetch(resource);
    assert.equal(full.status, 200); assert.deepEqual(Buffer.from(await full.arrayBuffer()), body);
    for (const [range, start, end] of [['bytes=0-31', 0, 31], ['bytes=32-', 32, body.length - 1], ['bytes=-17', body.length - 17, body.length - 1], [`bytes=-${body.length + 100}`, 0, body.length - 1], [`bytes=${body.length - 9}-${body.length + 100}`, body.length - 9, body.length - 1]]) {
      const response = await fetch(resource, { headers: { Range: range } });
      assert.equal(response.status, 206, range);
      assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${body.length}`);
      assert.equal(Number(response.headers.get('content-length')), end - start + 1);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), body.subarray(start, end + 1));
    }
    for (const range of ['bytes=0-2,5-7', 'bytes=bad', 'bytes=5-2', 'bytes=-0', `bytes=${body.length}-`, 'bytes=9007199254740992-', 'items=0-2']) {
      const response = await fetch(resource, { headers: { Range: range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get('content-range'), `bytes */${body.length}`);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
  }
});

test('rematch waits for host readiness, starts after ten seconds or all ready, and cancels with the host', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const update = source.match(/function updateAutoStart\(room, now\) \{[\s\S]+?(?=\n  function )/)?.[0];
  assert(update);
  const host = { id: 'host', ready: false }, peer = { id: 'peer', ready: false };
  const room = { phase: 'finished', hostId: 'host', players: new Map([['host', host], ['peer', peer]]), readyEnd: null };
  let starts = 0;
  const context = { room, startRace: () => { starts++; room.phase = 'countdown'; } };
  runInNewContext(update, context);
  const tick = now => runInNewContext(`updateAutoStart(room, ${now})`, context);
  tick(1000); assert.equal(room.readyEnd, null); assert.equal(starts, 0);
  host.ready = true; tick(2000); assert.equal(room.readyEnd, 12000);
  tick(11999); assert.equal(starts, 0);
  host.ready = false; tick(12000); assert.equal(starts, 0); assert.equal(room.readyEnd, null);
  host.ready = true; tick(13000); tick(23000); assert.equal(starts, 1);
  room.phase = 'finished'; room.readyEnd = null; peer.ready = true; tick(24000); assert.equal(starts, 2);
  const leave = source.match(/function leave\(player, notify = false\) \{[\s\S]+?(?=\n  function receive)/)?.[0]; assert(leave);
  room.phase = 'finished'; room.readyEnd = 30000; room.waiting = new Map();
  Object.assign(context, { player: { id: 'host', room }, clearCommands() {}, promoteWaiting() {}, broadcastRoom() {},
    members: target => [...target.players.values(), ...target.waiting.values()] });
  runInNewContext(leave + '\nleave(player);', context);
  assert.equal(room.hostId, 'peer'); assert.equal(peer.ready, false); assert.equal(room.readyEnd, null);
  tick(25000); assert.equal(starts, 2, 'a new host must explicitly prepare before restarting');
  room.phase = 'lobby'; room.readyEnd = null; tick(25000); assert.equal(starts, 2, 'first-race lobby still uses the explicit start action');
});

test('selected room time survives weather updates and host transfer; invalid choices preserve membership', async t => {
  const { connect } = await setup(t), host = await connect(), peer = await connect();
  const environment = { timestamp: Date.parse('2026-10-23T03:00:00Z'), timeZone: 'Asia/Jakarta', utcOffset: 420,
    latitude: -6.2, longitude: 106.8, source: 'timezone', cloudCover: null, weatherAt: null };
  host.send({ type: 'create', timeOfDay: 'night', environment });
  const room = await host.next(m => m.type === 'room'); assert.equal(room.timeOfDay, 'night');
  assert(Math.abs(room.environment.timestamp - environment.timestamp) > 3600000);
  peer.send({ type: 'join', code: room.code });
  assert.equal((await peer.next(m => m.type === 'room')).timeOfDay, 'night');
  let mark = host.mark(); host.send({ type: 'create', timeOfDay: '__proto__', environment });
  await host.next(m => m.type === 'error', mark);
  mark = host.mark(); host.send({ type: 'environment', code: room.code, environment: { ...environment, cloudCover: 0, weatherAt: environment.timestamp } });
  const updated = await host.next(m => m.type === 'room' && m.environment?.cloudCover === 0, mark);
  assert(updated.environment.timestamp >= room.environment.timestamp && updated.environment.timestamp < room.environment.timestamp + 2000);
  mark = peer.mark(); host.send({ type: 'leave' }); await peer.next(m => m.type === 'room' && m.hostId === peer.id, mark);
  mark = peer.mark(); peer.send({ type: 'environment', code: room.code, environment });
  const inherited = await peer.next(m => m.type === 'room' && m.environment?.cloudCover === null, mark);
  assert(inherited.environment.timestamp >= room.environment.timestamp && inherited.environment.timestamp < room.environment.timestamp + 2000);
  mark = peer.mark(); peer.send({ type: 'environment', code: room.code, environment: { ...environment,
    timeZone: 'America/New_York', utcOffset: -240, latitude: 40.7, longitude: -74 } });
  const moved = (await peer.next(m => m.type === 'room' && m.environment?.timeZone === 'America/New_York', mark)).environment;
  assert(calculateSky(moved.timestamp, moved.latitude, moved.longitude).sun.altitude < -40, 'night stays night after a host moves across time zones');
});

for (const mode of ['input','inputs']) test(`${mode}: brake light metadata reaches peers and clears after neutral`, async t => {
  const {connect}=await setup(t),host=await connect(),peer=await connect();
  t.after(()=>{host.socket.close();peer.socket.close();});
  host.send({type:'create',trackId:'beginner',vehicle:'PULSE'});
  const room=await host.next(m=>m.type==='room');peer.send({type:'join',code:room.code});
  await peer.next(m=>m.type==='room');host.send({type:'ready',ready:true});peer.send({type:'ready',ready:true});
  await host.next(m=>m.type==='room'&&m.players.length===2&&m.players.every(p=>p.ready));host.send({type:'start'});
  const race=await host.next(m=>m.type==='snapshot'&&m.phase==='racing',0,5000);
  let seq=0;
  const throttle=value=>host.send(mode==='input'?{type:mode,raceId:race.raceId,seq:++seq,throttle:value,steer:0}:
    {type:mode,raceId:race.raceId,commands:Array.from({length:8},()=>({seq:++seq,throttle:value,steer:0}))});
  throttle(1);
  // Keep braking visible across several 20 Hz snapshots instead of one low-speed frame.
  const accelerating=setInterval(()=>throttle(1),100);
  const moving=await host.next(m=>m.type==='snapshot'&&m.cars.find(c=>c.id===host.id).speed>10,host.mark())
    .finally(()=>clearInterval(accelerating));
  assert.equal(moving.cars.find(c=>c.id===host.id).braking,false);
  const mark=host.mark();throttle(-1);
  const stopped=await host.next(m=>m.type==='snapshot'&&m.cars.find(c=>c.id===host.id).braking===true,mark);
  const same=await peer.next(m=>m.type==='snapshot'&&m.tick===stopped.tick);
  assert.deepEqual(same.cars,stopped.cars);
  const car=stopped.cars.find(c=>c.id===host.id);assert.equal(car.vehicle,'PULSE');assert.equal(car.radius,undefined);
  const released=host.mark();host.send({type:'neutral',raceId:race.raceId});
  await peer.next(m=>m.type==='snapshot'&&m.tick>stopped.tick&&m.cars.find(c=>c.id===host.id).braking===false,released);
});

test('only the current host controls the shared sky and late joiners inherit its advancing clock', async t => {
  const { connect } = await setup(t), [host, peer, late] = await Promise.all([connect(), connect(), connect()]);
  const environment = { timestamp: Date.parse('2026-10-22T03:00:00Z'), timeZone: 'Asia/Seoul', utcOffset: 540,
    latitude: 37.55, longitude: 126.97, source: 'timezone', cloudCover: null, weatherAt: null };
  host.send({ type: 'create', environment });
  const room = await host.next(m => m.type === 'room');
  assert.ok(room.environment, 'rooms must include the host sky');
  assert.equal(room.environment.timeZone, 'Asia/Seoul');
  peer.send({ type: 'join', code: room.code }); await peer.next(m => m.type === 'room');
  let mark = peer.mark(); peer.send({ type: 'environment', code: room.code, environment: { ...environment, cloudCover: 99 } });
  await peer.next(m => m.type === 'error', mark);
  mark = host.mark(); host.send({ type: 'environment', code: room.code, environment: { ...environment, latitude: 91 } });
  await host.next(m => m.type === 'error', mark);
  mark = host.mark(); host.send({ type: 'environment', code: room.code, environment: { ...environment, cloudCover: 0, weatherAt: Date.now() } });
  const updated = await host.next(m => m.type === 'room' && m.environment?.cloudCover === 0, mark);
  assert.ok(updated.environment.timestamp >= environment.timestamp);
  late.send({ type: 'join', code: room.code });
  const inherited = await late.next(m => m.type === 'room');
  assert.equal(inherited.environment.cloudCover, 0);
  assert.ok(inherited.environment.timestamp >= updated.environment.timestamp);
  mark = peer.mark(); host.send({ type: 'leave' });
  await peer.next(m => m.type === 'room' && m.hostId === peer.id, mark);
  mark = peer.mark(); peer.send({ type: 'environment', code: room.code, environment: { ...environment, timeZone: 'Asia/Jakarta', latitude: -6.2, longitude: 106.8 } });
  assert.equal((await peer.next(m => m.type === 'room' && m.environment?.timeZone === 'Asia/Jakarta', mark)).hostId, peer.id);
});

test('snapshot timestamps separate packet creation from the last completed physics step', async t => {
  const { connect } = await setup(t), client = await connect();
  client.send({ type: 'create' });
  const first = await client.next(m => m.type === 'snapshot');
  const later = await client.next(m => m.type === 'snapshot' && m.tick >= first.tick + 6);
  for (const frame of [first, later]) {
    assert.ok(Number.isFinite(frame.stateTime) && Number.isFinite(frame.serverNow));
    assert.ok(frame.stateTime <= frame.serverNow);
    assert.ok(frame.serverNow - frame.stateTime < game.STEP * 1000 + 30);
  }
  assert.ok(Math.abs(later.stateTime - first.stateTime - (later.tick - first.tick) * game.STEP * 1000) < .001);
});

test('course selection is validated and stays with each room and its joining drivers', async t => {
  const { connect } = await setup(t);
  const [host, novice, peer] = await Promise.all([connect(), connect(), connect()]);
  for (const trackId of ['missing', 'constructor', {}, null]) {
    const mark = host.mark();
    host.send({ type: 'create', trackId });
    assert.match((await host.next(m => m.type === 'error', mark)).message, /circuit/i);
  }
  host.send({ type: 'create', trackId: 'technical' });
  const technical = await host.next(m => m.type === 'room');
  assert.equal(technical.trackId, 'technical');
  novice.send({ type: 'create' });
  const beginner = await novice.next(m => m.type === 'room');
  assert.equal(beginner.trackId, 'beginner');
  peer.send({ type: 'join', code: technical.code, trackId: 'beginner' });
  assert.equal((await peer.next(m => m.type === 'room')).trackId, 'technical');
  const joined = await peer.next(m => m.type === 'snapshot');
  assert.ok(joined.cars.every(car => car.trackId === 'technical'));
  peer.send({ type: 'ready', ready: true });
  await host.next(m => m.type === 'room' && m.players.length === 2 && m.players.every(p => p.ready));
  host.send({ type: 'start' });
  const countdown = await host.next(m => m.type === 'snapshot' && m.phase === 'countdown');
  assert.equal(countdown.trackId, 'technical');
  assert.ok(countdown.cars.every(car => car.trackId === 'technical'));
  peer.send({ type: 'list' });
  const directory = await peer.next(m => m.type === 'rooms');
  assert.equal(directory.rooms.find(room => room.code === beginner.code).trackId, 'beginner');
  assert.equal(directory.rooms.find(room => room.code === technical.code).trackId, 'technical');
});

test('vehicle changes preserve readiness before departure and are locked only for active racers', async t => {
  const { connect } = await setup(t);
  const [host, peer, watcher] = await Promise.all([connect(), connect(), connect()]);
  host.send({ type: 'create' });
  const room = await host.next(m => m.type === 'room');
  peer.send({ type: 'join', code: room.code });
  await peer.next(m => m.type === 'room');
  peer.send({ type: 'ready', ready: true });
  await host.next(m => m.type === 'room' && m.players.length === 2 && m.players.every(p => p.ready));
  for (const client of [host, peer]) {
    const mark = client.mark();
    client.send({ type: 'vehicle', vehicle: 'BOLT' });
    const changed = await client.next(m => m.type === 'room' && m.players.find(p => p.id === client.id)?.vehicle === 'BOLT', mark);
    assert.equal(changed.players.find(p => p.id === client.id).ready, true);
    const frame = await client.next(m => m.type === 'snapshot' && m.cars.find(c => c.id === client.id)?.vehicle === 'BOLT', mark);
    assert.equal(frame.cars.find(c => c.id === client.id).lastInputSeq, 0);
  }
  for (const vehicle of ['constructor', '__proto__', null, {}]) {
    const mark = peer.mark(); peer.send({ type: 'vehicle', vehicle });
    assert.match((await peer.next(m => m.type === 'error', mark)).message, /vehicle/i);
  }
  host.send({ type: 'start' });
  await peer.next(m => m.type === 'room' && m.phase === 'countdown');
  const mark = peer.mark(); peer.send({ type: 'vehicle', vehicle: 'COMET' });
  assert.match((await peer.next(m => m.type === 'error', mark)).message, /locked/i);
  watcher.send({ type: 'join', code: room.code, wait: true });
  const queued = await watcher.next(m => m.type === 'room');
  assert.equal(queued.waiting.find(p => p.id === watcher.id).ready, true);
  const watchMark = watcher.mark(); watcher.send({ type: 'vehicle', vehicle: 'RALLY' });
  const changed = await watcher.next(m => m.type === 'room' && m.waiting.find(p => p.id === watcher.id)?.vehicle === 'RALLY', watchMark);
  assert.equal(changed.waiting.find(p => p.id === watcher.id).ready, true);
});

test('four real peers share an authoritative race, validation, and surviving room', { timeout: 12000 }, async t => {
  const { connect } = await setup(t);
  const clients = await Promise.all(Array.from({ length: 5 }, () => connect()));
  const [host, a, b, c, extra] = clients;
  host.send({ type: 'create', name: 'Host' });
  const created = await host.next(m => m.type === 'room');
  assert.equal(created.players[0].vehicle, 'PULSE');
  assert.equal(created.players[0].ready, true);
  assert.equal(created.hostId, host.id);
  for (const [index, client] of [a, b, c].entries()) {
    client.send({ type: 'join', code: created.code, name: `Peer ${index}`,
      ...(index === 0 ? { vehicle: Object.keys(game.VEHICLES).find(id => id !== 'PULSE') } : {}) });
    await client.next(m => m.type === 'room' && m.players.length === index + 2);
  }
  const full = await host.next(m => m.type === 'room' && m.players.length === 4);
  assert.notEqual(full.players.find(player => player.id === a.id).vehicle, 'PULSE');
  assert.deepEqual(full.players.map(p => p.slot), [0, 1, 2, 3]);
  extra.send({ type: 'join', code: created.code, name: 'Fifth' });
  assert.match((await extra.next(m => m.type === 'error')).message, /full|four|4/i);
  a.send({ type: 'start' });
  assert.match((await a.next(m => m.type === 'error')).message, /host/i);
  host.send({ type: 'start' });
  assert.match((await host.next(m => m.type === 'error')).message, /ready/i);
  for (const client of [a, b, c]) client.send({ type: 'ready', ready: true });
  await host.next(m => m.type === 'room' && m.players.length === 4 && m.players.every(p => p.ready));
  const startedAt = performance.now(), startMark = host.mark();
  host.send({ type: 'start' });
  const countdown = await host.next(m => m.type === 'snapshot' && m.phase === 'countdown', startMark);
  assert.equal(countdown.raceId, 1);
  assert.deepEqual(countdown.finishers, []);
  assert.equal(countdown.cars.find(car => car.id === a.id).vehicle, full.players.find(p => p.id === a.id).vehicle);
  assert.ok(countdown.countdown > 2.8 && countdown.countdown <= 3);
  extra.send({ type: 'join', code: created.code, name: 'Late' });
  await extra.next(m => m.type === 'error' && /race|started|progress/i.test(m.message), extra.mark() - 1);
  const racing = await host.next(m => m.type === 'snapshot' && m.phase === 'racing', startMark, 5000);
  assert.ok(performance.now() - startedAt >= 2900, 'countdown must last three real seconds');
  for (const client of [a, b, c]) {
    const same = await client.next(m => m.type === 'snapshot' && m.tick === racing.tick);
    assert.deepEqual(same.cars, racing.cars);
  }
  const before = new Map(racing.cars.map(car => [car.id, car]));
  const inputMark = host.mark();
  host.send({ type: 'input', raceId: racing.raceId, seq: 1, throttle: 1, steer: 0, drift: false, boost: false, reset: false,
    id: a.id, x: 999999, z: 999999, lap: 3, vehicle: 'INVALID', mass: 100000 });
  const moved = await host.next(m => m.type === 'snapshot' && m.raceTime > racing.raceTime + 0.2, inputMark);
  const own = moved.cars.find(car => car.id === host.id);
  assert.equal(own.lastInputSeq, 1);
  assert.equal(own.vehicle, 'PULSE');
  assert.equal(own.mass, undefined, 'client mass is never copied into authoritative state');
  assert.equal(moved.cars.find(car => car.id === a.id).vehicle, full.players.find(p => p.id === a.id).vehicle);
  assert.ok(Math.hypot(own.x - before.get(host.id).x, own.z - before.get(host.id).z) > 0.1);
  for (const car of moved.cars.filter(car => car.id !== host.id)) {
    assert.equal(car.x, before.get(car.id).x);
    assert.equal(car.z, before.get(car.id).z);
    assert.equal(car.lastInputSeq, 0);
  }
  const badMark = host.mark();
  host.socket.send('{broken');
  host.send({ type: 'input', raceId: racing.raceId, seq: 2, throttle: null, steer: 'bad', drift: true });
  host.send({ type: 'input', raceId: racing.raceId, seq: 1, throttle: 1, steer: 0 });
  await host.next(m => m.type === 'error', badMark);
  const stale = await host.next(m => m.type === 'snapshot' && m.raceTime > moved.raceTime + 0.65, badMark);
  assert.ok(stale.cars.every(car => Object.values(car).every(value => typeof value !== 'number' || Number.isFinite(value))));
  assert.equal(stale.cars.find(car => car.id === host.id).lastInputSeq, 1);
  const later = await host.next(m => m.type === 'snapshot' && m.raceTime > stale.raceTime + 0.2, host.mark());
  assert.ok(later.cars.find(car => car.id === host.id).speed < stale.cars.find(car => car.id === host.id).speed, 'stale throttle expires');
  const leaveMark = a.mark();
  host.socket.close();
  const survivors = await a.next(m => m.type === 'room' && m.players.length === 3, leaveMark);
  assert.equal(survivors.hostId, a.id);
  assert.equal(survivors.phase, 'racing');
  const remaining = await a.next(m => m.type === 'snapshot' && m.tick > later.tick && m.cars.length === 3, leaveMark);
  assert.ok(!remaining.cars.some(car => car.id === host.id));
  a.send({ type: 'leave' });
  await a.next(m => m.type === 'closed', a.mark() - 1);
  assert.equal((await b.next(m => m.type === 'room' && m.players.length === 2)).hostId, b.id);
});

test('lobby slots are reused, failed joins preserve membership, and solo starts', { timeout: 7000 }, async t => {
  const { connect } = await setup(t);
  const [host, peer, next] = await Promise.all([connect(), connect(), connect()]);
  host.send({ type: 'create', name: 'Solo' });
  const room = await host.next(m => m.type === 'room');
  const initial = await host.next(m => m.type === 'snapshot');
  assert.equal(initial.raceId, 0);
  assert.deepEqual(initial.finishers, []);
  peer.send({ type: 'join', code: room.code, name: 'Peer' });
  await host.next(m => m.type === 'room' && m.players.length === 2);
  host.send({ type: 'join', code: 'MISSING', name: 'Oops' });
  await host.next(m => m.type === 'error');
  peer.send({ type: 'leave' });
  await host.next(m => m.type === 'room' && m.players.length === 1, host.mark());
  next.send({ type: 'join', code: room.code, name: 'Next' });
  assert.equal((await next.next(m => m.type === 'room')).players.find(p => p.id === next.id).slot, 1);
  next.send({ type: 'leave' });
  await host.next(m => m.type === 'room' && m.players.length === 1, host.mark());
  host.send({ type: 'start' });
  assert.equal((await host.next(m => m.type === 'snapshot' && m.phase === 'racing', 0, 5000)).cars.length, 1);
});

test('room directory reflects membership, capacity, race status and removal', { timeout: 8000 }, async t => {
  const { connect } = await setup(t);
  const [host, visitor, a, b, c] = await Promise.all(Array.from({ length: 5 }, () => connect()));
  async function list() {
    const mark = visitor.mark(); visitor.send({ type: 'list' });
    return (await visitor.next(m => m.type === 'rooms', mark)).rooms;
  }
  assert.deepEqual(await list(), []);
  host.send({ type: 'create', name: '해안 방장' });
  const room = await host.next(m => m.type === 'room');
  assert.deepEqual(await list(), [{ code: room.code, trackId: 'beginner', laps: 3, hostName: '해안 방장', playerCount: 1, maxPlayers: 4, phase: 'lobby', joinable: true, waitingCount: 0, watchable: false }]);
  for (const [index, peer] of [a, b, c].entries()) {
    peer.send({ type: 'join', code: room.code, name: 'Peer' });
    await peer.next(m => m.type === 'room' && m.players.length === index + 2);
  }
  assert.equal((await list())[0].joinable, false);
  assert.equal((await list())[0].playerCount, 4);
  visitor.send({ type: 'join', code: room.code });
  assert.match((await visitor.next(m => m.type === 'error')).message, /full/);
  for (const peer of [a, b, c]) { peer.send({ type: 'leave' }); await peer.next(m => m.type === 'closed'); }
  assert.equal((await list())[0].joinable, true);
  host.send({ type: 'start' });
  await host.next(m => m.type === 'room' && m.phase === 'countdown');
  assert.equal((await list())[0].phase, 'countdown');
  assert.equal((await list())[0].joinable, false);
  await host.next(m => m.type === 'room' && m.phase === 'racing', 0, 5000);
  assert.equal((await list())[0].phase, 'racing');
  visitor.send({ type: 'join', code: room.code });
  assert.match((await visitor.next(m => m.type === 'error' && /started/.test(m.message))).message, /started/);
  host.send({ type: 'leave' }); await host.next(m => m.type === 'closed');
  assert.deepEqual(await list(), []);
});

test('fixed input commands are acknowledged on consumption, bounded by ticks and scoped to a race', { timeout: 8000 }, async t => {
  const { connect } = await setup(t); const host = await connect();
  host.send({ type: 'create', name: 'Commands' }); await host.next(m => m.type === 'room');
  host.send({ type: 'start' });
  const racing = await host.next(m => m.type === 'snapshot' && m.phase === 'racing', 0, 5000);
  const mark = host.mark();
  host.send({ type: 'inputs', raceId: racing.raceId, commands: Array.from({ length: 8 }, (_, i) => ({ seq: i + 1, throttle: 1, steer: 0, dt: 100, x: 999999 })) });
  const consumed = await host.next(m => m.type === 'snapshot' && m.cars[0].lastInputSeq > 0, mark);
  assert.ok(consumed.cars[0].lastInputSeq <= consumed.tick - racing.tick, 'packets never fast-forward the simulation');
  assert.ok(consumed.tick > racing.tick, 'acknowledgement requires a physics step');
  await host.next(m => m.type === 'snapshot' && m.cars[0].lastInputSeq === 8, mark);
  for (const message of [
    { raceId: racing.raceId - 1, commands: [{ seq: 9, throttle: 1 }] },
    { raceId: racing.raceId, commands: [{ seq: 8, throttle: 1 }] },
    { raceId: racing.raceId, commands: [{ seq: 9, throttle: 1 }, { seq: 10, steer: 'bad' }] },
    { raceId: racing.raceId, commands: [{ seq: 9, drift: 'yes' }] },
    { raceId: racing.raceId, commands: Array.from({length: 9}, (_,i) => ({seq: 9+i})) },
  ]) {
    const invalid = host.mark(); host.send({ type: 'inputs', ...message });
    await host.next(m => m.type === 'error', invalid);
  }
  const queued = host.mark();
  host.send({ type: 'inputs', raceId: racing.raceId, commands: [{ seq: 9, throttle: 1 }, { seq: 10, throttle: 1 }] });
  host.send({ type: 'neutral', raceId: racing.raceId });
  const stopped = await host.next(m => m.type === 'snapshot' && m.cars[0].lastInputSeq === 10, queued);
  const next = await host.next(m => m.type === 'snapshot' && m.tick > stopped.tick + 6, queued);
  assert.ok(next.cars[0].speed < stopped.cars[0].speed, 'neutral barrier clears queued throttle');
});

test('all input paths reject missing or stale race generations without consuming sequence numbers', { timeout: 8000 }, async t => {
  const { connect } = await setup(t), host = await connect();
  host.send({ type: 'create', name: 'Race scope audit' }); await host.next(m => m.type === 'room');
  host.send({ type: 'start' });
  const racing = await host.next(m => m.type === 'snapshot' && m.phase === 'racing', 0, 5000);
  for (const raceId of [undefined, racing.raceId - 1, racing.raceId + 1, String(racing.raceId)]) {
    for (const type of ['input', 'inputs', 'neutral', 'launch']) {
      const mark = host.mark();
      host.send({ type, raceId, seq: 1, throttle: 1, commands: [{ seq: 1, throttle: 1 }] });
      await host.next(m => m.type === 'error' && m.message === 'Stale race input.', mark);
    }
  }
  const mark = host.mark();
  host.send({ type: 'input', raceId: racing.raceId, seq: 1, throttle: 1 });
  const moved = await host.next(m => m.type === 'snapshot' && m.cars[0].lastInputSeq === 1 && m.cars[0].speed > 0, mark);
  assert.equal(moved.cars[0].lastInputSeq, 1);
  host.send({ type: 'inputs', raceId: racing.raceId, commands: [{ seq: 2, throttle: 1 }] });
  await host.next(m => m.type === 'snapshot' && m.cars[0].lastInputSeq === 2, mark);
});

test('race spectators receive snapshots, queue ready, cannot drive, and take vacant seats after drivers leave', { timeout: 8000 }, async t => {
  const { connect } = await setup(t); const host = await connect();
  const waiting = await Promise.all(Array.from({ length: 17 }, () => connect()));
  host.send({ type: 'create', name: 'Racer' }); const created = await host.next(m => m.type === 'room');
  host.send({ type: 'start' }); await host.next(m => m.type === 'snapshot' && m.phase === 'racing', 0, 5000);
  for (const [i, observer] of waiting.slice(0, 16).entries()) {
    observer.send({ type: 'join', wait: true, code: created.code, name: `Watcher ${i}`, vehicle: 'COMET' });
    const room = await observer.next(m => m.type === 'room' || m.type === 'error');
    assert.equal(room.type, 'room', `spectator ${i + 1} must be admitted`);
    assert.equal(room.waiting.length, i + 1);
    assert.equal(room.players.length, 1);
    const snap = await observer.next(m => m.type === 'snapshot');
    assert.equal(snap.cars.length, 1); assert.equal(snap.cars[0].id, host.id);
  }
  waiting[16].send({ type: 'join', wait: true, code: created.code, name: 'Overflow' });
  assert.match((await waiting[16].next(m => m.type === 'error')).message, /queue.*full/i);
  let listMark = waiting[16].mark(); waiting[16].send({ type: 'list' });
  let listed = (await waiting[16].next(m => m.type === 'rooms', listMark)).rooms.find(r => r.code === created.code);
  assert.equal(listed.waitingCount, 16); assert.equal(listed.watchable, false);
  const observer = waiting[0], readyMark = observer.mark();
  observer.send({ type: 'ready', ready: true });
  await observer.next(m => m.type === 'room' && m.waiting[0].ready, readyMark);
  observer.send({ type: 'inputs', raceId: 1, commands: [{ seq: 1, throttle: 1 }] });
  assert.match((await observer.next(m => m.type === 'error')).message, /spectator/i);
  const launchMark = observer.mark(); observer.send({ type: 'launch', raceId: 1, pressed: true });
  assert.match((await observer.next(m => m.type === 'error', launchMark)).message, /spectator/i);
  const cancelMark = waiting[1].mark();
  waiting[1].send({ type: 'ready', ready: false });
  await waiting[1].next(m => m.type === 'room' && m.waiting.find(p => p.id === waiting[1].id)?.ready === false, cancelMark);
  observer.send({ type: 'leave' }); await observer.next(m => m.type === 'closed');
  listMark = waiting[16].mark(); waiting[16].send({ type: 'list' });
  listed = (await waiting[16].next(m => m.type === 'rooms', listMark)).rooms.find(r => r.code === created.code);
  assert.equal(listed.waitingCount, 15); assert.equal(listed.watchable, true);
  const vacancy = host.mark(); host.send({ type: 'leave' }); await host.next(m => m.type === 'closed', vacancy);
  const promoted = await waiting[1].next(m => m.type === 'room' && m.phase === 'lobby');
  assert.equal(promoted.hostId, waiting[1].id);
  assert.equal(promoted.players.length, 4); assert.equal(promoted.waiting.length, 11);
  assert.deepEqual(promoted.players.map(p => p.id), waiting.slice(1, 5).map(p => p.id));
  assert.deepEqual(promoted.waiting.map(p => p.id), waiting.slice(5, 16).map(p => p.id));
  assert.ok(promoted.players.every(player => player.vehicle === 'COMET'));
  assert.equal(promoted.players.find(player => player.id === waiting[1].id).ready, false, 'becoming host must preserve canceled readiness');
});

test('invalid vehicle choices preserve the current room and selected preset', async t => {
  const { connect } = await setup(t);
  const [host, peer] = await Promise.all([connect(), connect()]);
  host.send({ type: 'create', name: 'Host', vehicle: 'PULSE' });
  const room = await host.next(m => m.type === 'room');
  peer.send({ type: 'create', name: 'Other' });
  const other = await peer.next(m => m.type === 'room');
  for (const vehicle of ['INVALID', '__proto__', 'toString', null, 42, {}, ['PULSE']]) {
    for (const type of ['create', 'join']) {
      const mark = host.mark();
      host.send({ type, code: other.code, name: 'Changed', vehicle });
      assert.match((await host.next(m => m.type === 'error', mark)).message, /vehicle/i);
      host.send({ type: 'ready', ready: true });
      const unchanged = await host.next(m => m.type === 'room', mark);
      assert.equal(unchanged.code, room.code);
      assert.deepEqual(unchanged.players.map(({ name, vehicle }) => ({ name, vehicle })), [{ name: 'Host', vehicle: 'PULSE' }]);
    }
  }
});

test('repeated room creation, joining and leaving clears membership and directory entries', async t => {
  const { connect } = await setup(t), [host, peer, directory] = await Promise.all([connect(), connect(), connect()]);
  for (let cycle = 0; cycle < 24; cycle++) {
    const trackId = cycle % 2 ? 'technical' : 'beginner';
    let mark = host.mark(); host.send({ type: 'create', name: `Cycle ${cycle}`, vehicle: 'RALLY', trackId });
    const room = await host.next(m => m.type === 'room', mark);
    const first = await host.next(m => m.type === 'snapshot', mark);
    assert.equal(first.raceId, 0); assert.equal(first.cars[0].lastInputSeq, 0);
    mark = peer.mark(); peer.send({ type: 'join', code: room.code, vehicle: 'APEX' });
    const joined = await peer.next(m => m.type === 'room', mark);
    assert.equal(joined.players.length, 2); assert.equal(joined.trackId, trackId);
    for (const client of [host, peer]) {
      const left = client.mark(); client.send({ type: 'leave' }); await client.next(m => m.type === 'closed', left);
    }
    mark = directory.mark(); directory.send({ type: 'list' });
    assert.deepEqual((await directory.next(m => m.type === 'rooms', mark)).rooms, [], `cycle ${cycle}: leaked room`);
  }
});

test('welcome shares detected IPv4 addresses with the actual listening port', async t => {
  const { server, connect } = await setup(t);
  const client = await connect({ headers: { Host: 'attacker.invalid:1234' } });
  const welcome = await client.next(m => m.type === 'welcome');
  assert.equal(welcome.version, game.VERSION);
  const addresses = Object.values(networkInterfaces()).flat().filter(address => address?.family === 'IPv4' && !address.internal);
  assert.deepEqual([...welcome.shareOrigins].sort(), [...new Set(addresses.map(address => `http://${address.address}:${server.address().port}`))].sort());
  const local = welcome.shareOrigins.filter(origin => /^http:\/\/(192\.168\.|10\.)/.test(origin));
  assert.deepEqual(welcome.shareOrigins.slice(0, local.length), local);
});

test('a configured public origin advertises the reachable Docker address and rejects invalid origins', async t => {
  const publicOrigin = 'http://rider.example.test:43000';
  const server = await createGameServer({ port: 0, host: '127.0.0.1', publicOrigin });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { headers: { Host: 'attacker.invalid:1234' } });
  t.after(() => socket.terminate());
  const welcome = await new Promise((resolve, reject) => {
    socket.once('message', data => resolve(JSON.parse(data))); socket.once('error', reject);
  });
  assert.deepEqual(welcome.shareOrigins, [publicOrigin]);
  for (const value of ['invalid', 'file:///tmp/game', 'http://user:secret@example.test', 'http://example.test/path', 'http://example.test?x=1']) {
    await assert.rejects(createGameServer({ port: 0, publicOrigin: value }), /PUBLIC_ORIGIN/);
  }
});

test('snapshot publisher sustains 20 Hz over real WebSocket delivery', { timeout: 7000 }, async t => {
  const { connect } = await setup(t);
  const client = await connect();
  const times = [];
  let skip = 2; // Ignore the immediate join snapshot and its first partial interval.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out sampling snapshot cadence')), 6000);
    client.socket.on('message', data => {
      if (JSON.parse(data).type !== 'snapshot') return;
      if (skip > 0) { skip--; return; }
      times.push(performance.now());
      if (times.at(-1) - times[0] >= 3000) { clearTimeout(timer); resolve(); }
    });
    client.send({ type: 'create', name: 'Cadence' });
  });
  const meanInterval = (times.at(-1) - times[0]) / (times.length - 1);
  const hz = 1000 / meanInterval;
  t.diagnostic(`${times.length} snapshots; mean ${meanInterval.toFixed(2)} ms; ${hz.toFixed(2)} Hz`);
  assert.ok(hz >= 18.5 && hz <= 21.5, `Expected approximately 20 Hz, received ${hz.toFixed(2)} Hz`);
});

test('static HTTP routes serve only allowed files with MIME and shutdown closes sockets', async t => {
  const { server, url, connect } = await setup(t);
  for (const [path, mime] of [['/9EAB55', 'text/html'], ['/9eab55/', 'text/html'], ['/?room=9EAB55', 'text/html'], ['/shared/game.js', 'javascript'], ['/shared/music.js', 'javascript'], ['/session.js', 'javascript'], ['/netcode.js', 'javascript'], ['/vendor/three/build/three.module.js', 'javascript']]) {
    const response = await fetch(url + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), new RegExp(mime));
    assert.ok((await response.text()).length > 100);
  }
  assert.deepEqual(await (await fetch(url + '/healthz')).json(), { ok: true });
  for (const path of ['/9EAB55/extra', '/invalid', '/ABC1234', '/package.json', '/shared/../package.json', '/assets/%2e%2e/%2e%2e/package.json', '/vendor/three/%2e%2e/ws/package.json', '/assets/..%5c..%5cpackage.json', '/%zz']) {
    const status = await new Promise((resolve, reject) => {
      http.get(url, { path }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.ok(status >= 400 && status < 500, `${path} must be denied, got ${status}`);
  }
  const client = await connect();
  const closed = new Promise(resolve => client.socket.once('close', resolve));
  await new Promise(resolve => server.close(resolve));
  await closed;
  // setup's cleanup is safe even after an explicit shutdown.
});
