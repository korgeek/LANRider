import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, TRACK, TRACKS, createCar, sampleTrack, stepCar, resolveCollisions, updateProgress } from '../shared/game.js';
import * as netcode from '../public/netcode.js';
import { boxesOverlap } from './collision-helpers.js';

const state = (car, tick = 60, raceId = 1) => ({ type: 'snapshot', tick, raceId, phase: 'racing', cars: [{ ...car }] });
const advance = (car, input) => { stepCar(car, input); resolveCollisions([car]); };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('prediction moves before replies and reconciliation replays only unacknowledged commands', () => {
  const prediction = new netcode.LocalPrediction();
  const base = createCar('me'), expected = { ...base }, acknowledged = { ...base };
  prediction.receive(state(base), 'me');
  for (let i = 0; i < 12; i++) {
    const input = { throttle: 1, steer: i > 6 ? .3 : 0 };
    prediction.step(input); advance(expected, input);
    if (i < 5) advance(acknowledged, input);
  }
  assert.ok(prediction.car.speed > 3, 'local movement needs no server round trip');
  assert.equal(prediction.pending.length, 12);
  const batch = prediction.drain();
  assert.equal(batch.length, 8, 'batch stays below payload limit');
  assert.deepEqual(batch.map(command => command.seq), [1,2,3,4,5,6,7,8]);
  acknowledged.lastInputSeq = 5;
  prediction.receive(state(acknowledged, 65), 'me');
  assert.equal(prediction.pending.length, 7);
  close(prediction.car.x, expected.x); close(prediction.car.z, expected.z);
  close(prediction.car.vx, expected.vx); close(prediction.car.yaw, expected.yaw);
  assert.equal(base.speed, 0, 'authoritative snapshot is never mutated');
});

test('boost is not spent twice on replay, history is bounded and race changes clear it', () => {
  const prediction = new netcode.LocalPrediction();
  const car = createCar('me'); car.charge = 100;
  prediction.receive(state(car), 'me');
  const command = prediction.step({ throttle: 1, boost: true });
  advance(car, command); car.lastInputSeq = command.seq;
  prediction.step({ throttle: 1, boost: true });
  prediction.receive(state(car, 61), 'me');
  assert.equal(prediction.car.charge, 65);
  for (let i = 0; i < 200; i++) prediction.step({ throttle: 1 });
  assert.equal(prediction.pending.length, 120);
  close(prediction.visual(0, 0).x, prediction.visual(0, 1).x);
  close(prediction.visual(0, 0).z, prediction.visual(0, 1).z);
  prediction.receive(state(createCar('me'), 62, 2), 'me');
  assert.equal(prediction.pending.length, 0); assert.deepEqual(prediction.drain(), []);
  assert.equal(prediction.step({}).seq, 1);
  prediction.neutral();
  assert.equal(prediction.pending.length, 0); assert.deepEqual(prediction.drain(), []);
});

test('crossing a checkpoint then resetting before ACK uses the predicted checkpoint', () => {
  for (const track of Object.values(TRACKS)) {
    const prediction = new netcode.LocalPrediction(), car = createCar('me', 0, 'PULSE', track.id);
    const distance = track.length / 12 - .2;
    Object.assign(car, sampleTrack(distance, 0, track), { routeDistance: distance, routeProgress: distance, progress: distance });
    car.vx = Math.sin(car.yaw) * 40; car.vz = -Math.cos(car.yaw) * 40;
    prediction.receive(state(car), 'me');
    prediction.step({ throttle: 1 }); advance(car, { throttle: 1 }); updateProgress(car);
    assert.equal(car.checkpoint, 1);
    prediction.step({ reset: true });
    const acknowledged = { ...car, lastInputSeq: 1 };
    advance(car, { reset: true }); updateProgress(car);
    close(prediction.car.x, car.x); close(prediction.car.z, car.z);
    prediction.receive(state(acknowledged, 61), 'me');
    close(prediction.car.x, car.x); close(prediction.car.z, car.z);
    assert.equal(prediction.car.resetId, car.resetId);
  }
});

