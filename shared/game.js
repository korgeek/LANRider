export const STEP = 1 / 60;
export const VERSION = '0.8.3';
export const MAX_SPECTATORS = 16;
export const LAPS = 3;
export const LAP_OPTIONS = { beginner: [3, 5, 7], technical: [1, 3, 5], mandalika: [1, 3, 5] };
export const BOOST_PAD = { distance: 42, length: 9, width: 5, duration: .9 };
export const PHYSICS = {
  radius: 1.2, acceleration: 23, braking: 36, reverseAcceleration: 9,
  maxSpeed: 190 / 3.6, reverseSpeed: 10, boostSpeed: 280 / 3.6, boostAcceleration: 20,
  turnRate: 1.45, grip: 8, driftGrip: 1.7, driftMinSpeed: 8,
  lateralAcceleration: 64, speedResponse: 2,
  chargeRate: 16, boostCost: 35, boostDuration: 1.4,
  checkpoints: 12, maxProgressStep: 12, dragScale: 1,
  wallRestitution: .18, wallFriction: .2, driftDrag: .9,
  collisionScale: .9, collisionHeight: 1.9,
};
// Speeds use m/s; the eight normal caps average 190 km/h. Visual assets are mapped separately.
export const VEHICLES = {
  PULSE: { ...PHYSICS, name: 'PULSE', description: '모든 능력이 균형 잡힌 기본 카트',
    ratings: { acceleration: 3, speed: 3, cornering: 3, drift: 3, recovery: 3, boost: 3 },
    mass: 1, restitution: .82, recovery: .3, collisionSize: [1.982, 2.684], collisionOffset: .032 },
  APEX: { ...PHYSICS, name: 'APEX', description: '민첩한 코너링과 안정적인 드리프트',
    ratings: { acceleration: 2, speed: 2, cornering: 5, drift: 4, recovery: 3, boost: 2 },
    mass: .9, restitution: .82, recovery: .3, acceleration: 20.5, maxSpeed: 180.5 / 3.6,
    turnRate: 1.85, grip: 10, driftGrip: 1.35, chargeRate: 19, boostAcceleration: 17, boostDuration: 1.25, dragScale: .9,
    collisionSize: [2.327, 2.945], collisionOffset: .098 },
  BOLT: { ...PHYSICS, name: 'BOLT', description: '가벼운 차체와 빠른 출발 가속',
    ratings: { acceleration: 5, speed: 3, cornering: 3, drift: 2, recovery: 2, boost: 3 },
    mass: .75, restitution: .84, recovery: .38, acceleration: 29, maxSpeed: 194.75 / 3.6, driftGrip: 2, chargeRate: 13, collisionSize: [2.307, 2.655], collisionOffset: .015 },
  COMET: { ...PHYSICS, name: 'COMET', description: '긴 직선에서 빛나는 높은 최고속도',
    ratings: { acceleration: 2, speed: 5, cornering: 2, drift: 3, recovery: 3, boost: 3 },
    mass: 1.1, restitution: .82, recovery: .3, acceleration: 20, maxSpeed: 218.5 / 3.6, turnRate: 1.3, grip: 7, dragScale: .68,
    collisionSize: [2.017, 3.446], collisionOffset: .195 },
  BULWARK: { ...PHYSICS, name: 'BULWARK', description: '무거운 차체와 빠른 충돌 회복',
    ratings: { acceleration: 3, speed: 3, cornering: 2, drift: 2, recovery: 5, boost: 3 },
    mass: 1.8, restitution: .78, recovery: .16, turnRate: 1.3, grip: 7, driftGrip: 2, chargeRate: 13, collisionSize: [1.819, 2.519], collisionOffset: .018 },
  SLIDE: { ...PHYSICS, name: 'SLIDE', description: '긴 슬립과 높은 드리프트 충전 효율',
    ratings: { acceleration: 3, speed: 2, cornering: 3, drift: 5, recovery: 2, boost: 3 },
    mass: .9, restitution: .84, recovery: .38, acceleration: 25, maxSpeed: 175.75 / 3.6, driftGrip: 1, chargeRate: 23, collisionSize: [2.15, 3.249], collisionOffset: -.049 },
  IGNIS: { ...PHYSICS, name: 'IGNIS', description: '강한 추가 추력과 오래 지속되는 부스터',
    ratings: { acceleration: 2, speed: 3, cornering: 3, drift: 3, recovery: 2, boost: 5 },
    mass: 1, restitution: .82, recovery: .38, acceleration: 20.5, maxSpeed: 194.75 / 3.6, boostAcceleration: 27,
    boostDuration: 1.85, boostCost: 32, dragScale: .86, collisionSize: [2.06, 3.453], collisionOffset: -.02 },
  RALLY: { ...PHYSICS, name: 'RALLY', description: '빠른 가속과 든든한 충돌 회복',
    ratings: { acceleration: 4, speed: 2, cornering: 3, drift: 2, recovery: 4, boost: 3 },
    mass: 1.25, restitution: .8, recovery: .23, acceleration: 27, maxSpeed: 175.75 / 3.6, driftGrip: 2, chargeRate: 13,
    collisionSize: [1.732, 2.392], collisionOffset: .005 },
};
// Footprints follow the body bounds at 90%; height includes the mounted driver.
// Tracks are flat, so contacts use the box's horizontal projection.
export function collisionBox(vehicle) {
  const stats = Object.hasOwn(VEHICLES, vehicle) ? VEHICLES[vehicle] : VEHICLES.PULSE;
  return { width: stats.collisionSize[0] * PHYSICS.collisionScale, length: stats.collisionSize[1] * PHYSICS.collisionScale,
    height: PHYSICS.collisionHeight, offset: stats.collisionOffset };
}
const vehicleStats = car => Object.hasOwn(VEHICLES, car.vehicle) ? VEHICLES[car.vehicle] : VEHICLES.PULSE;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
const wrap = (distance, track = TRACK) => ((distance % track.length) + track.length) % track.length;

