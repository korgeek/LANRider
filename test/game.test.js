import test from 'node:test';
import assert from 'node:assert/strict';
import * as game from '../shared/game.js';
import { boxesOverlap } from './collision-helpers.js';
import { STEP, LAPS, TRACK, sampleTrack, nearestTrack, createCar, stepCar,
  resolveCollisions, updateProgress, resetCar } from '../shared/game.js';

const drive = (car, input, seconds) => {
  for (let i = 0; i < Math.round(seconds / STEP); i++) stepCar(car, input, STEP);
};
const place = (car, distance, lateral = 0) => {
  Object.assign(car, sampleTrack(distance, lateral)); car.previousX = car.x; car.previousZ = car.z;
};
const travel = (car, from, to, increment = 2) => {
  for (let d = from; increment > 0 ? d <= to : d >= to; d += increment) {
    place(car, d);
    updateProgress(car);
  }
};

test('wrong-way detection follows actual road travel on both courses, including reversing and sideways drifts', () => {
  assert.equal(typeof game.isWrongWay, 'function');
  for (const track of Object.values(game.TRACKS)) {
    for (const distance of [-8, 50, track.length * .45, track.length - 1]) {
      const car = { ...createCar('driver', 0, 'PULSE', track.id), ...sampleTrack(distance, 0, track) };
      const move = (along, across = 0) => {
        car.vx = Math.sin(car.yaw) * along + Math.cos(car.yaw) * across;
        car.vz = -Math.cos(car.yaw) * along + Math.sin(car.yaw) * across;
      };
      move(10); assert.equal(game.isWrongWay(car), false);
      move(-10); assert.equal(game.isWrongWay(car), true, 'reversing faces forward but travels backwards');
      car.yaw += Math.PI; move(10); assert.equal(game.isWrongWay(car), true, 'forward throttle facing backwards');
      car.yaw -= Math.PI;
      move(4, 15); assert.equal(game.isWrongWay(car), false, 'forward drift');
      move(-.5, 15); assert.equal(game.isWrongWay(car), false, 'mostly sideways');
      move(-1); assert.equal(game.isWrongWay(car), false, 'slow rollback');
      move(0); assert.equal(game.isWrongWay(car), false, 'standing still');
      move(-10); car.collisionTime = .2; assert.equal(game.isWrongWay(car), false, 'collision recovery');
      car.collisionTime = 0; car.finished = true; assert.equal(game.isWrongWay(car), false);
    }
  }
});

test('each selectable lap count finishes at its own final lap on either circuit', () => {
  for (const [trackId, options] of Object.entries({ beginner: [3, 5, 7], technical: [1, 3, 5], mandalika: [1, 3, 5] })) {
    const course = game.TRACKS[trackId];
    for (const laps of options) {
      const car = createCar('laps', 0, 'PULSE', trackId, laps);
      for (let distance = -8; distance <= course.length * laps + 8 && !car.finished; distance += 4) {
        Object.assign(car, sampleTrack(distance, 0, course)); updateProgress(car);
        if (distance < course.length * laps - 4) assert(!car.finished, `${trackId}: finished before lap ${laps}`);
      }
      assert(car.finished); assert.equal(car.lap, laps); assert.equal(car.laps, laps);
    }
  }
});

test('one coastline boost strip grants a free forward boost once per crossing, outside lanes stay clear', () => {
  for (const track of Object.values(game.TRACKS)) {
    const car = createCar('pad', 0, 'PULSE', track.id);
    function enter(offset = 0, speed = 16, distance = 46) {
      Object.assign(car, sampleTrack(distance, offset, track));
      car.vx = Math.sin(car.yaw) * speed; car.vz = -Math.cos(car.yaw) * speed;
      stepCar(car, { throttle: 0 });
    }
    enter();
    assert.ok(car.boostTime > .8, 'strip must activate the existing boost FX and acceleration');
    assert.equal(car.charge, 50, 'track boost does not spend the driver gauge');
    for (let i = 0; i < 90; i++) enter();
    assert.equal(car.boostTime, 0, 'remaining inside must not refresh the timer');
    enter(6); enter(); assert.ok(car.boostTime > .8, 'leaving and crossing again rearms the strip');
    car.boostTime = 0; enter(6); assert.equal(car.boostTime, 0, 'outer lanes');
    enter(0, -16); assert.equal(car.boostTime, 0, 'reverse driving');
    resetCar(car); assert.equal(car.boostPadInside, false);
  }
});

