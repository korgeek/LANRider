import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { createGameServer } from '../server.js';
import { LocalPrediction, SnapshotBuffer } from '../public/netcode.js';
import { nearestTrack, sampleTrack } from '../shared/game.js';

test('production prediction survives 0/140/260 ms simulated round trips and jitter over real WebSockets', { timeout: 14000 }, async t => {
  const results = await Promise.all([0, 60, 120].map(async delay => {
    const server = await createGameServer({ port: 0, host: '127.0.0.1' });
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    const prediction = new LocalPrediction(), snapshots = new SnapshotBuffer(), timers = new Set();
    let id, latest, pendingSnapshot, racing, rejectRace, outboundAt = 0, inboundAt = 0, packet = 0;
    let simulation, flush, measuring = true, firstMotion = null, firstAck = null, maximumPending = 0, maxCorrection = 0;
    const ready = new Promise((resolve, reject) => { racing = resolve; rejectRace = reject; });
    const later = (callback, wait) => { const timer = setTimeout(() => { timers.delete(timer); callback(); }, wait); timers.add(timer); };
    function send(message) {
      const now = performance.now();
      outboundAt = Math.max(outboundAt, now + delay + (delay ? [0, 15, -5, 10][packet++ % 4] : 0));
      later(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }, Math.max(0, outboundAt - now));
    }
    const deadline = setTimeout(() => rejectRace(new Error('Race did not start')), 6500);
    socket.on('error', rejectRace);
    socket.on('message', data => {
      const message = JSON.parse(data), now = performance.now();
      if (message.type === 'welcome') { id = message.id; send({ type: 'create', name: `Latency ${delay}` }); }
      if (message.type === 'room' && message.phase === 'lobby') send({ type: 'start' });
      if (message.type === 'error') rejectRace(new Error(message.message));
      if (message.type !== 'snapshot') return;
      inboundAt = Math.max(inboundAt, now + delay + (delay ? [15, -5, 20, 0][packet++ % 4] : 0));
      later(() => {
        latest = message; pendingSnapshot = message; snapshots.push(message, performance.now());
        if (message.cars[0].lastInputSeq && firstAck === null) firstAck = performance.now();
        if (message.phase === 'racing') { clearTimeout(deadline); racing(); }
      }, Math.max(0, inboundAt - now));
    });
    try {
      await ready;
      const start = performance.now();
      prediction.receive(pendingSnapshot, id, 0); pendingSnapshot = null;
      prediction.advance(start, { throttle: 1, steer: 0 });
      simulation = setInterval(() => {
        const now = performance.now(), controls = { throttle: 1, steer: 0 }, car = prediction.car;
        if (car) {
          const road = nearestTrack(car.x, car.z);
          const target = sampleTrack(road.distance + Math.max(8, Math.abs(car.speed) * .55));
          const yaw = Math.atan2(target.x - car.x, -(target.z - car.z));
          const error = Math.atan2(Math.sin(yaw - car.yaw), Math.cos(yaw - car.yaw));
          controls.steer = Math.max(-1, Math.min(1, error * 2.5));
        }
        prediction.advance(now, controls);
        if (firstMotion === null && prediction.car?.speed > .1) firstMotion = performance.now();
        maximumPending = Math.max(maximumPending, prediction.pending.length);
        if (pendingSnapshot) {
          const before = prediction.car && { ...prediction.car };
          prediction.receive(pendingSnapshot, id, prediction.alpha);
          if (measuring && before && pendingSnapshot.phase === 'racing') maxCorrection = Math.max(maxCorrection, Math.hypot(before.x - prediction.car.x, before.z - prediction.car.z));
          pendingSnapshot = null;
        }
        snapshots.sample(now); prediction.visual(.008, prediction.alpha);
      }, 8);
      flush = setInterval(() => { const commands = prediction.drain(); if (commands.length) send({ type: 'inputs', raceId: latest.raceId, commands }); }, 1000 / 30);
      await new Promise(resolve => later(resolve, 2600));
      measuring = false; clearInterval(simulation); clearInterval(flush); prediction.neutral(); send({ type: 'neutral', raceId: latest.raceId });
      await new Promise(resolve => later(resolve, delay * 2 + 400));
      assert.ok(firstMotion - start < 60, `local motion starts on the first simulation step: ${firstMotion - start} ms`);
      assert.ok(firstAck > firstMotion, 'movement precedes server acknowledgement');
      assert.ok(maximumPending < 60 && prediction.pending.length === 0, 'history drains after a neutral barrier');
      assert.ok(prediction.car.lastInputSeq > 80, 'server actually consumes the command stream');
      assert.ok(maxCorrection < 5, `ordinary updates should not need hard correction: ${maxCorrection}`);
      return { simulatedDelayPerWay: delay, localMotionMs: +(firstMotion - start).toFixed(1), firstAckMs: +(firstAck - start).toFixed(1), maximumPending, maxCorrectionM: +maxCorrection.toFixed(3) };
    } finally {
      clearTimeout(deadline); clearInterval(simulation); clearInterval(flush);
      for (const timer of timers) clearTimeout(timer);
      socket.terminate(); await new Promise(resolve => server.close(resolve));
    }
  }));
  for (const result of results) t.diagnostic(JSON.stringify(result));
});