// A long starting straight, a broad coastal loop, and an S bend returning home.
const anchors = [[0, 0], [0, -90], [15, -140], [75, -170], [135, -135],
  [150, -70], [115, -15], [150, 45], [120, 100], [45, 120], [-15, 80], [-25, 30]];
function buildTrack(id, name, anchors) {
  const points = [];
  for (let i = 0; i < anchors.length; i++) {
    for (let j = 0; j < 16; j++) {
      const t = j / 16;
      const coordinate = axis => {
        const [a, b, c, d] = [-1, 0, 1, 2].map(k => anchors[(i + k + anchors.length) % anchors.length][axis]);
        // Quadratic corner rounding keeps the reference hairpins inside their control polygon.
        if (id !== 'beginner') return .45 * ((1 - t) ** 2 * a + (1 + 2 * t - 2 * t * t) * b + t * t * c);
        return 0.45 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t
          + (-a + 3 * b - 3 * c + d) * t * t * t);
      };
      points.push({ x: coordinate(0), z: coordinate(1) });
    }
  }
  points.push({ ...points[0] });
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  // Keep the beginner grid clear of the returning bend without changing the road geometry.
  return { id, name, points, lengths, length: lengths.at(-1), width: 18, startDistance: id === 'beginner' ? 40 : 0 };
}

