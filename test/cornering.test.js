import test from 'node:test';
import assert from 'node:assert/strict';
import { PHYSICS, VEHICLES, STEP, createCar, sampleTrack, stepCar } from '../shared/game.js';
import { corneringProbe } from '../tools/qa/cornering-balance.mjs';

const origin = sampleTrack(25);
const magnitude = car => Math.hypot(car.vx, car.vz);
const delta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
function make(vehicle, speed) {
  const car = createCar('tyre', 0, vehicle);
  return Object.assign(car, origin, { vx: Math.sin(origin.yaw) * speed, vz: -Math.cos(origin.yaw) * speed, speed });
}

test('steering tyre impulses dissipate energy and obey their lateral force budget', () => {
  // Remove propulsion/air drag so neither can mask energy created by rotating the body.
  VEHICLES.ENERGY_CHECK = { ...VEHICLES.PULSE, dragScale: 0 };
  try {
    const car = make('ENERGY_CHECK', 45);
    for (let tick = 0; tick < 180; tick++) {
      car.x = origin.x; car.z = origin.z;
      const before = { ...car }, speed = magnitude(car);
      stepCar(car, { steer: tick < 90 ? 1 : -1 });
      assert.ok(magnitude(car) <= speed + 1e-9, 'steering without power cannot add kinetic energy');
      assert.ok(Math.hypot(car.vx - before.vx, car.vz - before.vz) <= PHYSICS.lateralAcceleration * STEP + 1e-9,
        'tyres cannot change velocity beyond their finite force budget');
      assert.ok(Math.abs(delta(before.yaw, car.yaw)) <= PHYSICS.lateralAcceleration / speed * STEP + 1e-9,
        'body turning uses total velocity, including sideways motion');
    }
  } finally { delete VEHICLES.ENERGY_CHECK; }
});

test('all vehicles keep small steering light and lose only modest speed during sustained high-speed cornering', () => {
  for (const id of Object.keys(VEHICLES)) {
    const straight = corneringProbe(id, 0), small = corneringProbe(id, .15), full = corneringProbe(id, 1);
    const loss = 1 - full.kmh / straight.kmh;
    assert.ok(Math.abs(1 - small.kmh / straight.kmh) < .008, `${id}: small steering loses less than 0.8%`);
    assert.ok(loss > .005 && loss < .09, `${id}: full steering loses 0.5–9%, got ${(loss * 100).toFixed(2)}%`);
    assert.ok(full.peakSlip > .1 && full.peakSlip < 4, `${id}: outward slip remains controllable`);
    assert.ok(full.vx * Math.cos(full.yaw) + full.vz * Math.sin(full.yaw) < -.1, `${id}: slip points outside the turn`);
    const idealRadius = VEHICLES[id].maxSpeed / VEHICLES[id].turnRate;
    assert.ok(full.radius > idealRadius * 1.08, `${id}: high-speed grip limits widen the turn`);
    const weave = corneringProbe(id, time => Math.floor(time / .25) % 2 ? -1 : 1);
    assert.ok(weave.kmh < straight.kmh - .5 && weave.kmh > straight.kmh * .88, `${id}: weaving has a mild speed cost`);
  }
});

test('acceleration and lateral tyre forces share one traction budget during countersteering', () => {
  try {
    for (const [id, stats] of Object.entries(VEHICLES)) {
      if (id === 'TRACTION_CHECK') continue;
      VEHICLES.TRACTION_CHECK = { ...stats, dragScale: 0 };
      const car = make('TRACTION_CHECK', stats.maxSpeed * .9);
      car.vx += Math.cos(car.yaw) * 8; car.vz += Math.sin(car.yaw) * 8;
      for (let tick = 0; tick < 60; tick++) {
        car.x = origin.x; car.z = origin.z;
        const before = { ...car };
        stepCar(car, { throttle: 1, steer: tick < 30 ? 1 : -1 });
        const acceleration = Math.hypot(car.vx - before.vx, car.vz - before.vz) / STEP;
        const traction = stats.lateralAcceleration * Math.sqrt(stats.grip / PHYSICS.grip);
        assert.ok(acceleration <= traction + 1e-8, `${id}: combined tyre acceleration ${acceleration} exceeds ${traction}`);
      }
    }
  } finally { delete VEHICLES.TRACTION_CHECK; }
});

test('cornering is symmetric, stable across timesteps and reverses steering direction in reverse', () => {
  const right = corneringProbe('PULSE', .8), left = corneringProbe('PULSE', -.8);
  assert.ok(Math.abs(right.kmh - left.kmh) < .01);
  assert.ok(Math.abs(delta(origin.yaw, right.yaw) + delta(origin.yaw, left.yaw)) < 1e-8);
  const finer = corneringProbe('PULSE', .8, { dt: STEP / 2 });
  assert.ok(Math.abs(right.kmh - finer.kmh) < 1, 'smaller physics steps must not change cornering loss materially');
  assert.ok(Math.abs(right.radius - finer.radius) / right.radius < .04);
  const reverse = make('PULSE', -8), forward = make('PULSE', 8);
  stepCar(reverse, { steer: .5 }); stepCar(forward, { steer: .5 });
  assert.ok(delta(origin.yaw, reverse.yaw) < 0 && delta(origin.yaw, forward.yaw) > 0);
  for (const speed of [0, .01, -.01]) {
    const car = make('PULSE', speed); stepCar(car, { throttle: 1, steer: 1 }, 0);
    assert.equal(magnitude(car), Math.abs(speed));
  }
});

test('sideways impacts, boost and low-speed steering remain finite without creating steering power', () => {
  const sideways = make('PULSE', 0);
  sideways.vx = Math.cos(origin.yaw) * 65; sideways.vz = Math.sin(origin.yaw) * 65;
  const yaw = sideways.yaw;
  stepCar(sideways, { steer: 1 });
  assert.ok(Math.abs(delta(yaw, sideways.yaw)) <= PHYSICS.lateralAcceleration / 65 * STEP + 1e-6);
  assert.ok(magnitude(sideways) < 65);
  const impact = make('PULSE', 70); impact.collisionTime = .3;
  stepCar(impact, { throttle: 1, steer: 1 });
  assert.ok(magnitude(impact) > VEHICLES.PULSE.maxSpeed, 'recovery must retain collision momentum');
  for (const id of Object.keys(VEHICLES)) {
    const expiry = make(id, 70); expiry.boostTime = STEP / 2;
    stepCar(expiry, { throttle: 1 });
    assert.ok(magnitude(expiry) < 70 && magnitude(expiry) > VEHICLES[id].maxSpeed,
      `${id}: boost expiry sheds overspeed through resistance, without snapping to the normal cap`);
    const car = make(id, VEHICLES[id].maxSpeed); car.boostTime = 1;
    for (let tick = 0; tick < 120; tick++) {
      car.x = origin.x; car.z = origin.z;
      stepCar(car, { throttle: 1, steer: tick % 30 < 15 ? 1 : -1 });
      assert.ok(magnitude(car) <= VEHICLES[id].boostSpeed + 1e-6, `${id}: boost speed budget`);
      for (const key of ['x', 'z', 'yaw', 'vx', 'vz', 'speed']) assert.ok(Number.isFinite(car[key]));
    }
  }
  const slow = corneringProbe('PULSE', 1, { speed: 8, seconds: .25, throttle: 0 });
  const straight = corneringProbe('PULSE', 0, { speed: 8, seconds: .25, throttle: 0 });
  assert.ok(straight.kmh - slow.kmh < .2, 'parking-speed tyre loss stays tiny');
});