test('correction changes physical state immediately but smooths only the rendered pose', () => {
  const prediction = new netcode.LocalPrediction(), car = createCar('me');
  prediction.receive(state(car), 'me');
  const oldX = prediction.car.x;
  car.x += 1;
  prediction.receive(state(car, 63), 'me');
  close(prediction.car.x, car.x);
  close(prediction.visual(0).x, oldX);
  assert.ok(Math.abs(prediction.visual(.5).x - car.x) < .01);
  car.resetId = 1; car.x += 2;
  prediction.receive(state(car, 66), 'me');
  close(prediction.visual(0).x, car.x);
  car.finished = true; car.speed = car.vx = car.vz = 0;
  prediction.receive(state(car, 69), 'me');
  assert.equal(prediction.step({ throttle: 1 }), null);
});

test('predicted finish line crossing updates progress but waits for server finish confirmation', () => {
  const prediction = new netcode.LocalPrediction(), car = createCar('me');
  const distance = TRACK.length * 3 - .2;
  Object.assign(car, sampleTrack(distance), { lap: 2, checkpoint: 35, routeDistance: TRACK.length - .2,
    routeProgress: distance, progress: distance, respawnDistance: TRACK.length * 35 / 12 - 3 });
  car.vx = Math.sin(car.yaw) * 40; car.vz = -Math.cos(car.yaw) * 40;
  prediction.receive(state(car), 'me'); prediction.step({ throttle: 1 });
  assert.equal(prediction.car.checkpoint, 36);
  assert.equal(prediction.car.finished, false);
  assert.notEqual(prediction.step({ throttle: 1 }), null);
  const confirmed = { ...prediction.car, finished: true, vx: 0, vz: 0, speed: 0, lastInputSeq: 2 };
  prediction.receive(state(confirmed, 63), 'me');
  assert.equal(prediction.step({ throttle: 1 }), null);
});

test('finishers and DNF results coast at the render clock without sending more inputs', () => {
  for (const [phase, finished] of [['racing', true], ['finished', true], ['finished', false]]) {
    const prediction = new netcode.LocalPrediction();
    const car = Object.assign(createCar('me'), sampleTrack(25), { finished, finishTime: finished ? 60 : null });
    car.vx = Math.sin(car.yaw) * 35; car.vz = -Math.cos(car.yaw) * 35;
    prediction.receive({ ...state(car), phase }, 'me');
    prediction.advance(0, null); prediction.advance(100, { throttle: 1, boost: true, reset: true });
    assert.ok(Math.hypot(prediction.car.x - car.x, prediction.car.z - car.z) > 2);
    assert.ok(prediction.car.speed > 30 && prediction.car.speed < 35);
    assert.equal(prediction.pending.length, 0); assert.deepEqual(prediction.drain(), []);
    assert.equal(prediction.car.finished, finished); assert.equal(prediction.car.finishTime, car.finishTime);
    assert.equal(prediction.step({ throttle: 1 }), null);
  }
});

test('results snapshots retain interpolation while finished cars coast', () => {
  const buffer = new netcode.SnapshotBuffer(), car = { ...createCar('peer'), finished: true, x: 0 };
  buffer.push({ ...state(car, 60), phase: 'finished', stateTime: 1000, serverNow: 1000 }, 1000);
  buffer.push({ ...state({ ...car, x: 3 }, 63), phase: 'finished', stateTime: 1050, serverNow: 1050 }, 1050);
  close(buffer.sample(1125)[0].x, 1.5);
});