// Keep the beginner geometry; advanced courses add coastal waves and a 60-degree crescent.
export const TRACK = buildTrack('beginner', '바닷가 · 초보', anchors);
export const TRACKS = {
  beginner: TRACK,
  technical: buildTrack('technical', '웨이브 코스트 · 상급', [
    [280, 236], [260, 217], [246, 201], [244, 184], [248, 158], [242, 140],
    [224, 120], [219, 111], [225, 104], [248, 106], [257, 99], [249, 89],
    [221, 84], [213, 84], [198, 97], [185, 108], [183, 136], [166, 138],
    [151, 122], [140, 135], [137, 160], [123, 169], [112, 183],
    [110, 190], [117, 197], [133, 202], [140, 209], [138, 218], [131, 222],
    [117, 218], [98, 206], [84, 189], [79, 171], [78, 140], [78, 105],
    [79, 87], [85, 77], [101, 70], [133, 64], [166, 64], [187, 65],
    [207, 57], [229, 66], [249, 59], [261, 56], [270, 61], [274, 75],
    [281, 83], [300, 109], [314, 119], [328, 91], [344, 107], [351, 142],
    [368, 158], [385, 149], [400, 167], [416, 176], [423, 186],
    [420, 196], [409, 203], [390, 210], [368, 225], [350, 239], [348, 246],
    [355, 257], [355, 263], [347, 269], [331, 274], [321, 274], [309, 264],
  ].map(([x, z]) => [(x - 280) * 3, (z - 236) * 3])),
  mandalika: buildTrack('mandalika', '크레센트 베이 · 상급', [
    [124.52, -28.33], [147.31, -47.1], [182.36, -58.07], [206.03, -64.07], [223.24, -37.46],
    [246.95, -8.76], [265.05, 23.17], [281.5, 42.68], [295.61, 74.44], [308.75, 94.16],
    [324.19, 105.67], [340.26, 105.32], [354.82, 95.66], [363.83, 87.67], [374.86, 88.6],
    [396.44, 105.48], [417.77, 124.72], [432.35, 142.67], [444, 158], [437, 175],
    [416, 176], [392, 165], [378, 168], [383, 183], [404, 194], [427, 205],
    [447, 215], [450, 234], [435, 243], [413, 229], [387, 209], [363, 190],
    [344, 174], [323.74, 151.68], [297, 146], [281.59, 143.4], [284, 128],
    [292.47, 114], [292.47, 101.1], [278, 98], [262, 97], [247.8, 94.45],
    [250, 80], [260.37, 64], [260.37, 51.07], [246, 48], [232, 46],
    [217.38, 43.33], [220, 29], [226.57, 15], [226.57, 2.11], [215, -9],
    [210.22, -34.49], [203.06, -41.99], [189.68, -40.66],
    [168.38, -33.65], [155.24, -24.22], [149.59, -12.1], [138.71, -3.93], [124.84, 14.11],
    [118.22, 20.27], [109.04, 17.18], [103.57, 24.68], [93.84, 43.96], [91.05, 59.8],
    [91.22, 69.84], [94.5, 81], [90, 91], [79, 87], [74.77, 77.15],
    [69.19, 69.1], [74.21, 61.14], [77.95, 45.21], [86.91, 22.52], [103.15, -3.47],
  ].map(([x, z]) => [(x - 80) * 3, (z - 103) * 3])),
};

export function sampleTrack(distance, lateral = 0, track = TRACK) {
  const { points, lengths } = track;
  distance = wrap(finite(distance) + (track.startDistance || 0), track);
  lateral = finite(lateral);
  let index = 0;
  while (index < points.length - 2 && lengths[index + 1] <= distance) index++;
  const a = points[index], b = points[index + 1];
  const length = lengths[index + 1] - lengths[index];
  const dx = (b.x - a.x) / length, dz = (b.z - a.z) / length;
  const along = distance - lengths[index];
  return { x: a.x + dx * along - dz * lateral, z: a.z + dz * along + dx * lateral,
    yaw: Math.atan2(dx, -dz) };
}

export function nearestTrack(x, z, track = TRACK) {
  const { points, lengths } = track;
  x = finite(x); z = finite(z);
  let best = Infinity, result;
  // ponytail: linear segment scan is enough for four cars; index spatially if the course grows.
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const squaredLength = dx * dx + dz * dz;
    const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / squaredLength, 0, 1);
    const px = a.x + dx * t, pz = a.z + dz * t;
    const squaredDistance = (x - px) ** 2 + (z - pz) ** 2;
    if (squaredDistance < best) {
      best = squaredDistance;
      const length = Math.sqrt(squaredLength);
      result = { x: px, z: pz, distance: wrap(lengths[i] + length * t - (track.startDistance || 0), track),
        offset: ((x - px) * -dz + (z - pz) * dx) / length,
        yaw: Math.atan2(dx, -dz), index: i };
    }
  }
  return result;
}

