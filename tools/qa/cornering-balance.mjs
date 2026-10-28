import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { STEP, TRACKS, VEHICLES, createCar, sampleTrack, nearestTrack, stepCar, resolveCollisions, updateProgress } from '../../shared/game.js';

const round = value => Number(value.toFixed(3));
const angle = value => Math.atan2(Math.sin(value), Math.cos(value));

// Recenter on ordinary asphalt without changing yaw or velocity, isolating tyres from walls/pads.
export function corneringProbe(vehicle, steer, { speed = VEHICLES[vehicle].maxSpeed, seconds = 2, throttle = 1, dt = STEP } = {}) {
  const car = createCar('probe', 0, vehicle), origin = sampleTrack(25);
  Object.assign(car, origin, { vx: Math.sin(origin.yaw) * speed, vz: -Math.cos(origin.yaw) * speed, speed });
  let distance = 0, turn = 0, peakSlip = 0, previousHeading = origin.yaw;
  for (let tick = 0; tick < Math.round(seconds / dt); tick++) {
    car.x = origin.x; car.z = origin.z;
    stepCar(car, { throttle, steer: typeof steer === 'function' ? steer(tick * dt) : steer }, dt);
    const heading = Math.atan2(car.vx, -car.vz);
    turn += angle(heading - previousHeading); previousHeading = heading;
    distance += Math.hypot(car.vx, car.vz) * dt;
    peakSlip = Math.max(peakSlip, Math.abs(car.vx * Math.cos(car.yaw) + car.vz * Math.sin(car.yaw)));
  }
  return { kmh: round(Math.hypot(car.vx, car.vz) * 3.6), forwardKmh: round(car.speed * 3.6),
    radius: Math.abs(turn) > 1e-6 ? round(distance / Math.abs(turn)) : null, peakSlip: round(peakSlip),
    yaw: car.yaw, vx: car.vx, vz: car.vz };
}

function lap(vehicle, track, driftBoost) {
  const car = createCar('driver', 0, vehicle, track.id), stats = VEHICLES[vehicle];
  let tick = 0, wallTicks = 0, driftTicks = 0;
  for (; !car.finished && tick < 600 / STEP; tick++) {
    const road = nearestTrack(car.x, car.z, track);
    const target = sampleTrack(road.distance + Math.max(8, Math.abs(car.speed) * .55), 0, track);
    const turn = angle(Math.atan2(target.x - car.x, -(target.z - car.z)) - car.yaw);
    stepCar(car, { throttle: Math.abs(turn) > .6 ? .55 : 1, steer: Math.max(-1, Math.min(1, turn * 2.5)),
      drift: driftBoost && Math.abs(turn) > .22 && Math.abs(turn) < .6 && car.speed > 20,
      boost: driftBoost && Math.abs(turn) < .16 && car.charge >= stats.boostCost && car.boostTime === 0 });
    resolveCollisions([car]); updateProgress(car);
    if (car.collisionTime > 0) wallTicks++;
    if (car.drifting) driftTicks++;
  }
  return { finished: car.finished, seconds: round(tick * STEP), resets: car.resetId,
    wallSeconds: round(wallTicks * STEP), driftSeconds: round(driftTicks * STEP) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync('.cache', { recursive: true });
  const label = process.argv[2] || 'current', result = { label, probes: {}, laps: {} };
  const save = () => writeFileSync(`.cache/cornering-${label}.json`, JSON.stringify(result, null, 2));
  for (const id of Object.keys(VEHICLES)) {
    const straight = corneringProbe(id, 0), small = corneringProbe(id, .15), full = corneringProbe(id, 1);
    result.probes[id] = { straight, small, full, lossPercent: round(100 * (1 - full.kmh / straight.kmh)),
      weaving: corneringProbe(id, time => Math.floor(time / .25) % 2 ? -1 : 1) };
  }
  console.log(JSON.stringify({ label, probes: Object.fromEntries(Object.entries(result.probes).map(([id, p]) => [id,
    { smallKmh: p.small.kmh, fullKmh: p.full.kmh, lossPercent: p.lossPercent, radius: p.full.radius, slip: p.full.peakSlip }])) })); save();
  if (!process.argv.includes('--probes-only')) for (const track of Object.values(TRACKS)) {
    result.laps[track.id] = {};
    for (const mode of ['neutral', 'driftBoost']) {
      const runs = result.laps[track.id][mode] = {};
      for (const id of Object.keys(VEHICLES)) runs[id] = lap(id, track, mode === 'driftBoost');
      console.log(JSON.stringify({ label, track: track.id, mode, runs })); save();
    }
  }
}
