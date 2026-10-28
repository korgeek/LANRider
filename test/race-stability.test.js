import test from 'node:test';
import assert from 'node:assert/strict';
import { boxesOverlap } from './collision-helpers.js';
import { STEP, LAPS, PHYSICS, TRACKS, VEHICLES, createCar, sampleTrack, nearestTrack,
  stepCar, resolveCollisions, updateProgress } from '../shared/game.js';

function invariant(car, track, context) {
  for (const [key, value] of Object.entries(car)) if (typeof value === 'number') assert.ok(Number.isFinite(value), `${context}: ${key}`);
  assert.ok(car.charge >= 0 && car.charge <= 100, `${context}: charge`);
  assert.ok(car.lap >= 0 && car.lap <= LAPS, `${context}: lap`);
  assert.ok(Math.abs(nearestTrack(car.x, car.z, track).offset) <= track.width / 2 - PHYSICS.radius + .002, `${context}: road`);
}

test('all eight presets complete three physical laps on both courses without reset', t => {
  for (const track of Object.values(TRACKS)) for (const vehicle of Object.keys(VEHICLES)) {
    const car = createCar(vehicle, 0, vehicle, track.id);
    let tick = 0;
    for (; !car.finished && tick < 600 / STEP; tick++) {
      const road = nearestTrack(car.x, car.z, track);
      const target = sampleTrack(road.distance + Math.max(8, Math.abs(car.speed) * .55), 0, track);
      const yaw = Math.atan2(target.x - car.x, -(target.z - car.z));
      const turn = Math.atan2(Math.sin(yaw - car.yaw), Math.cos(yaw - car.yaw));
      stepCar(car, { throttle: Math.abs(turn) > .6 ? .55 : 1, steer: Math.max(-1, Math.min(1, turn * 2.5)) });
      resolveCollisions([car]); updateProgress(car);
      if (tick % 60 === 0) invariant(car, track, `${track.id}/${vehicle}/${tick}`);
    }
    assert.equal(car.finished, true, `${track.id}/${vehicle}: route ${car.routeProgress}`);
    assert.equal(car.lap, LAPS); assert.equal(car.checkpoint, LAPS * PHYSICS.checkpoints); assert.equal(car.resetId, 0);
    t.diagnostic(`${track.id}/${vehicle}: ${(tick * STEP).toFixed(2)} simulated seconds, three laps`);
  }
});

test('seeded four-car contact, drift, boost and reset stress stays finite and within each road', t => {
  let contacts = 0, resets = 0, driftTicks = 0, boostTicks = 0, frames = 0;
  const vehicles = Object.keys(VEHICLES);
  for (const track of Object.values(TRACKS)) for (let grid = 0; grid < 2; grid++) {
    let seed = 0x517a + grid;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const cars = vehicles.slice(grid * 4, grid * 4 + 4).map((vehicle, slot) => createCar(String(slot), slot, vehicle, track.id));
    let inputs = cars.map(() => ({}));
    for (let tick = 0; tick < 3600; tick++) {
      if (tick % 30 === 0) inputs = cars.map(() => ({ throttle: random() < .15 ? -1 : 1, steer: random() * 2 - 1,
        drift: random() < .5, boost: random() < .35 }));
      for (const [i, car] of cars.entries()) {
        const reset = tick > 0 && tick % 601 === i;
        const checkpoint = car.checkpoint, beforeReset = car.resetId;
        stepCar(car, { ...inputs[i], reset });
        if (reset) { assert.equal(car.checkpoint, checkpoint); assert.equal(car.resetId, beforeReset + 1); resets++; }
      }
      resolveCollisions(cars);
      for (const car of cars) {
        updateProgress(car); invariant(car, track, `${track.id}/${grid}/${tick}/${car.id}`);
        if (car.collisionTime > 0) contacts++;
        if (car.drifting) driftTicks++;
        if (car.boostTime > 0) boostTicks++;
      }
      for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
        assert.ok(!boxesOverlap(cars[i], cars[j]),
          `${track.id}/${grid}/${tick}: overlap ${i}/${j}`);
      }
      frames++;
    }
  }
  assert.ok(contacts > 0 && resets > 0 && driftTicks > 0 && boostTicks > 0, 'stress exercises every advertised action');
  t.diagnostic(JSON.stringify({ frames, carSteps: frames * 4, collisionRecoveryCarTicks: contacts, resets, driftTicks, boostTicks }));
});