export function isWrongWay(car) {
  if (!car || car.finished || car.collisionTime > 0) return false;
  const road = nearestTrack(car.x, car.z, TRACKS[car.trackId] || TRACK);
  const along = car.vx * Math.sin(road.yaw) - car.vz * Math.cos(road.yaw);
  return along < -2 && along < -.5 * Math.hypot(car.vx, car.vz);
}

export function createCar(id, slot = 0, vehicle = 'PULSE', trackId = 'beginner', laps = LAPS) {
  const track = Object.hasOwn(TRACKS, trackId) ? TRACKS[trackId] : TRACK;
  slot = clamp(Math.trunc(finite(slot)), 0, 3);
  const distance = -8 - Math.floor(slot / 2) * 6;
  return { id, slot, trackId: track.id, laps: LAP_OPTIONS[track.id].includes(laps) ? laps : LAPS, vehicle: Object.hasOwn(VEHICLES, vehicle) ? vehicle : 'PULSE',
    ...sampleTrack(distance, slot % 2 ? 2 : -2, track), vx: 0, vz: 0, collisionTime: 0,
    speed: 0, charge: 50, boostTime: 0, boostHeld: false, boostPadInside: false, drifting: false, steer: 0, resetId: 0,
    startThrottleHeld: false, startBoosted: false, startBoostPending: false,
    lap: 0, checkpoint: 0, routeDistance: wrap(distance, track), routeProgress: distance,
    progress: distance, respawnDistance: distance, finished: false, finishTime: null,
    lastInputSeq: 0 };
}

export function updateStartBoost(car, pressed, raceTime) {
  const fresh = pressed && !car.startThrottleHeld;
  car.startThrottleHeld = pressed;
  if (!fresh || car.startBoosted || car.finished || !Number.isFinite(raceTime) || raceTime < -.2 || raceTime > .45) return false;
  car.startBoosted = car.startBoostPending = true;
  return true;
}

export function resetCar(car) {
  const track = TRACKS[car.trackId] || TRACK;
  car.resetId = (car.resetId || 0) + 1;
  Object.assign(car, sampleTrack(car.respawnDistance, 0, track), { vx: 0, vz: 0, speed: 0,
    boostTime: 0, boostPadInside: false, startBoostPending: false, collisionTime: 0, drifting: false, routeDistance: wrap(car.respawnDistance, track),
    routeProgress: car.respawnDistance });
  car.previousX = car.x; car.previousZ = car.z;
  return car;
}

function constrainToRoad(car) {
  const track = TRACKS[car.trackId] || TRACK;
  const road = nearestTrack(car.x, car.z, track);
  const limit = track.width / 2 - PHYSICS.radius;
  if (Math.abs(road.offset) <= limit) return false;
  const side = Math.sign(road.offset);
  const nx = Math.cos(road.yaw) * side, nz = Math.sin(road.yaw) * side;
  car.x = road.x + nx * limit;
  car.z = road.z + nz * limit;
  const outward = car.vx * nx + car.vz * nz;
  if (outward > 0) {
    const stats = vehicleStats(car);
    const tx = car.vx - nx * outward, tz = car.vz - nz * outward;
    const tangent = Math.hypot(tx, tz);
    const friction = tangent > 0 ? Math.max(0, 1 - stats.wallFriction * outward / tangent) : 0;
    car.vx = tx * friction - nx * outward * stats.wallRestitution;
    car.vz = tz * friction - nz * outward * stats.wallRestitution;
    if (outward > 1) car.collisionTime = stats.recovery;
  }
  return true;
}