test('prediction recovers after a 900 ms application-level input/snapshot blackout', { timeout: 13000 }, async t => {
  const server = await createGameServer({ port: 0, host: '127.0.0.1' });
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const prediction = new LocalPrediction(), snapshots = new SnapshotBuffer();
  let id, latest, pendingSnapshot, simulation, flush, interrupted = false, maximumPending = 0;
  const errors = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const send = message => socket.send(JSON.stringify(message));
  async function until(predicate) {
    const deadline = performance.now() + 5500;
    while (!predicate()) {
      assert.ok(performance.now() < deadline, `blackout recovery deadline: ${JSON.stringify({ seq: prediction.seq,
        ack: prediction.car?.lastInputSeq, pending: prediction.pending.length, outbox: prediction.outbox.length, maximumPending, errors })}`);
      await pause(10);
    }
  }
  socket.on('message', data => {
    const message = JSON.parse(data);
    if (message.type === 'welcome') { id = message.id; send({ type: 'create' }); }
    if (message.type === 'room' && message.phase === 'lobby') send({ type: 'start' });
    if (message.type === 'error') errors.push(message.message);
    if (message.type !== 'snapshot') return;
    latest = message;
    if (!interrupted) { pendingSnapshot = message; snapshots.push(message, performance.now()); }
  });
  try {
    await until(() => latest?.phase === 'racing');
    simulation = setInterval(() => {
      const now = performance.now(), controls = { throttle: 1, steer: 0 };
      if (prediction.car) {
        const car = prediction.car, road = nearestTrack(car.x, car.z), target = sampleTrack(road.distance + Math.max(8, Math.abs(car.speed) * .55));
        const yaw = Math.atan2(target.x - car.x, -(target.z - car.z)), turn = Math.atan2(Math.sin(yaw - car.yaw), Math.cos(yaw - car.yaw));
        controls.steer = Math.max(-1, Math.min(1, turn * 2.5));
      }
      prediction.advance(now, controls);
      maximumPending = Math.max(maximumPending, prediction.pending.length);
      if (pendingSnapshot) { prediction.receive(pendingSnapshot, id, prediction.alpha); pendingSnapshot = null; }
      prediction.visual(.008, prediction.alpha); snapshots.sample(now);
    }, 8);
    flush = setInterval(() => {
      if (interrupted) return;
      const commands = prediction.drain();
      if (commands.length) send({ type: 'inputs', raceId: latest.raceId, commands });
    }, 1000 / 30);
    await until(() => prediction.car?.lastInputSeq >= 30);
    interrupted = true;
    const beforeAck = prediction.car.lastInputSeq;
    await pause(350);
    const frozen = snapshots.sample(performance.now())[0], physical = { ...prediction.car };
    await pause(550);
    const stillFrozen = snapshots.sample(performance.now())[0];
    assert.equal(stillFrozen.x, frozen.x); assert.equal(stillFrozen.z, frozen.z);
    assert.ok(Math.hypot(prediction.car.x - physical.x, prediction.car.z - physical.z) > .5, 'local prediction keeps moving without replies');
    assert.ok(prediction.pending.length >= 40 && prediction.pending.length <= 120);
    interrupted = false;
    await until(() => prediction.car.lastInputSeq >= beforeAck + 80 && prediction.pending.length < 12);
    const recoveredAck = prediction.car.lastInputSeq;
    assert.ok([prediction.car.x, prediction.car.z, prediction.car.vx, prediction.car.vz].every(Number.isFinite));
    clearInterval(simulation); clearInterval(flush); prediction.neutral(); send({ type: 'neutral', raceId: latest.raceId });
    await pause(250);
    assert.equal(prediction.pending.length, 0); assert.equal(prediction.outbox.length, 0); assert.deepEqual(errors, []);
    t.diagnostic(JSON.stringify({ blackoutMs: 900, maximumPending, beforeAck, recoveredAck, recovered: true }));
  } finally {
    clearInterval(simulation); clearInterval(flush); socket.terminate(); await new Promise(resolve => server.close(resolve));
  }
});