test('the wave coast breaks both long diagonals with left and right sweeps', () => {
  const points = game.TRACKS.technical.points;
  const first = points.filter(p => p.x > -454 && p.x < -222 && p.z > -375 && p.z < -143)
    .map(p => (p.x + p.z + 596.7) / Math.SQRT2);
  const second = points.filter(p => p.x > 20 && p.x < 350 && p.z > -410 && p.z < -162)
    .map(p => (364.5 * (p.z + 413.1) - 251.1 * (p.x - 2.7)) / Math.hypot(364.5, 251.1));
  for (const offsets of [first, second]) {
    assert.ok(Math.min(...offsets) < -18, 'the road sweeps to the left of its former straight');
    assert.ok(Math.max(...offsets) > 18, 'the road sweeps to the right of its former straight');
  }
});

test('the crescent return straight has three deep alternating chicanes', () => {
  const direction = { x: -361.206, z: -562.923 }, length = Math.hypot(direction.x, direction.z);
  let peaks = 0, inWave = false;
  for (const p of game.TRACKS.mandalika.points) {
    const x = p.x - 712.8, z = p.z - 191.7;
    const along = (x * direction.x + z * direction.z) / length ** 2;
    const outward = (direction.z * x - direction.x * z) / length;
    if (along < .05 || along > .95 || outward < -10) continue;
    if (outward > 60 && !inWave) { peaks++; inWave = true; }
    if (outward < 45) inWave = false;
  }
  assert.ok(peaks >= 3, 'three substantial left-right sweeps replace sustained full-throttle travel');
  const track = game.TRACKS.mandalika;
  const start = nearestTrack(712.8, 191.7, track).distance, end = nearestTrack(351.594, -371.223, track).distance;
  let sharpBends = 0, wasSharp = false;
  for (let i = 1; i < track.points.length - 1; i++) {
    if (track.lengths[i] < start || track.lengths[i] > end) continue;
    const [a, b, c] = track.points.slice(i - 1, i + 2);
    const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    const radius = Math.hypot(a.x - b.x, a.z - b.z) * Math.hypot(b.x - c.x, b.z - c.z) * Math.hypot(a.x - c.x, a.z - c.z) / (2 * cross);
    const sharp = radius < 25;
    if (sharp && !wasSharp) sharpBends++;
    wasSharp = sharp;
  }
  assert.ok(sharpBends >= 5, 'repeated tight corners demand more steering than COMET can hold at top speed');
});

test('the crescent hairpins leave visible land between non-neighbouring roads', () => {
  const track = game.TRACKS.mandalika, points = [];
  for (let d = 0; d < track.length; d += 4) points.push({ ...sampleTrack(d, 0, track), d });
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const a = points[i], b = points[j], along = Math.min(b.d - a.d, track.length - b.d + a.d);
    if (along < 80) continue;
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= track.width + 12,
      `separate road edges need 12 m of land at ${Math.round(a.d)}/${Math.round(b.d)} m`);
  }
});

test('both courses use their own road, checkpoints and respawn without changing the beginner course', () => {
  assert.ok(game.TRACKS?.technical, 'the technical circuit must be available');
  assert.equal(game.TRACKS.beginner, TRACK);
  assert.ok(Math.abs(TRACK.length - 719.15) < .1);
  for (const [id, track] of Object.entries(game.TRACKS)) {
    assert.equal(track.width, 18);
    for (let i = 1; i < track.points.length - 1; i++) {
      const [a, b, c] = track.points.slice(i - 1, i + 2);
      const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      const radius = Math.hypot(a.x - b.x, a.z - b.z) * Math.hypot(b.x - c.x, b.z - c.z) * Math.hypot(a.x - c.x, a.z - c.z) / (2 * cross);
      assert.ok(radius > track.width / 2 + 1, `${id}: inside kerbs must not fold over at a hairpin`);
    }
    assert.deepEqual(sampleTrack(0, 0, track), sampleTrack(track.length, 0, track));
    const car = createCar(id, 0, 'PULSE', id);
    assert.equal(car.trackId, id);
    for (let distance = -8; distance <= track.length * LAPS + 2; distance += 2) {
      const p = sampleTrack(distance, 0, track);
      Object.assign(car, p); updateProgress(car);
      assert.ok(Math.abs(nearestTrack(p.x, p.z, track).offset) < .01);
    }
    assert.equal(car.lap, 3, id);
    assert.equal(car.finished, true, id);
    resetCar(car);
    assert.ok(Math.abs(nearestTrack(car.x, car.z, track).offset) < .01);
    const wall = createCar('wall', 0, 'PULSE', id);
    Object.assign(wall, sampleTrack(45, 12, track));
    stepCar(wall);
    assert.ok(Math.abs(nearestTrack(wall.x, wall.z, track).offset) <= 7.801, id);
  }
});