export function stepCar(car, input = {}, dt = STEP, coasting = false) {
  dt = clamp(finite(dt), 0, 1 / 15);
  if (![car.x, car.z, car.yaw, car.vx, car.vz].every(Number.isFinite)) resetCar(car);
  const stats = vehicleStats(car);
  coasting ||= car.finished;
  if (coasting) { input = {}; car.boostTime = 0; car.startBoostPending = false; }
  car.previousX = car.x; car.previousZ = car.z;
  const throttle = clamp(finite(input.throttle), -1, 1);
  const steer = clamp(finite(input.steer), -1, 1);
  car.steer = steer;
  car.charge = clamp(finite(car.charge), 0, 100);
  car.boostTime = Math.max(0, finite(car.boostTime) - dt);
  car.collisionTime = Math.max(0, finite(car.collisionTime) - dt);
  if (input.reset) { resetCar(car); car.boostHeld = Boolean(input.boost); return car; }
  if (car.startBoostPending) { car.boostTime = Math.max(car.boostTime, BOOST_PAD.duration); car.startBoostPending = false; }
  if (input.boost && !car.boostHeld && car.charge >= stats.boostCost && car.boostTime === 0) {
    car.charge -= stats.boostCost;
    car.boostTime = stats.boostDuration;
  }
  car.boostHeld = Boolean(input.boost);
  let speed = car.vx * Math.sin(car.yaw) - car.vz * Math.cos(car.yaw);
  const road = nearestTrack(car.x, car.z, TRACKS[car.trackId] || TRACK);
  const insidePad = road.distance >= BOOST_PAD.distance && road.distance <= BOOST_PAD.distance + BOOST_PAD.length &&
    Math.abs(road.offset) <= BOOST_PAD.width / 2;
  if (!coasting && insidePad && !car.boostPadInside && speed > 8) car.boostTime = Math.max(car.boostTime, BOOST_PAD.duration);
  car.boostPadInside = insidePad;
  const recovering = car.collisionTime > 0;
  const acceleration = throttle >= 0 ? throttle * stats.acceleration
    : throttle * (speed > 0 ? stats.braking : stats.reverseAcceleration);
  const groundSpeed = Math.hypot(car.vx, car.vz);
  const drag = (groundSpeed * .21 + groundSpeed ** 2 * .003375) * stats.dragScale;
  const traction = stats.lateralAcceleration * Math.sqrt(stats.grip / PHYSICS.grip);
  let drive = (acceleration + (car.boostTime > 0 ? stats.boostAcceleration : 0)) * (recovering ? .15 : 1);
  if (!recovering && !coasting && drive * speed >= 0) {
    const cap = drive >= 0 ? car.boostTime > 0 ? stats.boostSpeed : stats.maxSpeed : stats.reverseSpeed;
    // A finite-response drivetrain governor lets tyre losses lower the cruising speed.
    drive = Math.sign(drive) * Math.min(Math.abs(drive), Math.max(0, drag + (cap - groundSpeed) * stats.speedResponse));
  }
  drive = clamp(drive, -traction, traction);
  const resistance = groundSpeed > 0 ? Math.max(0, 1 - drag * dt / groundSpeed) : 1;
  car.vx = car.vx * resistance + Math.sin(car.yaw) * drive * dt;
  car.vz = car.vz * resistance - Math.cos(car.yaw) * drive * dt;
  speed = car.vx * Math.sin(car.yaw) - car.vz * Math.cos(car.yaw);
  car.drifting = Boolean(input.drift) && speed > stats.driftMinSpeed && Math.abs(steer) > 0.15;
  // ponytail: point-mass tyres omit axle loads/yaw inertia; use a bicycle model if those become gameplay requirements.
  // Acceleration is calibrated to the game's speed/track scale, not measured real-kart grip.
  const lateral = Math.sqrt(Math.max(0, traction ** 2 - Math.min(Math.abs(drive), traction) ** 2));
  const requestedTurn = steer * stats.turnRate * Math.min(Math.abs(speed) / 16, 1) * Math.sign(speed);
  const turnLimit = lateral / Math.max(Math.hypot(car.vx, car.vz), .1);
  const turnAngle = (car.drifting || recovering ? requestedTurn : clamp(requestedTurn, -turnLimit, turnLimit)) * dt;
  car.yaw += turnAngle;
  car.yaw = Math.atan2(Math.sin(car.yaw), Math.cos(car.yaw));
  const forwardX = Math.sin(car.yaw), forwardZ = -Math.cos(car.yaw);
  // Rotate the coordinate frame, never the world momentum. Lateral friction only removes energy.
  speed = car.vx * forwardX + car.vz * forwardZ;
  const sideways = car.vx * Math.cos(car.yaw) + car.vz * Math.sin(car.yaw);
  const grip = recovering ? .8 : car.drifting ? stats.driftGrip : stats.grip * 4;
  // Express the already-applied drive in this frame so countersteering also respects the friction circle.
  const lateralDrive = -drive * Math.sin(turnAngle);
  const lateralBudget = Math.sqrt(Math.max(0, traction ** 2 - (drive * Math.cos(turnAngle)) ** 2));
  const slip = sideways + clamp(-sideways * (1 - Math.exp(-grip * dt)),
    (-lateralBudget - lateralDrive) * dt, (lateralBudget - lateralDrive) * dt);
  car.vx = forwardX * speed + Math.cos(car.yaw) * slip;
  car.vz = forwardZ * speed + Math.sin(car.yaw) * slip;
  if (car.drifting) {
    const friction = Math.exp(-stats.driftDrag * dt);
    car.vx *= friction; car.vz *= friction;
  }
  car.x += car.vx * dt; car.z += car.vz * dt;
  if (car.drifting) car.charge = Math.min(100, car.charge + stats.chargeRate * dt);
  constrainToRoad(car);
  car.speed = car.vx * forwardX + car.vz * forwardZ;
  if (coasting && Math.hypot(car.vx, car.vz) < .05) car.vx = car.vz = car.speed = 0;
  return car;
}

