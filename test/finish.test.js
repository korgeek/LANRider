import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as game from '../shared/game.js';

async function race(finished) {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const timer = source.slice(source.indexOf('  const timer = setInterval('), source.indexOf('  const heartbeat = setInterval('));
  assert(timer.includes('resolveCollisions(cars)'));
  const players = new Map(finished.map((done, slot) => {
    const car = Object.assign(game.createCar(String(slot), slot), game.sampleTrack(25, slot ? 3 : -3), { finished: done });
    car.vx = Math.sin(car.yaw) * 30; car.vz = -Math.cos(car.yaw) * 30;
    return [car.id, { id: car.id, name: car.id, car, input: {}, inputAt: 0, lastSeq: 0, ready: true }];
  }));
  const room = { players, waiting: new Map(), phase: 'racing', tick: 0, raceStart: 0, raceEnd: null,
    firstFinish: null, finishers: [], completedCars: null, hostId: '0', readyEnd: null };
  let now = 0, callback;
  const context = { ...game, room, rooms: new Map([['room', room]]), last: 0, accumulator: 0, lastSnapshot: 0,
    performance: { now: () => now }, setInterval: fn => { callback = fn; }, updateAutoStart() {}, broadcastRoom() {}, snapshot() {},
    promoteWaiting: target => { for (const player of target.players.values()) player.car = game.createCar(player.id); } };
  runInNewContext(timer, context);
  return { room, source, tick: time => { now = time; callback(); } };
}

test('solo and all-finished races enter results immediately, remaining drivers keep their deadline', async () => {
  for (const finished of [[true], [true, true]]) {
    const { room, tick } = await race(finished); tick(20);
    assert.equal(room.phase, 'finished'); assert.equal(room.finishers.length, finished.length);
    assert.ok(room.raceEnd < 30, 'no ten-second delay after the last finisher');
  }
  const last = await race([true, false]); last.tick(20); assert.equal(last.room.phase, 'racing');
  last.room.players.get('1').car.finished = true; last.tick(40); assert.equal(last.room.phase, 'finished');
  const timeout = await race([true, false]); timeout.tick(20);
  for (let time = 40; time < 10000; time += 20) timeout.tick(time);
  assert.equal(timeout.room.phase, 'racing'); timeout.tick(10040); assert.equal(timeout.room.phase, 'finished');
  assert.equal(timeout.room.completedCars.find(car => car.id === '1').finished, false, 'timeout remains DNF');
});

test('crossing the final checkpoint ends a solo race without discarding finish-line velocity', async () => {
  const { room, tick } = await race([false]), car = room.players.get('0').car;
  const distance = game.TRACK.length * game.LAPS - .05;
  Object.assign(car, game.sampleTrack(distance), { lap: game.LAPS - 1, checkpoint: game.LAPS * game.PHYSICS.checkpoints - 1,
    routeDistance: game.TRACK.length - .05, routeProgress: distance, progress: distance });
  car.vx = Math.sin(car.yaw) * 30; car.vz = -Math.cos(car.yaw) * 30;
  tick(20);
  assert.equal(room.phase, 'finished'); assert.equal(room.finishers.length, 1);
  const completed = room.completedCars[0], before = { ...completed };
  assert.ok(completed.speed > 29); assert.equal(completed.lap, game.LAPS);
  tick(40);
  assert.ok(Math.hypot(completed.x - before.x, completed.z - before.z) > .4);
  assert.equal(completed.finishTime, before.finishTime); assert.equal(completed.progress, before.progress);
});

test('results cars coast independently from the next grid and retain their final records', async () => {
  const { room, tick, source } = await race([true]); tick(20);
  assert.equal(room.phase, 'finished');
  const car = room.completedCars[0], before = { ...car }, nextGrid = { ...room.players.get('0').car };
  tick(40);
  assert.ok(Math.hypot(car.x - before.x, car.z - before.z) > .4);
  assert.ok(car.speed > 0 && car.speed < before.speed);
  assert.equal(car.finishTime, before.finishTime); assert.equal(car.progress, before.progress); assert.equal(car.finished, true);
  assert.deepEqual(room.players.get('0').car, nextGrid);
  const messages = [], snapshot = source.match(/function snapshot\(room, now\) \{[\s\S]+?(?=\n  function )/)[0];
  const context = { room, performance: { now: () => 100 }, members: target => [...target.players.values()], send: (_, message) => messages.push(message) };
  runInNewContext(`${snapshot}\nsnapshot(room, 100);`, context);
  assert.equal(messages[0].stateTime, room.stateTime, 'motion timestamps keep advancing after results');
  assert.equal(messages[0].raceTime, room.raceEnd / 1000, 'race time stays frozen');
  assert.equal(messages[0].finishRemaining, 0);
});