for (const id of ['technical', 'mandalika']) test(`the ${id} circuit can be driven for three laps with production physics and no resets`, () => {
  const track = game.TRACKS[id];
  assert.ok(track, 'the circuit must be selectable');
  const car = createCar('driver', 0, 'PULSE', id);
  for (let tick = 0; !car.finished && tick < 360 / STEP; tick++) {
    const road = nearestTrack(car.x, car.z, track);
    const target = sampleTrack(road.distance + Math.max(8, Math.abs(car.speed) * .55), 0, track);
    const yaw = Math.atan2(target.x - car.x, -(target.z - car.z));
    const angle = Math.atan2(Math.sin(yaw - car.yaw), Math.cos(yaw - car.yaw));
    stepCar(car, { throttle: Math.abs(angle) > .6 ? .55 : 1, steer: Math.max(-1, Math.min(1, angle * 2.5)) });
    resolveCollisions([car]); updateProgress(car);
  }
  assert.equal(car.finished, true);
  assert.equal(car.lap, 3);
  assert.equal(car.resetId, 0);
});

test('a fresh forward press near GO grants one free pad-strength start boost', () => {
  assert.equal(typeof game.updateStartBoost, 'function');
  for (const age of [-.15, 0, .3]) {
    const car = createCar('launch');
    assert.equal(game.updateStartBoost(car, true, age), true);
    assert.equal(car.boostTime, 0, 'countdown input cannot start the effect before physics starts');
    stepCar(car, { throttle: 1 });
    assert.equal(car.boostTime, game.BOOST_PAD.duration); assert.equal(car.charge, 50);
    game.updateStartBoost(car, false, age + .01);
    assert.equal(game.updateStartBoost(car, true, age + .02), false, 'repeated tapping cannot refresh the launch boost');
    resetCar(car);
    game.updateStartBoost(car, false, age);
    assert.equal(game.updateStartBoost(car, true, age), false, 'reset cannot rearm a used start boost');
  }
  const held = createCar('held');
  assert.equal(game.updateStartBoost(held, true, -2), false);
  assert.equal(game.updateStartBoost(held, true, .1), false, 'holding forward from early countdown earns no boost');
  game.updateStartBoost(held, false, .1);
  assert.equal(game.updateStartBoost(held, true, .15), true, 'releasing and timing a fresh press works');
  for (const age of [-.3, .6, NaN, Infinity]) {
    const car = createCar('miss'); game.updateStartBoost(car, true, age); stepCar(car, { throttle: 1 });
    assert.equal(car.boostTime, 0, 'out-of-window presses do not launch');
  }
});

test('track wraps continuously and projects road offsets', () => {
  assert.equal(TRACK.width, 18, 'the course is 1.5 times its original 12 m width');
  assert.ok(TRACK.length >= 600 && TRACK.length <= 800);
  assert.deepEqual(sampleTrack(0), sampleTrack(TRACK.length));
  const p = sampleTrack(40, 3);
  const projected = nearestTrack(p.x, p.z);
  assert.ok(Math.abs(projected.distance - 40) < 0.2);
  assert.ok(Math.abs(projected.offset - 3) < 0.2);
  const cars = Array.from({ length: 4 }, (_, i) => createCar(String(i), i));
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    assert.ok(Math.hypot(cars[i].x - cars[j].x, cars[i].z - cars[j].z) > 2.4);
  }
});

test('throttle accelerates a car down the starting straight', () => {
  const car = createCar('a', 0);
  const { x, z } = car;
  drive(car, { throttle: 1 }, 1);
  assert.ok(car.speed > 12);
  assert.ok(Math.hypot(car.x - x, car.z - z) > 5);
  assert.ok(car.z < z);
});

test('the beginner starting grid and opening acceleration fit inside the straight', () => {
  const start = sampleTrack(0);
  for (let distance = -18; distance <= 20; distance += 2) {
    const road = sampleTrack(distance);
    assert.ok(Math.abs(Math.atan2(Math.sin(road.yaw - start.yaw), Math.cos(road.yaw - start.yaw))) < .12,
      'the last grid row must already be clear of the returning bend');
  }
  for (let slot = 0; slot < 4; slot++) {
    const car = createCar(String(slot), slot);
    drive(car, { throttle: 1 }, 2);
    assert.equal(car.collisionTime, 0);
    assert.ok(Math.abs(nearestTrack(car.x, car.z).offset) < 3, 'straight throttle must keep every grid slot in its lane');
  }
});