export function resolveCollisions(cars, dt = STEP) {
  // Finishers coast without becoming moving or invisible barriers for remaining racers.
  cars = cars.filter(car => !car.finished);
  dt = clamp(finite(dt), 0, 1 / 15);
  const stats = cars.map(vehicleStats);
  const boxes = cars.map(car => {
    const size = collisionBox(car.vehicle), s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    return { ...size, right: { x: c, z: s }, forward: { x: s, z: -c } };
  });
  const center = i => ({ x: cars[i].x + boxes[i].forward.x * boxes[i].offset,
    z: cars[i].z + boxes[i].forward.z * boxes[i].offset });
  const radius = (box, axis) => (Math.abs(box.right.x * axis.x + box.right.z * axis.z) * box.width +
    Math.abs(box.forward.x * axis.x + box.forward.z * axis.z) * box.length) / 2;
  function contact(i, j) {
    const a = center(i), b = center(j);
    let hit = null;
    for (const axis of [boxes[i].right, boxes[i].forward, boxes[j].right, boxes[j].forward]) {
      const distance = (b.x - a.x) * axis.x + (b.z - a.z) * axis.z;
      const depth = radius(boxes[i], axis) + radius(boxes[j], axis) - Math.abs(distance);
      if (depth < -1e-8) return null;
      if (!hit || depth < hit.depth) { const sign = distance < 0 ? -1 : 1; hit = { depth: Math.max(0, depth), nx: axis.x * sign, nz: axis.z * sign }; }
    }
    return hit;
  }
  const inverseMass = cars.map((car, i) => 1 / stats[i].mass);
  const motion = cars.map(car => {
    const x = finite(car.previousX, car.x), z = finite(car.previousZ, car.z);
    const velocity = { x: dt ? (car.x - x) / dt : 0, z: dt ? (car.z - z) / dt : 0 };
    if (dt) { car.x = x; car.z = z; }
    return velocity;
  });
  const impulse = (i, j, nx, nz) => {
    const a = cars[i], b = cars[j], total = inverseMass[i] + inverseMass[j];
    const closing = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
    if (!total || closing >= 0) return;
    const strength = -(1 + Math.min(stats[i].restitution, stats[j].restitution)) * closing / total;
    a.vx -= strength * inverseMass[i] * nx; a.vz -= strength * inverseMass[i] * nz;
    b.vx += strength * inverseMass[j] * nx; b.vz += strength * inverseMass[j] * nz;
    for (const k of [i, j]) if (inverseMass[k] && strength * inverseMass[k] > 1) {
      cars[k].collisionTime = stats[k].recovery;
    }
  };
  const advance = time => {
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      car.x += motion[i].x * time; car.z += motion[i].z * time;
      if (inverseMass[i] && constrainToRoad(car)) motion[i] = { x: car.vx, z: car.vz };
    }
  };
  // Sweep the four rectangle axes so fast bumper/corner contacts cannot tunnel.
  let remaining = dt;
  for (let event = 0; remaining > 1e-8 && event < 24; event++) {
    let hit = null, earliest = remaining;
    for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
      if (!inverseMass[i] && !inverseMass[j]) continue;
      const a = center(i), b = center(j), dx = b.x - a.x, dz = b.z - a.z;
      const vx = motion[j].x - motion[i].x, vz = motion[j].z - motion[i].z;
      if (contact(i, j)?.depth > 1e-6) continue;
      let entry = -Infinity, exit = remaining, normal = null;
      for (const axis of [boxes[i].right, boxes[i].forward, boxes[j].right, boxes[j].forward]) {
        const distance = dx * axis.x + dz * axis.z, velocity = vx * axis.x + vz * axis.z;
        const extent = radius(boxes[i], axis) + radius(boxes[j], axis);
        if (Math.abs(velocity) < 1e-8) { if (Math.abs(distance) > extent + 1e-8) { exit = -Infinity; break; } continue; }
        const t1 = (-extent - distance) / velocity, t2 = (extent - distance) / velocity;
        const first = Math.min(t1, t2);
        if (first > entry) {
          entry = first; const sign = distance + velocity * first < 0 ? -1 : 1;
          normal = { nx: axis.x * sign, nz: axis.z * sign };
        }
        exit = Math.min(exit, Math.max(t1, t2));
      }
      const time = Math.max(0, entry);
      if (normal && entry >= -1e-8 && time <= exit + 1e-8 && time <= earliest && vx * normal.nx + vz * normal.nz < -1e-8) {
        earliest = time; hit = { i, j, ...normal };
      }
    }
    advance(earliest); remaining -= earliest;
    if (!hit) break;
    const { i, j, nx, nz } = hit;
    impulse(i, j, nx, nz);
    for (const k of [i, j]) motion[k] = { x: cars[k].vx, z: cars[k].vz };
  }
  // ponytail: six pairs and bounded iterations suit four cars. Use a contact solver for larger rooms.
  // An exhausted sweep budget stops movement for this tick rather than tunneling through a pileup.
  for (let iteration = 0; iteration < 64; iteration++) {
    let overlap = 0, wallMoved = false;
    for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i], b = cars[j], total = inverseMass[i] + inverseMass[j];
      const hit = contact(i, j);
      if (!total || !hit) continue;
      const { nx, nz, depth: separation } = hit;
      overlap = Math.max(overlap, separation);
      a.x -= nx * separation * inverseMass[i] / total; a.z -= nz * separation * inverseMass[i] / total;
      b.x += nx * separation * inverseMass[j] / total; b.z += nz * separation * inverseMass[j] / total;
      impulse(i, j, nx, nz);
    }
    for (let i = 0; i < cars.length; i++) if (inverseMass[i]) wallMoved = constrainToRoad(cars[i]) || wallMoved;
    if (overlap < 1e-5 && !wallMoved) break;
  }
  for (const car of cars) {
    car.speed = car.vx * Math.sin(car.yaw) - car.vz * Math.cos(car.yaw);
    car.previousX = car.x; car.previousZ = car.z;
  }
}

export function updateProgress(car) {
  if (car.finished) return car;
  const track = TRACKS[car.trackId] || TRACK;
  const road = nearestTrack(car.x, car.z, track);
  let delta = road.distance - car.routeDistance;
  if (delta > track.length / 2) delta -= track.length;
  if (delta < -track.length / 2) delta += track.length;
  car.routeDistance = road.distance;
  if (Math.abs(delta) > PHYSICS.maxProgressStep || Math.abs(road.offset) > track.width / 2) return car;
  car.routeProgress += delta;
  car.progress = Math.max(car.progress, car.routeProgress);
  const spacing = track.length / PHYSICS.checkpoints;
  while (delta > 0 && car.routeProgress >= (car.checkpoint + 1) * spacing) {
    car.checkpoint++;
    car.respawnDistance = car.checkpoint * spacing - 3;
    car.lap = Math.floor(car.checkpoint / PHYSICS.checkpoints);
    if (car.lap >= (car.laps ?? LAPS)) { car.finished = true; break; }
  }
  return car;
}
