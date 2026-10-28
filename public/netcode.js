import { STEP, stepCar, resolveCollisions, updateProgress } from '../shared/game.js';

const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
function predict(car, command, others) {
  stepCar(car, command, STEP);
  for (const peer of others) {
    peer.previousX = peer.x; peer.previousZ = peer.z;
    if (peer.finished) stepCar(peer, {}, STEP);
    else { peer.x += peer.vx * STEP; peer.z += peer.vz * STEP; }
  }
  resolveCollisions([car, ...others], STEP);
  const finished = car.finished;
  updateProgress(car);
  // Predict checkpoint/respawn state; only a server snapshot may confirm a finish.
  car.finished = finished;
}

export class LocalPrediction {
  constructor() { this.reset(); }
  reset() {
    this.car = null; this.previous = null; this.others = []; this.previousOthers = []; this.pending = []; this.outbox = [];
    this.seq = 0; this.raceId = null; this.phase = null; this.tick = -1; this.error = { x: 0, z: 0, yaw: 0 };
    this.corrections = [];
    this.time = null; this.accumulator = 0;
  }
  neutral() { this.pending = []; this.outbox = []; this.previous = this.car && { ...this.car };
    this.previousOthers = this.others.map(car => ({ ...car })); this.time = null; this.accumulator = 0; }
  get alpha() { return this.accumulator / STEP; }
  advance(now, input) {
    now = Math.max(now, this.time ?? now);
    const elapsed = this.time === null ? 0 : Math.min((now - this.time) / 1000, .25);
    this.time = now;
    const coasting = this.car && (this.car.finished || this.phase === 'finished');
    if (!this.car || (!input && !coasting)) { this.accumulator = 0; return 0; }
    this.accumulator += elapsed;
    let steps = 0;
    while (this.accumulator >= STEP) {
      if (coasting) { this.previous = { ...this.car }; stepCar(this.car, {}, STEP, true); }
      else this.step(input);
      this.accumulator -= STEP; steps++;
    }
    return steps;
  }
  receive(snapshot, id, alpha = 1) {
    if (snapshot.raceId !== this.raceId) { this.reset(); this.raceId = snapshot.raceId; }
    if (snapshot.tick <= this.tick) return false;
    this.tick = snapshot.tick;
    this.phase = snapshot.phase;
    const own = snapshot.cars.find(car => car.id === id);
    if (!own) { this.car = null; this.neutral(); return true; }
    const oldPhysical = this.car, old = this.car && this.visual(0, alpha);
    const oldOthers = this.others, oldPreviousOthers = this.previousOthers;
    const interval = this.car && this.previous && { x: this.car.x - this.previous.x, z: this.car.z - this.previous.z,
      yaw: angleDelta(this.previous.yaw, this.car.yaw) };
    this.pending = snapshot.phase === 'racing' && !own.finished ? this.pending.filter(command => command.seq > own.lastInputSeq) : [];
    this.outbox = snapshot.phase === 'racing' && !own.finished ? this.outbox.filter(command => command.seq > own.lastInputSeq) : [];
    this.seq = Math.max(this.seq, own.lastInputSeq);
    this.car = { ...own }; this.others = snapshot.cars.filter(car => car.id !== id).map(car => ({ ...car }));
    this.previousOthers = this.others.map(peer => {
      const old = oldOthers.find(car => car.id === peer.id), from = oldPreviousOthers.find(car => car.id === peer.id);
      if (this.pending.length || !old || !from || old.resetId !== peer.resetId || old.finished !== peer.finished) return { ...peer };
      return { ...peer, x: peer.x - (old.x - from.x), z: peer.z - (old.z - from.z),
        yaw: peer.yaw - angleDelta(from.yaw, old.yaw) };
    });
    this.previous = { ...this.car };
    // An ACK with no replay must not flatten the last local render interval.
    if (!this.pending.length && interval) Object.assign(this.previous, {
      x: this.car.x - interval.x, z: this.car.z - interval.z, yaw: this.car.yaw - interval.yaw });
    for (const command of this.pending) {
      this.previous = { ...this.car }; this.previousOthers = this.others.map(car => ({ ...car }));
      predict(this.car, command, this.others);
    }
    if (oldPhysical && snapshot.phase === 'racing' && oldPhysical.resetId === this.car.resetId) {
      this.corrections.push(Math.hypot(oldPhysical.x - this.car.x, oldPhysical.z - this.car.z));
      if (this.corrections.length > 120) this.corrections.shift();
    }
    const smooth = old && ['racing', 'finished'].includes(snapshot.phase) && old.resetId === this.car.resetId &&
      !this.pending.some(command => command.reset) && Math.hypot(oldPhysical.x - this.car.x, oldPhysical.z - this.car.z) < 5;
    this.error = { x: 0, z: 0, yaw: 0 };
    if (!smooth) { this.previous = { ...this.car }; this.previousOthers = this.others.map(car => ({ ...car })); }
    else {
      const shown = this.visual(0, alpha);
      this.error = { x: old.x - shown.x, z: old.z - shown.z, yaw: angleDelta(shown.yaw, old.yaw) };
    }
    return true;
  }
  step(input) {
    if (!this.car || this.car.finished || this.phase === 'finished') return null;
    if (this.pending.length >= 120) { this.previous = { ...this.car }; this.previousOthers = this.others.map(car => ({ ...car })); return null; }
    const command = { seq: ++this.seq, throttle: input.throttle || 0, steer: input.steer || 0,
      drift: Boolean(input.drift), boost: Boolean(input.boost), reset: Boolean(input.reset) };
    this.previous = { ...this.car };
    this.previousOthers = this.others.map(car => ({ ...car }));
    this.pending.push(command); this.outbox.push(command); predict(this.car, command, this.others);
    if (this.previous.resetId !== this.car.resetId) {
      this.previous = { ...this.car }; this.previousOthers = this.others.map(car => ({ ...car })); this.error = { x: 0, z: 0, yaw: 0 };
    }
    return command;
  }
  drain() { return this.outbox.splice(0, 8); }
  visual(dt, alpha = 1) {
    if (!this.car) return null;
    const decay = Math.exp(-dt / .1);
    for (const axis of ['x', 'z', 'yaw']) this.error[axis] *= decay;
    alpha = Math.max(0, Math.min(1, alpha));
    const from = this.previous || this.car;
    return { ...this.car, x: from.x + (this.car.x - from.x) * alpha + this.error.x,
      z: from.z + (this.car.z - from.z) * alpha + this.error.z,
      yaw: from.yaw + angleDelta(from.yaw, this.car.yaw) * alpha + this.error.yaw };
  }
}