test('stationary and straight-line drift cannot charge', () => {
  const car = createCar('a', 0);
  const charge = car.charge;
  drive(car, { drift: true, steer: 1 }, 2);
  assert.equal(car.charge, charge);
  drive(car, { throttle: 1, drift: true }, 1);
  assert.equal(car.charge, charge);
});

test('steered high-speed drift builds charge and lateral slip', () => {
  const car = createCar('a', 0);
  car.speed = 25;
  car.vx = Math.sin(car.yaw) * 25;
  car.vz = -Math.cos(car.yaw) * 25;
  const charge = car.charge;
  drive(car, { throttle: 1, steer: 0.5, drift: true }, 0.4);
  assert.ok(car.charge > charge);
  assert.equal(car.drifting, true);
  const sideways = car.vx * Math.cos(car.yaw) + car.vz * Math.sin(car.yaw);
  assert.ok(Math.abs(sideways) > 1);
});

test('boost costs charge, expires, and requires a new button press', () => {
  const car = createCar('a', 0);
  car.charge = 100;
  stepCar(car, { boost: true }, STEP);
  assert.equal(car.charge, 65);
  assert.ok(car.boostTime > 1);
  drive(car, { boost: true }, 3);
  assert.equal(car.boostTime, 0);
  assert.equal(car.charge, 65);
  stepCar(car, { boost: false }, STEP);
  stepCar(car, { boost: true }, STEP);
  assert.equal(car.charge, 30);
});

test('braking slows forward travel and boost increases acceleration', () => {
  const boosted = createCar('boosted', 0), normal = createCar('normal', 0);
  drive(boosted, { throttle: 1, boost: true }, 1);
  drive(normal, { throttle: 1 }, 1);
  assert.ok(boosted.speed > normal.speed + 8);
  const speed = normal.speed;
  drive(normal, { throttle: -1 }, 0.25);
  assert.ok(normal.speed < speed - 5);
});

test('reverse travel and repeated resets cannot add a lap', () => {
  const car = createCar('a', 0);
  travel(car, -8, -TRACK.length * 2, -2);
  for (let i = 0; i < 5; i++) resetCar(car);
  assert.equal(car.lap, 0);
  assert.equal(car.checkpoint, 0);
  assert.equal(car.finished, false);
});

test('sequential forward circuits count three laps and leave finish time to server', () => {
  const car = createCar('a', 0);
  travel(car, -8, TRACK.length + 2);
  assert.equal(car.lap, 1);
  const checkpoint = car.checkpoint;
  resetCar(car);
  assert.equal(car.lap, 1);
  assert.equal(car.checkpoint, checkpoint);
  assert.equal(car.speed, 0);
  travel(car, car.routeProgress, TRACK.length * LAPS + 2);
  assert.equal(car.lap, 3);
  assert.equal(car.finished, true);
  assert.equal(car.finishTime, null);
});

test('skipping checkpoints or bouncing across the start cannot create a lap', () => {
  const car = createCar('a', 0);
  for (let i = 0; i < 20; i++) {
    place(car, TRACK.length - 1);
    updateProgress(car);
    place(car, 1);
    updateProgress(car);
  }
  assert.equal(car.lap, 0);
  place(car, TRACK.length * 0.5);
  updateProgress(car);
  assert.equal(car.lap, 0);
  assert.equal(car.checkpoint, 0);
});

test('vehicle-sized boxes catch long bumpers and rotate with the vehicle without invisible side contacts', () => {
  for (const [vehicle, length] of [['COMET', 3.45], ['IGNIS', 3.5], ['SLIDE', 3.25]]) {
    for (const turn of [0, .7, Math.PI / 2]) {
      const a = createCar('a', 0, vehicle), b = createCar('b', 1, vehicle);
      place(a, 25); a.yaw += turn;
      const fx = Math.sin(a.yaw), fz = -Math.cos(a.yaw);
      Object.assign(b, { x: a.x + fx * (length * .9 - .1), z: a.z + fz * (length * .9 - .1), yaw: a.yaw + Math.PI });
      for (const [car, sign] of [[a, 1], [b, -1]]) Object.assign(car, { previousX: car.x, previousZ: car.z, vx: fx * sign * 10, vz: fz * sign * 10 });
      resolveCollisions([a, b]);
      assert(a.vx * fx + a.vz * fz < -5, `${vehicle}/${turn}: front bumper rebounds before models overlap deeply`);
      assert(b.vx * fx + b.vz * fz > 5);
    }
  }
  const a = createCar('a', 0, 'RALLY'), b = createCar('b', 1, 'RALLY');
  place(a, 25); const nx = Math.cos(a.yaw), nz = Math.sin(a.yaw);
  Object.assign(b, { x: a.x + nx * 2.1, z: a.z + nz * 2.1, yaw: a.yaw });
  for (const [car, sign] of [[a, 1], [b, -1]]) Object.assign(car, { previousX: car.x, previousZ: car.z, vx: nx * sign, vz: nz * sign });
  resolveCollisions([a, b]);
  assert.equal(a.collisionTime, 0); assert.equal(b.collisionTime, 0, 'narrow cars do not hit at an invisible circle edge');
});

