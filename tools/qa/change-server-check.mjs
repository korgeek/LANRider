// Slow integration check: node tools/qa/change-server-check.mjs [--dnf] (about two minutes).
// Drives real production physics through WebSockets; no state hooks or modified constants.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createGameServer } from '../../server.js';
import { nearestTrack, sampleTrack } from '../../shared/game.js';

const server = await createGameServer({ port: 0, host: '127.0.0.1' });
const sockets = [];
const dnf = process.argv.includes('--dnf');
const emptyGrid = process.argv.includes('--empty-grid');
const autoTimeout = process.argv.includes('--auto-timeout');
let driving;
async function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  sockets.push(socket);
  const client = { socket, messages: [], seq: 0, active: true, send: message => socket.send(JSON.stringify(message)) };
  const waiting = new Set();
  socket.on('message', data => {
    const message = JSON.parse(data);
    client.messages.push(message);
    if (message.type === 'snapshot') client.latest = message;
    for (const check of [...waiting]) check();
  });
  client.next = (predicate, after = 0, timeout = 160000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(check); reject(new Error('Integration check timed out')); }, timeout);
    function check() {
      const message = client.messages.slice(after).find(predicate);
      if (message) { clearTimeout(timer); waiting.delete(check); resolve(message); }
    }
    waiting.add(check); check();
  });
  client.id = (await client.next(message => message.type === 'welcome')).id;
  return client;
}
try {
  const [host, peer] = await Promise.all([connect(), connect()]);
  host.send({ type: 'create', name: 'Winner\u0000', vehicle: 'PULSE' });
  const room = await host.next(message => message.type === 'room');
  const initial = await host.next(message => message.type === 'snapshot');
  assert.equal(initial.raceId, 0);
  assert.deepEqual(initial.finishers, []);
  peer.send({ type: 'join', code: room.code, name: 'Observer', vehicle: 'BULWARK' });
  await peer.next(message => message.type === 'room');
  peer.send({ type: 'ready', ready: true });
  await host.next(message => message.type === 'room' && message.players.length === 2 && message.players.every(player => player.ready));
  const tail = dnf && !emptyGrid ? await connect() : null;
  if (tail) {
    tail.send({ type: 'join', code: room.code, name: 'Tail', vehicle: 'PULSE' });
    await tail.next(message => message.type === 'room');
    tail.send({ type: 'ready', ready: true });
    await host.next(message => message.type === 'room' && message.players.length === 3 && message.players.every(player => player.ready));
  }
  host.send({ type: 'start' });
  const countdown = await host.next(message => message.type === 'snapshot' && message.phase === 'countdown');
  assert.equal(countdown.raceId, 1);
  const watchers = await Promise.all(Array.from({ length: 4 }, () => connect()));
  for (const [index, watcher] of watchers.entries()) {
    watcher.send({ type: 'join', wait: true, code: room.code, name: `Queued ${index}`, vehicle: index % 2 ? 'COMET' : 'RALLY' });
    await watcher.next(message => message.type === 'room' && message.waiting.some(player => player.id === watcher.id));
    watcher.send({ type: 'ready', ready: true });
    await watcher.next(message => message.type === 'room' && message.waiting.find(player => player.id === watcher.id)?.ready);
  }
  driving = setInterval(() => {
    for (const [index, client] of [host, peer].entries()) {
      const state = client.latest;
      if (!client.active || state?.phase !== 'racing' || (index === 1 && (emptyGrid || state.raceTime < 6 || (dnf && state.raceTime > 8)))) continue;
      const car = state.cars.find(car => car.id === client.id);
      if (!car || car.finished) continue;
      const road = nearestTrack(car.x, car.z);
      const target = sampleTrack(road.distance + Math.max(8, Math.abs(car.speed) * 0.55), index ? 1.5 : -1.5);
      const targetYaw = Math.atan2(target.x - car.x, -(target.z - car.z));
      const angle = Math.atan2(Math.sin(targetYaw - car.yaw), Math.cos(targetYaw - car.yaw));
      client.send({ type: 'input', raceId: state.raceId, seq: ++client.seq, throttle: Math.abs(angle) > 0.6 ? 0.55 : 1,
        steer: Math.max(-1, Math.min(1, angle * 2.5)), vehicle: 'IGNIS', mass: 100000, name: 'Spoofed', finishTime: -1 });
    }
  }, 50);
  const won = await host.next(message => message.type === 'snapshot' && message.finishers.some(finisher => finisher.id === host.id));
  const same = await peer.next(message => message.type === 'snapshot' && message.tick === won.tick);
  assert.deepEqual(same.finishers, won.finishers, 'all peers receive the same finish event');
  assert.equal(won.finishers[0].name, 'Winner', 'finish name comes from sanitized server membership');
  assert.ok(won.finishers[0].finishTime > 0);
  assert.ok(won.phase === 'finished' ? won.finishRemaining === 0 : won.finishRemaining > 9.8 && won.finishRemaining <= 10,
    'remaining drivers get a ten-second deadline; a completed grid ends immediately');
  assert.equal(won.cars.find(car => car.id === host.id).lap, 3);
  assert.equal(won.cars.find(car => car.id === host.id).vehicle, 'PULSE');
  assert.equal(won.cars.find(car => car.id === peer.id).vehicle, 'BULWARK');
  host.active = false;
  const finishPose = won.cars.find(car => car.id === host.id), finishMark = host.messages.length;
  host.send({ type: 'input', raceId: won.raceId, seq: ++host.seq, throttle: 1, steer: 1, boost: true, drift: true, reset: true });
  const afterFinishInput = await host.next(message => message.type === 'snapshot' && message.tick > won.tick + 3, finishMark);
  const coasting = afterFinishInput.cars.find(car => car.id === host.id);
  for (const key of ['yaw', 'resetId', 'finishTime', 'lap', 'progress']) assert.equal(coasting[key], finishPose[key], `finished record changed ${key}`);
  assert.ok(Math.hypot(coasting.x - finishPose.x, coasting.z - finishPose.z) > 0, 'a finisher keeps rolling');
  assert.ok(coasting.speed > 0 && coasting.speed < finishPose.speed, 'finish inputs cannot accelerate or abruptly stop the car');
  host.send({ type: 'leave' });
  if (emptyGrid) {
    peer.active = false;
    peer.send({ type: 'leave' });
    const waitingRoom = await watchers[0].next(message => message.type === 'room' && !message.players.some(player => player.id === host.id || player.id === peer.id), 0, 2000);
    assert.ok(['racing', 'finished'].includes(waitingRoom.phase), 'departed racers preserve their results while the empty grid ends');
    watchers[0].send({ type: 'list' });
    const directory = await watchers[0].next(message => message.type === 'rooms');
    assert.equal(directory.rooms.find(entry => entry.code === room.code).hostName, 'Queued 0');
  }
  const observer = emptyGrid ? watchers[0] : peer;
  const survivor = await observer.next(message => message.type === 'snapshot' && message.tick > won.tick &&
    (message.phase === 'finished' || !message.cars.some(car => car.id === host.id)));
  assert.deepEqual(survivor.finishers.slice(0, won.finishers.length), won.finishers, 'finish event survives removal of its car');
  const finished = await observer.next(message => message.type === 'snapshot' && message.phase === 'finished');
  assert.equal(finished.finishers.length, dnf || emptyGrid ? 1 : 2);
  assert.deepEqual(finished.finishers[0], won.finishers[0]);
  assert.equal(new Set(finished.finishers.map(finisher => finisher.id)).size, finished.finishers.length, 'each car finishes once');
  if (!emptyGrid) assert.equal(finished.standings.find(car => car.id === peer.id).dnf, dnf);
  assert.equal(finished.standings.find(car => car.id === host.id).rank, 1, 'departed winner keeps first place in final results');
  if (!emptyGrid) assert.equal(finished.standings.find(car => car.id === peer.id).rank, 2);
  if (tail) {
    assert.equal(finished.standings.find(car => car.id === tail.id).rank, 3);
    assert.ok(finished.cars.find(car => car.id === peer.id).progress > finished.cars.find(car => car.id === tail.id).progress, 'non-finishers are ordered by actual progress');
  }
  assert.equal(finished.finishRemaining, 0);
  const finishDelay = finished.raceTime - won.finishers[0].finishTime;
  assert.ok(finishDelay >= (dnf && !emptyGrid ? 10 : 0) && finishDelay < 10.1);
  assert.equal(finished.raceId, 1);
  const rotated = await watchers[0].next(message => message.type === 'room' && message.phase === 'finished');
  assert.deepEqual(rotated.players.map(player => player.id), watchers.map(watcher => watcher.id), 'waiting drivers get next grid before previous racers');
  assert.equal(rotated.hostId, watchers[0].id, 'host migrates when previous host is not in the next grid');
  if (!emptyGrid) {
    assert.equal(rotated.waiting[0].id, peer.id);
    assert.equal(rotated.waiting[0].ready, false);
  }
  assert.ok(rotated.racePlayers.some(player => player.id === peer.id), 'finished roster remains available after rotation');
  assert.deepEqual((await watchers[0].next(message => message.type === 'snapshot' && message.phase === 'finished')).standings, finished.standings);
  const vehicleMark = watchers[0].messages.length;
  watchers[0].send({ type: 'vehicle', vehicle: 'BOLT' });
  const changedVehicle = await watchers[0].next(message => message.type === 'room' && message.players.find(player => player.id === watchers[0].id)?.vehicle === 'BOLT', vehicleMark);
  assert.equal(changedVehicle.players.find(player => player.id === watchers[0].id).ready, false, 'new host has time to choose a vehicle before starting the rematch timer');
  const unchangedResults = await watchers[0].next(message => message.type === 'snapshot' && message.phase === 'finished', vehicleMark);
  const records = cars => cars.map(({ id, vehicle, finished, finishTime, progress, lap, checkpoint, resetId }) =>
    ({ id, vehicle, finished, finishTime, progress, lap, checkpoint, resetId }));
  assert.deepEqual(records(unchangedResults.cars), records(finished.cars), 'next vehicle selection must not overwrite completed records');
  const rejoinMark = host.messages.length;
  host.send({ type: 'join', wait: true, code: room.code, name: 'Returned', vehicle: 'PULSE' });
  await host.next(message => message.type === 'room' && message.waiting.some(player => player.id === host.id), rejoinMark);
  host.send({ type: 'ready', ready: true });
  await host.next(message => message.type === 'room' && message.waiting.find(player => player.id === host.id)?.ready, rejoinMark);
  const restartMark = observer.messages.length;
  if (autoTimeout) {
    watchers[1].send({ type: 'ready', ready: false });
    await watchers[0].next(message => message.type === 'room' && message.players.find(player => player.id === watchers[1].id)?.ready === false, watchers[0].messages.length - 1);
  }
  const readyAt = performance.now();
  watchers[0].send({ type: 'ready', ready: true });
  if (autoTimeout) {
    const timer = await observer.next(message => message.type === 'snapshot' && message.readyRemaining > 9.8, restartMark);
    assert.equal(timer.phase, 'finished');
    const changeMark = watchers[0].messages.length;
    watchers[0].send({ type: 'vehicle', vehicle: 'BOLT' });
    await watchers[0].next(message => message.type === 'room' && message.phase === 'finished' && message.players[0].ready, changeMark);
  }
  const restarted = await observer.next(message => message.type === 'snapshot' && message.phase === 'countdown', restartMark);
  assert(autoTimeout ? performance.now() - readyAt >= 9900 : performance.now() - readyAt < 2000, 'rematch honors the deadline or starts early when all ready');
  assert.equal(restarted.raceId, 2);
  assert.deepEqual(restarted.finishers, []);
  for (const [index, client] of watchers.entries()) {
    const car = restarted.cars.find(car => car.id === client.id);
    assert.equal(car.vehicle, index === 0 ? 'BOLT' : index % 2 ? 'COMET' : 'RALLY');
    assert.equal(car.finished, false);
    assert.equal(car.finishTime, null);
    assert.equal(car.mass, undefined, 'input mass never becomes authoritative state');
  }
  assert.ok(!restarted.cars.some(car => car.id === peer.id || car.id === host.id), 'queued spectators never become racing cars early');
  const nextRace = await watchers[0].next(message => message.type === 'snapshot' && message.phase === 'racing' && message.raceId === 2);
  const nextMark = watchers[0].messages.length;
  watchers[0].send({ type: 'inputs', raceId: 1, commands: [{ seq: 999, throttle: 1 }] });
  await watchers[0].next(message => message.type === 'error' && message.message === 'Stale race input.', nextMark);
  watchers[0].send({ type: 'inputs', raceId: 2, commands: [{ seq: 1, throttle: 1 }] });
  const nextMoved = await watchers[0].next(message => message.type === 'snapshot' && message.tick > nextRace.tick && message.cars.find(car => car.id === watchers[0].id)?.lastInputSeq === 1, nextMark);
  assert.ok(nextMoved.cars.find(car => car.id === watchers[0].id).speed > 0);
  console.log(`PASS: real three-lap finish at ${won.finishers[0].finishTime.toFixed(2)}s; ${emptyGrid ? 'empty grid retains 10s countdown and winner' : dnf ? '10s finish deadline and progress ranking' : 'second racer finish'}; finished reset ignored; winner rank survives leave; four ready spectators rotate, host migrates, results persist, and the next race accepts fresh inputs while rejecting old commands.`);
} finally {
  clearInterval(driving);
  for (const socket of sockets) socket.terminate();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