export class SnapshotBuffer {
  constructor() { this.reset(); }
  reset() { this.frames = []; this.offsets = []; this.raceId = null; this.cursor = -Infinity; }
  push(snapshot, receivedAt) {
    if (snapshot.raceId !== this.raceId) { this.reset(); this.raceId = snapshot.raceId; }
    if (this.frames.length && snapshot.tick <= this.frames.at(-1).tick) return false;
    const time = snapshot.stateTime ?? snapshot.tick * STEP * 1000;
    if (!['racing', 'finished'].includes(snapshot.phase)) { this.frames = []; this.offsets = []; this.cursor = -Infinity; }
    this.frames.push({ tick: snapshot.tick, time, cars: snapshot.cars.map(car => ({ ...car })) });
    this.offsets.push(receivedAt - (snapshot.serverNow ?? time));
    if (this.frames.length > 32) this.frames.shift();
    if (this.offsets.length > 32) this.offsets.shift();
    return true;
  }
  sample(now, prediction = null, alpha = 1) {
    if (!this.frames.length) return [];
    const latest = this.frames.at(-1);
    // ponytail: 100 ms covers two 20 Hz updates; adapt only after measured LAN jitter needs it.
    this.cursor = Math.max(this.cursor, Math.min(latest.time, now - Math.min(...this.offsets) - 100));
    let a = this.frames[0], b = a;
    for (const frame of this.frames) {
      if (frame.time <= this.cursor) a = frame;
      b = frame; if (frame.time >= this.cursor) break;
    }
    const t = a === b ? 1 : Math.max(0, Math.min(1, (this.cursor - a.time) / (b.time - a.time)));
    alpha = Math.max(0, Math.min(1, alpha));
    const local = prediction?.car && !prediction.car.finished ? prediction.visual(0, alpha) : null;
    return latest.cars.map(current => {
      const from = a.cars.find(car => car.id === current.id), to = b.cars.find(car => car.id === current.id);
      const discontinuity = from && to && (from.resetId !== to.resetId || from.finished !== to.finished || Math.hypot(from.x - to.x, from.z - to.z) > 8);
      let shown = { ...current };
      if (from && to) {
        shown = discontinuity ? { ...(t < 1 ? from : to) }
          : { ...(t < 1 ? from : to), x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t,
            yaw: from.yaw + angleDelta(from.yaw, to.yaw) * t, steer: from.steer + (to.steer - from.steer) * t };
      }
      const peer = local && prediction.others.find(car => car.id === current.id);
      if (!peer) return shown;
      const previous = prediction.previousOthers.find(car => car.id === peer.id) || peer;
      const dx = previous.x + (peer.x - previous.x) * alpha - (local.x - prediction.error.x);
      const dz = previous.z + (peer.z - previous.z) * alpha - (local.z - prediction.error.z);
      // Share the local render correction so touching cars keep their relative poses.
      const c = Math.cos(prediction.error.yaw), s = Math.sin(prediction.error.yaw);
      const x = local.x + dx * c - dz * s, z = local.z + dx * s + dz * c;
      const yaw = previous.yaw + angleDelta(previous.yaw, peer.yaw) * alpha + prediction.error.yaw;
      const distance = Math.min(Math.hypot(dx, dz), Math.hypot(shown.x - local.x, shown.z - local.z));
      // ponytail: 8-16 m suits current car sizes/speeds; widen if faster cars are added.
      let blend = Math.max(0, Math.min(1, (16 - distance) / 8));
      if (!blend) return shown;
      if (discontinuity || shown.resetId !== peer.resetId || shown.finished !== peer.finished ||
          Math.hypot(shown.x - current.x, shown.z - current.z) > 8) blend = 1;
      return { ...peer, x: shown.x + (x - shown.x) * blend, z: shown.z + (z - shown.z) * blend,
        yaw: shown.yaw + angleDelta(shown.yaw, yaw) * blend };
    });
  }
}