test('swept boxes catch a high-speed pass through a narrow side contact', () => {
  const a = createCar('a', 0, 'RALLY'), b = createCar('b', 1, 'RALLY');
  place(a, 25, -1.5); place(b, 25, 1.5);
  const nx = (b.x - a.x) / 3, nz = (b.z - a.z) / 3;
  Object.assign(a, { previousX: a.x, previousZ: a.z, vx: nx * 120, vz: nz * 120 });
  Object.assign(b, { previousX: b.x, previousZ: b.z, vx: -nx * 120, vz: -nz * 120 });
  a.x += a.vx / 30; a.z += a.vz / 30; b.x += b.vx / 30; b.z += b.vz / 30;
  resolveCollisions([a, b], 1 / 30);
  assert((b.x - a.x) * nx + (b.z - a.z) * nz >= 1.55, 'boxes retain their order and separate');
  assert((b.vx - a.vx) * nx + (b.vz - a.vz) * nz > 100);
});

test('overlapping cars separate and exchange an approaching impulse', () => {
  const a = createCar('a', 0), b = createCar('b', 1);
  place(a, 25, -.5); place(b, 25, .5);
  const nx = b.x-a.x, nz = b.z-a.z;
  Object.assign(a, { vx: nx * 5, vz: nz * 5 });
  Object.assign(b, { vx: -nx * 5, vz: -nz * 5 });
  resolveCollisions([a, b]);
  assert.equal(boxesOverlap(a, b), false);
  assert.ok(a.vx * nx + a.vz * nz < 0 && b.vx * nx + b.vz * nz > 0);
  Object.assign(b, { x: a.x, z: a.z, previousX: a.x, previousZ: a.z });
  resolveCollisions([a, b]);
  assert.equal(boxesOverlap(a, b), false);
});