test('snapshot buffer uses server time despite jitter, rejects stale ticks and never runs away during silence', () => {
  const buffer = new netcode.SnapshotBuffer();
  const car = createCar('peer'); car.x = 0;
  buffer.push(state(car, 60), 1100);
  car.x = 3; buffer.push(state(car, 63), 1160);
  car.x = 6; buffer.push(state(car, 66), 1210);
  close(buffer.sample(1275)[0].x, 4.5);
  close(buffer.sample(1280)[0].x, 4.8);
  assert.equal(buffer.push(state({ ...car, x: -100 }, 63), 1290), false);
  close(buffer.sample(1500)[0].x, 6);
  close(buffer.sample(1490)[0].x, 6, 'playback cannot reverse');
  for (let i = 67; i < 200; i++) buffer.push(state(car, i), i * STEP * 1000 + 100);
  assert.equal(buffer.frames.length, 32);
});

test('nearby cars render on the collision prediction timeline while distant cars and spectators keep interpolation', () => {
  const prediction = new netcode.LocalPrediction(), buffer = new netcode.SnapshotBuffer();
  const at = (id, distance) => {
    const car = Object.assign(createCar(id), sampleTrack(distance));
    return Object.assign(car, { vx: Math.sin(car.yaw) * 30, vz: -Math.cos(car.yaw) * 30, speed: 30 });
  };
  const snapshot = (time, cars) => ({ raceId: 1, phase: 'racing', tick: Math.round(time / (STEP * 1000)),
    serverNow: time, stateTime: time, cars });
  buffer.push(snapshot(1000, [at('me', 22), at('near', 25.5), at('far', 77)]), 1000);
  const latest = snapshot(1100, [at('me', 25), at('near', 28.5), at('far', 80)]);
  buffer.push(latest, 1100); prediction.receive(latest, 'me'); prediction.step({ throttle: 1 });
  const now = 1100 + STEP * 1000, delayed = buffer.sample(now);
  assert.equal(boxesOverlap(prediction.car, delayed.find(car => car.id === 'near')), true, 'reproduces overlap with zero network delay');
  const physical = JSON.stringify([prediction.car, ...prediction.others]);
  for (const alpha of [0, .4, 1]) {
    const own = prediction.visual(0, alpha), shown = buffer.sample(now, prediction, alpha);
    assert.equal(boxesOverlap(own, shown.find(car => car.id === 'near')), false, 'the displayed bumper gap agrees with collision prediction');
    assert.deepEqual(shown.find(car => car.id === 'far'), delayed.find(car => car.id === 'far'));
  }
  assert.equal(JSON.stringify([prediction.car, ...prediction.others]), physical, 'rendering never changes physics');
  assert.deepEqual(buffer.sample(now, new netcode.LocalPrediction()), delayed, 'spectators keep buffered playback');
  prediction.car.finished = true;
  assert.deepEqual(buffer.sample(now, prediction), delayed, 'finished drivers keep buffered playback');
});

test('nearby rendering shows the predicted rebound of both cars before the next server snapshot', () => {
  const prediction = new netcode.LocalPrediction(), buffer = new netcode.SnapshotBuffer();
  const a = Object.assign(createCar('me'), sampleTrack(25, -.75));
  const b = Object.assign(createCar('peer', 1), sampleTrack(28.4, .75));
  b.yaw += Math.PI;
  for (const car of [a, b]) Object.assign(car, { vx: Math.sin(car.yaw) * 60, vz: -Math.cos(car.yaw) * 60, boostTime: 1 });
  const snapshot = { ...state(a), serverNow: 1000, stateTime: 1000, cars: [a, b] };
  buffer.push(snapshot, 1000); prediction.receive(snapshot, 'me');
  for (let i = 1; i <= 4; i++) {
    prediction.step({});
    const peer = buffer.sample(1000 + i * STEP * 1000, prediction)[1];
    assert.ok(prediction.car.collisionTime > 0 && peer.collisionTime > 0, 'both cars show the impact immediately');
    assert.ok(prediction.car.speed < 0 && peer.speed < 0, 'both cars show their rebound velocity');
    assert.equal(boxesOverlap(prediction.car, peer), false);
    close(peer.x, prediction.others[0].x); close(peer.z, prediction.others[0].z);
  }
});

test('nearby rendering preserves substep motion across ACKs and shares local correction without sliding through resets', () => {
  const prediction = new netcode.LocalPrediction(), buffer = new netcode.SnapshotBuffer();
  const a = Object.assign(createCar('me'), sampleTrack(25));
  const b = Object.assign(createCar('peer', 1), sampleTrack(28.5));
  for (const car of [a, b]) Object.assign(car, { vx: Math.sin(car.yaw) * 30, vz: -Math.cos(car.yaw) * 30 });
  const snapshot = (cars, tick) => ({ ...state(a, tick), serverNow: tick * STEP * 1000, stateTime: tick * STEP * 1000, cars });
  const receive = message => { buffer.push(message, message.serverNow); prediction.receive(message, 'me', .4); };
  receive(snapshot([a, b], 60)); prediction.step({ throttle: 1 });
  const poses = [0, .4, 1].map(alpha => buffer.sample(1000, prediction, alpha)[1]);
  receive(snapshot([{ ...prediction.car, lastInputSeq: 1 }, { ...prediction.others[0] }], 61));
  for (const [i, alpha] of [0, .4, 1].entries()) {
    const peer = buffer.sample(1020, prediction, alpha)[1];
    close(peer.x, poses[i].x); close(peer.z, poses[i].z);
  }
  const corrected = [prediction.car, ...prediction.others].map(car => ({ ...car, x: car.x + .7, z: car.z + .2, yaw: car.yaw + .2 }));
  receive(snapshot(corrected, 62));
  const own = prediction.visual(0), peer = buffer.sample(1040, prediction)[1], physicalPeer = prediction.others[0];
  close(Math.hypot(peer.x - own.x, peer.z - own.z), Math.hypot(physicalPeer.x - prediction.car.x, physicalPeer.z - prediction.car.z));
  close(Math.atan2(Math.sin(peer.yaw - own.yaw), Math.cos(peer.yaw - own.yaw)),
    Math.atan2(Math.sin(physicalPeer.yaw - prediction.car.yaw), Math.cos(physicalPeer.yaw - prediction.car.yaw)));
  receive(snapshot([{ ...prediction.car }, { ...physicalPeer, x: prediction.car.x + 4, resetId: 1 }], 63));
  const start = buffer.sample(1050, prediction, 0)[1], end = buffer.sample(1050, prediction, 1)[1];
  assert.equal(start.resetId, 1); assert.equal(end.resetId, 1);
  assert.ok(Math.hypot(start.x - end.x, start.z - end.z) < .15, 'substep motion never sweeps across the reset jump');
  receive(snapshot([{ ...prediction.car }], 64));
  assert.equal(buffer.sample(1070, prediction).length, 1, 'departed peers disappear immediately');
});

test('the transition range never blends a peer across reset, finish or large-jump discontinuities', () => {
  for (const [distance, change] of [[13, { resetId: 1 }], [38, { finished: true }], [13, {}]]) {
    const prediction = new netcode.LocalPrediction(), buffer = new netcode.SnapshotBuffer();
    const own = Object.assign(createCar('me'), sampleTrack(25));
    const before = Object.assign(createCar('peer', 1), sampleTrack(37));
    const after = Object.assign({ ...before }, sampleTrack(distance), change);
    const snapshot = (peer, tick) => ({ ...state(own, tick), cars: [own, peer] });
    buffer.push(snapshot(before, 60), 1000);
    const latest = snapshot(after, 63); buffer.push(latest, 1050); prediction.receive(latest, 'me');
    const shown = buffer.sample(1050, prediction)[1];
    assert.equal(boxesOverlap(prediction.car, shown), false, 'a teleport cannot create a ghost car between endpoints');
    close(shown.x, after.x); close(shown.z, after.z);
  }
});