test('wall impact clamps the car inside the road with finite serializable state', () => {
  const car = createCar('a', 0);
  place(car, 30, 15);
  car.speed = 30;
  car.vx = 30;
  car.vz = -30;
  stepCar(car, { throttle: 1, steer: Infinity }, STEP);
  assert.ok(Math.abs(nearestTrack(car.x, car.z).offset) <= TRACK.width / 2 - game.PHYSICS.radius + .01);
  for (const value of Object.values(car)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
  assert.deepEqual(JSON.parse(JSON.stringify(car)), car);
  assert.ok(Math.hypot(car.vx, car.vz) < 42);
});

test('glancing wall impact gives a small rebound and loses some tangent speed', () => {
  const car = createCar('wall');
  place(car, 35, TRACK.width / 2 - game.PHYSICS.radius - .01);
  const road = nearestTrack(car.x, car.z), nx = Math.cos(road.yaw), nz = Math.sin(road.yaw);
  Object.assign(car, { yaw: road.yaw, vx: nx * 12 + Math.sin(road.yaw) * 24,
    vz: nz * 12 - Math.cos(road.yaw) * 24 });
  stepCar(car, {}, STEP);
  const normal = car.vx * nx + car.vz * nz;
  const tangent = car.vx * Math.sin(road.yaw) - car.vz * Math.cos(road.yaw);
  assert.ok(normal < -.5 && normal > -4, `small normal rebound: ${normal}`);
  assert.ok(tangent > 19 && tangent < 23, `friction reduces tangent speed: ${tangent}`);
});

test('wall bounce survives several frames while throttle remains held', () => {
  const car = createCar('wall');
  place(car, 35, TRACK.width / 2 - game.PHYSICS.radius - .01);
  const road = nearestTrack(car.x, car.z), nx = Math.cos(road.yaw), nz = Math.sin(road.yaw);
  Object.assign(car, { yaw: road.yaw + Math.PI / 2, vx: nx * 30, vz: nz * 30 });
  stepCar(car, { throttle: 1 }, STEP);
  const impact = car.vx * nx + car.vz * nz;
  drive(car, { throttle: 1 }, .15);
  assert.ok(impact < -3 && impact > -8, `head-on impact loses most energy: ${impact}`);
  assert.ok(car.vx * nx + car.vz * nz < -1);
  assert.ok(nearestTrack(car.x, car.z).offset < TRACK.width / 2 - game.PHYSICS.radius - .3);
});

test('sustained drift sacrifices speed under full throttle while still charging', () => {
  for (const vehicle of Object.keys(game.VEHICLES)) {
    const normal = createCar('normal', 0, vehicle), drift = createCar('drift', 0, vehicle);
    for (const car of [normal, drift]) {
      place(car, 20); // Ordinary asphalt, before the new 42m boost strip.
      car.vx = Math.sin(car.yaw) * 32; car.vz = -Math.cos(car.yaw) * 32;
    }
    const charge = drift.charge;
    drive(normal, { throttle: 1, steer: .5 }, .4);
    drive(drift, { throttle: 1, steer: .5, drift: true }, .4);
    assert.ok(Math.hypot(drift.vx, drift.vz) < 31, `${vehicle} drift must slow down`);
    assert.ok(Math.hypot(normal.vx, normal.vz) > Math.hypot(drift.vx, drift.vz) + 2, `${vehicle} drift has a speed cost`);
    assert.ok(drift.charge > charge, `${vehicle} keeps charging`);
  }
});

test('normal top speeds are reduced by 5%, average 190 km/h, and remain reachable with room for boost', () => {
  const targets = { PULSE: 190, APEX: 180.5, BOLT: 194.75, COMET: 218.5, BULWARK: 190, SLIDE: 175.75, IGNIS: 194.75, RALLY: 175.75 };
  const speeds = [];
  for (const [vehicle, target] of Object.entries(targets)) {
    const car = createCar(vehicle, 0, vehicle), stats = game.VEHICLES[vehicle];
    for (let tick = 0; tick < 60 / STEP; tick++) { place(car, 25); stepCar(car, { throttle: 1 }); }
    const cruising = car.speed * 3.6;
    assert.ok(Math.abs(cruising - target) < .1, `${vehicle}: sustained full throttle reaches ${target} km/h, got ${cruising}`);
    speeds.push(cruising);
    let boosted = cruising;
    for (let tick = 0; tick < stats.boostDuration / STEP; tick++) {
      place(car, 25); stepCar(car, { throttle: 1, boost: true });
      boosted = Math.max(boosted, car.speed * 3.6);
    }
    assert.ok(boosted > cruising + 10 && boosted <= 280 + 1e-6, `${vehicle}: boost stays faster than cruising and within 280 km/h`);
  }
  assert.ok(Math.abs(speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length - 190) < .1);
});

test('acceleration tradeoffs keep lower caps quick to reach and preserve the launch specialist', () => {
  const times = {};
  for (const vehicle of Object.keys(game.VEHICLES)) {
    const car = createCar(vehicle, 0, vehicle), stats = game.VEHICLES[vehicle];
    for (let tick = 1; tick <= 20 / STEP; tick++) {
      place(car, 25); stepCar(car, { throttle: 1 });
      times[vehicle] ||= {};
      if (car.speed * 3.6 >= 100) times[vehicle].hundred ??= tick * STEP;
      if (car.speed >= stats.maxSpeed * .95) { times[vehicle].top = tick * STEP; break; }
    }
    assert.ok(times[vehicle].hundred && times[vehicle].top);
  }
  for (const vehicle of ['APEX', 'SLIDE', 'RALLY']) assert.ok(times[vehicle].top < times.PULSE.top, `${vehicle}: lower cap is reached sooner`);
  for (const [vehicle, time] of Object.entries(times)) {
    if (vehicle !== 'COMET') assert.ok(times.COMET.top > time.top, 'the fastest top end takes longest to build');
    if (vehicle !== 'BOLT') assert.ok(times.BOLT.hundred < time.hundred, 'BOLT retains its quick-launch identity');
  }
});

test('vehicle selection changes acceleration, grip, drift, boost, and collision recovery', () => {
  const vehicles = game.VEHICLES;
  assert.ok(vehicles, 'vehicle presets must exist');
  assert.equal(Object.keys(vehicles).length, 8);
  assert.equal(createCar('unknown', 0, 'constructor').vehicle, 'PULSE');
  const make = vehicle => { const car = createCar(vehicle, 0, vehicle); place(car, 35); return car; };
  const pulse = make('PULSE'), bolt = make('BOLT');
  drive(pulse, { throttle: 1 }, .5); drive(bolt, { throttle: 1 }, .5);
  assert.ok(bolt.speed > pulse.speed + 2);
  const run = (vehicle, input, seconds, speed = 25) => {
    const car = make(vehicle);
    Object.assign(car, { vx: Math.sin(car.yaw) * speed, vz: -Math.cos(car.yaw) * speed });
    drive(car, input, seconds); return car;
  };
  const apex = run('APEX', { steer: .5 }, .1), normal = run('PULSE', { steer: .5 }, .1);
  assert.ok(Math.abs(apex.yaw - sampleTrack(35).yaw) > Math.abs(normal.yaw - sampleTrack(35).yaw));
  const slide = run('SLIDE', { throttle: 1, drift: true, steer: .5 }, .25);
  const driftPulse = run('PULSE', { throttle: 1, drift: true, steer: .5 }, .25);
  assert.ok(slide.charge > driftPulse.charge);
  const ignis = run('IGNIS', { throttle: 1, boost: true }, 1.5, 0);
  const boostPulse = run('PULSE', { throttle: 1, boost: true }, 1.5, 0);
  assert.ok(ignis.boostTime > 0 && boostPulse.boostTime === 0);
  assert.ok(ignis.speed > boostPulse.speed);
  const rally = run('RALLY', { throttle: 1 }, .5, 0);
  assert.ok(rally.speed > pulse.speed);
  const topSpeed = vehicle => {
    const car = make(vehicle);
    // Repeated straight segments isolate top speed from bends and walls.
    for (let i = 0; i < 1200; i++) { place(car, 35); stepCar(car, { throttle: 1 }); }
    return car.speed;
  };
  assert.ok(topSpeed('COMET') > topSpeed('PULSE') + 5);
  const recover = vehicle => {
    const car = make(vehicle); place(car, 35, TRACK.width / 2 - game.PHYSICS.radius - .01); car.yaw += Math.PI / 2;
    car.vx = Math.sin(car.yaw) * 30; car.vz = -Math.cos(car.yaw) * 30;
    drive(car, { throttle: 1 }, .22); return car.collisionTime;
  };
  assert.equal(recover('BULWARK'), 0);
  assert.ok(recover('PULSE') > 0);
});

test('unequal masses split overlap and impulse with the lighter car moving more', () => {
  const light = createCar('light', 0, 'BOLT'), heavy = createCar('heavy', 1, 'BULWARK');
  place(light, 35, -.6); place(heavy, 35, .6);
  const lx = light.x, lz = light.z, hx = heavy.x, hz = heavy.z;
  const nx = (hx - lx) / 1.2, nz = (hz - lz) / 1.2;
  Object.assign(light, { vx: nx * 10, vz: nz * 10, mass: 99999 });
  Object.assign(heavy, { vx: -nx * 10, vz: -nz * 10, mass: .0001 });
  resolveCollisions([light, heavy]);
  const lightMove = Math.hypot(light.x - lx, light.z - lz), heavyMove = Math.hypot(heavy.x - hx, heavy.z - hz);
  assert.ok(lightMove > heavyMove * 2);
  assert.ok(Math.hypot(light.vx - nx * 10, light.vz - nz * 10)
    > Math.hypot(heavy.vx + nx * 10, heavy.vz + nz * 10) * 2);
});

test('head-on and side collisions separate and rebound for several frames', () => {
  for (const lateral of [false, true]) {
    const a = createCar('a'), b = createCar('b');
    place(a, 25, lateral ? -.6 : 0); place(b, lateral ? 25 : 26.8, lateral ? .6 : 0);
    const distance = Math.hypot(b.x - a.x, b.z - a.z), nx = (b.x - a.x) / distance, nz = (b.z - a.z) / distance;
    Object.assign(a, { vx: nx * 20, vz: nz * 20 }); Object.assign(b, { vx: -nx * 20, vz: -nz * 20 });
    resolveCollisions([a, b]);
    assert.equal(boxesOverlap(a, b), false);
    assert.ok((b.vx - a.vx) * nx + (b.vz - a.vz) * nz > 25);
    for (let i = 0; i < 6; i++) {
      stepCar(a, { throttle: 1 }); stepCar(b, { throttle: 1 }); resolveCollisions([a, b]);
    }
    assert.ok(Math.hypot(b.x - a.x, b.z - a.z) > 4);
  }
});

test('four cars piled against a wall stay separated, inside the track, and finite', () => {
  const cars = ['PULSE', 'BOLT', 'BULWARK', 'RALLY'].map((vehicle, i) => {
    const car = createCar(String(i), i, vehicle); place(car, 35 + i * .3, TRACK.width / 2 - game.PHYSICS.radius - .1);
    Object.assign(car, { vx: 30, vz: -15 }); return car;
  });
  for (let frame = 0; frame < 90; frame++) {
    for (const car of cars) stepCar(car, { throttle: 1 });
    resolveCollisions(cars);
    for (const car of cars) {
      assert.ok(Math.abs(nearestTrack(car.x, car.z).offset) <= TRACK.width / 2 - game.PHYSICS.radius + .001);
      for (const value of Object.values(car)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
      assert.deepEqual(JSON.parse(JSON.stringify(car)), car);
    }
    for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
      assert.ok(!boxesOverlap(cars[i], cars[j]),
        `frame ${frame}: ${cars[i].id}/${cars[j].id} overlap`);
    }
  }
});

test('boost-speed bumper contact rebounds before passing through the other box', () => {
  const a = createCar('a'), b = createCar('b');
  place(a, 25, -.75); place(b, 28.4, .75);
  Object.assign(a, { vx: Math.sin(a.yaw) * 60, vz: -Math.cos(a.yaw) * 60, boostTime: 1 });
  b.yaw += Math.PI;
  Object.assign(b, { vx: Math.sin(b.yaw) * 60, vz: -Math.cos(b.yaw) * 60, boostTime: 1 });
  stepCar(a, {}, STEP); stepCar(b, {}, STEP);
  resolveCollisions([a, b], STEP);
  assert.ok(a.collisionTime > 0 && b.collisionTime > 0);
  assert.ok(a.speed < -20 && b.speed < -20, 'both vehicles rebound from their head-on approach');
  assert.equal(boxesOverlap(a, b), false);
});

test('finished cars no longer block or alter cars that are still racing', () => {
  const a = createCar('a'), b = createCar('b');
  place(a, 35); place(b, 37); b.finished = true;
  const { x, z } = b;
  Object.assign(a, { vx: Math.sin(a.yaw) * 30, vz: -Math.cos(a.yaw) * 30 });
  resolveCollisions([a, b]);
  assert.equal(b.x, x); assert.equal(b.z, z); assert.equal(b.vx, 0); assert.equal(b.vz, 0);
  assert.ok(a.speed > 29, 'a coasting finisher cannot act as an invisible stationary barrier');
});

test('a moving finisher ignores inputs and boost while keeping its momentum and records', () => {
  for (const track of Object.values(game.TRACKS)) {
    const car = Object.assign(createCar('finisher', 0, 'PULSE', track.id), sampleTrack(25, 0, track),
      { finished: true, lap: 3, finishTime: 60, boostTime: 1 });
    car.vx = Math.sin(car.yaw) * 70; car.vz = -Math.cos(car.yaw) * 70;
    const before = { ...car };
    stepCar(car, { throttle: 1, steer: 1, boost: true, drift: true, reset: true });
    resolveCollisions([car]); updateProgress(car);
    assert.ok(Math.hypot(car.x - before.x, car.z - before.z) > 1, 'the finish line does not stop the car');
    assert.ok(car.speed < 70 && car.speed > game.VEHICLES.PULSE.maxSpeed, 'overspeed decays instead of snapping to the normal cap');
    assert.equal(car.yaw, before.yaw); assert.equal(car.resetId, before.resetId);
    assert.equal(car.boostTime, 0); assert.equal(car.drifting, false); assert.equal(car.charge, before.charge);
    assert.equal(car.finishTime, 60); assert.equal(car.lap, 3); assert.equal(car.progress, before.progress);
  }
});

test('finished cars ignore reset and driving inputs without moving their finish pose', () => {
  for (const track of Object.values(game.TRACKS)) {
    const car = createCar('finished', 0, 'PULSE', track.id);
    Object.assign(car, sampleTrack(120, 0, track), { finished: true, lap: 3, finishTime: 60, respawnDistance: 90,
      vx: 0, vz: 0, speed: 0 });
    const pose = { x: car.x, z: car.z, yaw: car.yaw, resetId: car.resetId };
    for (let tick = 0; tick < 60; tick++) {
      stepCar(car, { throttle: 1, steer: 1, drift: true, boost: true, reset: true });
      resolveCollisions([car]); updateProgress(car);
      assert.deepEqual({ x: car.x, z: car.z, yaw: car.yaw, resetId: car.resetId }, pose, track.id);
      assert.equal(car.finished, true); assert.equal(car.finishTime, 60); assert.equal(car.charge, 50);
    }
  }
});