test('resetting into another car snaps the entire resolved collision world, including replay', () => {
  for (const replay of [false, true]) {
    const prediction = new netcode.LocalPrediction(), buffer = new netcode.SnapshotBuffer();
    const own = Object.assign(createCar('me'), sampleTrack(25), { respawnDistance: 0 });
    const peer = Object.assign(createCar('peer', 1), sampleTrack(.5));
    const snapshot = { ...state(own), cars: [own, peer] };
    buffer.push(snapshot, 1000); prediction.receive(snapshot, 'me'); prediction.step({ reset: true });
    if (replay) prediction.receive({ ...snapshot, tick: 63 }, 'me');
    assert.equal(boxesOverlap(prediction.car, prediction.others[0]), false);
    for (const alpha of [0, .4, 1]) {
      const own = prediction.visual(0, alpha), shown = buffer.sample(1050, prediction, alpha)[1];
      assert.equal(boxesOverlap(own, shown), false, 'displayed reset matches the resolved collision world');
    }
  }
});

test('local rendering interpolates completed steps at 144 Hz without changing physics', () => {
  const prediction = new netcode.LocalPrediction(), car = createCar('me');
  prediction.receive(state(car), 'me');
  prediction.step({ throttle: 1 });
  const physical = { ...prediction.car };
  for (const alpha of [0, 60 / 144, 120 / 144, 1]) {
    const shown = prediction.visual(0, alpha);
    close(shown.x, car.x + (physical.x - car.x) * alpha);
    close(shown.z, car.z + (physical.z - car.z) * alpha);
    assert.deepEqual(prediction.car, physical);
  }
  const shown = prediction.visual(0, .4);
  const corrected = { ...physical, x: physical.x + .2, lastInputSeq: 1 };
  prediction.receive(state(corrected, 63), 'me', .4);
  close(prediction.visual(0, .4).x, shown.x);
  close(prediction.visual(0, .4).z, shown.z);
  close(prediction.car.x, corrected.x);
  const correctedRenderX = corrected.x - (physical.x - car.x) * .6;
  assert.ok(Math.abs(prediction.visual(.7, .4).x - correctedRenderX) < .001);
});

test('local interpolation keeps the replayed final interval and snaps on respawn', () => {
  const prediction = new netcode.LocalPrediction(), car = createCar('me');
  prediction.receive(state(car), 'me');
  prediction.step({ throttle: 1 }); advance(car, { throttle: 1 });
  const acknowledged = { ...car, lastInputSeq: 1 };
  prediction.step({ throttle: 1 });
  prediction.receive(state(acknowledged, 61), 'me', .5);
  close(prediction.visual(0, 0).x, acknowledged.x);
  close(prediction.visual(0, 0).z, acknowledged.z);
  prediction.step({ reset: true });
  for (const alpha of [0, .5, 1]) {
    close(prediction.visual(0, alpha).x, prediction.car.x);
    close(prediction.visual(0, alpha).z, prediction.car.z);
  }
});

test('an exact ACK preserves the whole render interval even when no commands remain', () => {
  const prediction = new netcode.LocalPrediction(), car = createCar('me');
  prediction.receive(state(car), 'me'); prediction.step({ throttle: 1 });
  const poses = [0, .4, .8, 1].map(alpha => prediction.visual(0, alpha));
  prediction.receive(state({ ...prediction.car, lastInputSeq: 1 }, 63), 'me', .4);
  for (const [i, alpha] of [0, .4, .8, 1].entries()) {
    close(prediction.visual(0, alpha).x, poses[i].x);
    close(prediction.visual(0, alpha).z, poses[i].z);
  }
});

test('hard correction distance compares completed physics, excluding render interpolation lag', () => {
  const prediction = new netcode.LocalPrediction(), car = createCar('me');
  car.vx = Math.sin(car.yaw) * 30; car.vz = -Math.cos(car.yaw) * 30;
  prediction.receive(state(car), 'me'); prediction.step({ throttle: 1 });
  const shown = prediction.visual(0, 0), corrected = { ...prediction.car, lastInputSeq: 1 };
  const dx = corrected.x - car.x, dz = corrected.z - car.z, length = Math.hypot(dx, dz);
  corrected.x += dx / length * 4.8; corrected.z += dz / length * 4.8;
  prediction.receive(state(corrected, 63), 'me', 0);
  close(prediction.car.x, corrected.x); close(prediction.car.z, corrected.z);
  close(prediction.visual(0, 0).x, shown.x); close(prediction.visual(0, 0).z, shown.z);
});

test('remote interpolation follows completed stateTime rather than packet time or tick duration', () => {
  const buffer = new netcode.SnapshotBuffer(), car = createCar('peer');
  for (const [tick, stateTime, x] of [[60, 5000, 0], [63, 5050, 3], [66, 5250, 6]]) {
    buffer.push({ ...state({ ...car, x }, tick), stateTime, serverNow: stateTime + 12 }, stateTime + 112);
  }
  close(buffer.sample(5375)[0].x, 4.875);
  close(buffer.sample(6000)[0].x, 6, 'missing data freezes instead of unlimited extrapolation');
});

test('8 ms timer and 60/120/144 Hz rendering share one monotonic fixed-step clock', () => {
  for (const hz of [60, 120, 144]) {
    const prediction = new netcode.LocalPrediction(), car = createCar('me'), input = { throttle: 1 };
    prediction.receive(state(car), 'me');
    const reference = [{ ...car }];
    for (let i = 0; i < 65; i++) { advance(car, input); updateProgress(car); reference.push({ ...car }); }
    prediction.advance(0, input);
    const events = [];
    for (let now = 8; now < 1000; now += 8) events.push({ now, render: false });
    for (let i = 0; i < hz; i++) events.push({ now: i * 1000 / hz + .4, render: true });
    events.sort((a, b) => a.now - b.now);
    for (const { now, render } of events) {
      prediction.advance(now, input);
      if (!render) continue;
      const steps = Math.floor(now / (STEP * 1000)), alpha = now / (STEP * 1000) - steps;
      assert.equal(prediction.seq, steps, `${hz} Hz at ${now} ms: rendering must see all due physics steps`);
      assert.ok(prediction.alpha >= 0 && prediction.alpha < 1, 'no clamped/extrapolated render interval');
      const from = reference[Math.max(0, steps - 1)], to = reference[steps];
      const shown = prediction.visual(0, prediction.alpha);
      close(shown.x, from.x + (to.x - from.x) * alpha);
      close(shown.z, from.z + (to.z - from.z) * alpha);
    }
    const seq = prediction.seq;
    prediction.advance(events.at(-1).now - 5, input);
    prediction.advance(events.at(-1).now, input);
    assert.equal(prediction.seq, seq, 'an older RAF timestamp cannot count elapsed time twice');
  }
});

test('snapshot interpolation wraps angles and treats resets, finished cars and departures as discontinuities', () => {
  const buffer = new netcode.SnapshotBuffer();
  const car = createCar('peer'); car.yaw = Math.PI - .1; car.x = 0;
  buffer.push(state(car, 60), 1100);
  car.yaw = -Math.PI + .1; car.x = 3;
  buffer.push(state(car, 63), 1150);
  assert.ok(Math.abs(Math.abs(buffer.sample(1225)[0].yaw) - Math.PI) < 1e-8);
  car.resetId = 1; car.x = 30;
  buffer.push(state(car, 66), 1200);
  close(buffer.sample(1275)[0].x, 3, 'do not slide through a reset');
  close(buffer.sample(1300)[0].x, 30);
  buffer.push({ ...state(car, 69), cars: [] }, 1250);
  assert.deepEqual(buffer.sample(1325), []);
  buffer.push(state(car, 1, 2), 1300);
  assert.equal(buffer.frames.length, 1);
});
