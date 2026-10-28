import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, WebSocket } from 'ws';
import { STEP, VERSION, MAX_SPECTATORS, TRACKS, LAP_OPTIONS, VEHICLES, createCar, stepCar, resolveCollisions, updateProgress, updateStartBoost } from './shared/game.js';
import { validEnvironment, cleanEnvironment, skyTime, TIMES_OF_DAY } from './shared/sky.js';
import { MUSIC_TRACKS, validMusic } from './shared/music.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.glb': 'model/gltf-binary', '.png': 'image/png',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

async function serve(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return;
  }
  try {
    const pathname = decodeURIComponent(request.url.split('?')[0]);
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part === '.')) {
      response.writeHead(403).end(); return;
    }
    if (pathname === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ ok: true })); return;
    }
    let base, relative;
    const roomLink = /^\/[a-f0-9]{6}\/?$/i.test(pathname);
    if (roomLink || ['/', '/main.js', '/scene.js', '/beach.js', '/models.js', '/driver-motion.js', '/night-lights.js', '/session.js', '/netcode.js', '/i18n.js', '/sky.js', '/environment.js', '/audio.js', '/engine-audio.js', '/music.js', '/audio-mix.js', '/style.css'].includes(pathname)) {
      base = path.join(ROOT, 'public'); relative = pathname === '/' || roomLink ? 'index.html' : pathname.slice(1);
    } else if (['/shared/game.js', '/shared/sky.js', '/shared/sky-locations.js', '/shared/music.js'].includes(pathname)) {
      base = path.join(ROOT, 'shared'); relative = pathname.slice('/shared/'.length);
    } else if (pathname === '/vendor/suncalc/index.js') {
      base = path.join(ROOT, 'node_modules/suncalc'); relative = 'index.js';
    } else if (pathname.startsWith('/assets/')) {
      base = path.join(ROOT, 'public/assets'); relative = pathname.slice('/assets/'.length);
    } else if (pathname.startsWith('/vendor/three/')) {
      base = path.join(ROOT, 'node_modules/three'); relative = pathname.slice('/vendor/three/'.length);
    } else { response.writeHead(404).end(); return; }
    const [directory, filename] = await Promise.all([realpath(base), realpath(path.resolve(base, relative))]);
    const inside = path.relative(directory, filename);
    if (inside.startsWith('..') || path.isAbsolute(inside)) { response.writeHead(403).end(); return; }
    const extension = path.extname(filename);
    if (['.mp3', '.wav'].includes(extension)) {
      const info = await stat(filename);
      if (!info.isFile()) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', MIME[extension]);
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('Cache-Control', 'private, max-age=86400');
      let start = 0, end = info.size - 1, status = 200;
      if (request.method === 'GET' && request.headers.range !== undefined) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        const first = range?.[1] ? Number(range[1]) : null, last = range?.[2] ? Number(range[2]) : null;
        if (!range || (first === null && last === null) ||
            (first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last)) ||
            (first === null ? last <= 0 : first >= info.size || (last !== null && last < first)) || !info.size) {
          response.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Content-Length': 0 }).end(); return;
        }
        start = first === null ? Math.max(0, info.size - last) : first;
        end = first === null || last === null ? info.size - 1 : Math.min(last, info.size - 1);
        status = 206; response.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      }
      response.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (request.method === 'HEAD' || !info.size) { response.writeHead(status).end(); return; }
      if (response.destroyed) return;
      const stream = createReadStream(filename, { start, end });
      response.on('close', () => stream.destroy());
      stream.on('error', error => {
        if (response.headersSent) response.destroy(error);
        else { response.removeHeader('Content-Length'); response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(); }
      });
      stream.on('open', () => { response.writeHead(status); stream.pipe(response); });
      return;
    }
    const body = await readFile(filename);
    if (['.html', '.js', '.css'].includes(path.extname(filename))) response.setHeader('Cache-Control', 'no-store');
    response.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream', 'Content-Length': body.length });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    response.writeHead(error instanceof URIError ? 400 : ['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code) ? 404 : 500).end();
  }
}

export async function createGameServer({ port = 3000, host = '0.0.0.0', publicOrigin } = {}) {
  let configuredOrigin;
  if (publicOrigin !== undefined) {
    try {
      const url = new URL(publicOrigin);
      if (typeof publicOrigin !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      configuredOrigin = url.origin;
    } catch { throw new Error('PUBLIC_ORIGIN must be an http(s) origin without credentials, path, query or fragment.'); }
  }
  const server = http.createServer((request, response) => { void serve(request, response); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  const rooms = new Map();
  let stopping = false;
  function send(player, message, snapshot = false) {
    const socket = player.socket;
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) {
      player.congestedSince ||= performance.now();
      if (performance.now() - player.congestedSince > 5000) socket.terminate();
      if (snapshot) return;
    } else player.congestedSince = 0;
    if (snapshot && socket.bufferedAmount > 64 * 1024) return;
    socket.send(JSON.stringify(message));
  }
  const fail = (player, message) => send(player, { type: 'error', message });
  const members = room => [...room.players.values(), ...room.waiting.values()];
  const describe = ({ id, name, slot, ready, vehicle }) => ({ id, name, slot, ready, vehicle });
  function clearCommands(player) {
    player.input = {}; player.appliedThrottle = 0; player.lastSeq = 0; player.receivedSeq = 0; player.inputQueue = []; player.commandMode = false;
  }
  function promoteWaiting(room, rotate = false) {
    const entrants = [...room.waiting.values()].slice(0, rotate ? 4 : 4 - room.players.size);
    const keep = [...room.players.values()].slice(0, 4 - entrants.length);
    const retiring = [...room.players.values()].filter(player => !keep.includes(player));
    for (const player of entrants) room.waiting.delete(player.id);
    room.players = new Map(keep.map(player => [player.id, player]));
    for (const player of entrants) {
      player.slot = [0, 1, 2, 3].find(slot => ![...room.players.values()].some(peer => peer.slot === slot));
      player.car = createCar(player.id, player.slot, player.vehicle, room.trackId, room.laps); clearCommands(player);
      room.players.set(player.id, player);
    }
    for (const player of retiring) {
      player.ready = false; player.slot = null; player.car = null; clearCommands(player); room.waiting.set(player.id, player);
    }
    if (!room.players.has(room.hostId) && room.players.size) {
      const host = room.players.values().next().value; room.hostId = host.id;
    }
  }
  function roomState(room) {
    return { type: 'room', code: room.code, trackId: room.trackId, laps: room.laps, timeOfDay: room.timeOfDay, musicMode: room.musicMode, musicTrack: room.musicTrack, hostId: room.hostId, phase: room.phase, raceId: room.raceId,
      environment: room.environment ? { ...room.environment, timestamp: room.environment.timestamp + performance.now() - room.environmentAt } : null,
      forceStarting: room.forceStartEnd != null,
      players: [...room.players.values()].map(describe), waiting: [...room.waiting.values()].map(describe), racePlayers: room.racePlayers };
  }
  function broadcastRoom(room) {
    const message = roomState(room);
    for (const player of members(room)) send(player, message);
  }
  function snapshot(room, now) {
    const cars = (room.phase === 'finished' && room.completedCars ? [...room.completedCars] : [...room.players.values()].map(player => player.car))
      .map(car=>({...car,braking:!car.finished&&(room.players.get(car.id)?.appliedThrottle??0)*car.speed<-.1})).sort((a, b) =>
      Number(b.finished) - Number(a.finished) || (a.finished ? a.finishTime - b.finishTime || room.finishers.findIndex(p => p.id === a.id) - room.finishers.findIndex(p => p.id === b.id) : b.progress - a.progress) || a.slot - b.slot);
    const serverNow = performance.now(), stateTime = room.stateTime;
    const raceTime = room.raceStart === null ? 0 : Math.max(0, ((room.raceEnd ?? stateTime) - room.raceStart) / 1000);
    const message = { type: 'snapshot', trackId: room.trackId, laps: room.laps, musicMode: room.musicMode, musicTrack: room.musicTrack, phase: room.phase, tick: room.tick, serverNow, stateTime, raceTime, raceId: room.raceId, finishers: room.finishers,
      finishRemaining: room.firstFinish === null ? null : room.phase === 'finished' ? 0 : Math.max(0, 10 - (raceTime - room.firstFinish)),
      readyRemaining: room.phase === 'finished' && room.readyEnd !== null ? Math.max(0, (room.readyEnd - now) / 1000) : null,
      forceStartRemaining: room.forceStartEnd == null ? null : Math.max(0, (room.forceStartEnd - now) / 1000),
      countdown: room.phase === 'countdown' ? Math.min(3, Math.max(0, (room.countdownEnd - now) / 1000)) : 0, cars,
      standings: cars.map((car, index) => ({ id: car.id, rank: index + 1, finished: car.finished,
        finishTime: car.finishTime, dnf: room.phase === 'finished' && !car.finished })) };
    for (const player of members(room)) send(player, message, true);
  }
  function updateAutoStart(room, now) {
    if (room.forceStartEnd != null) {
      if (now >= room.forceStartEnd) {
        for (const player of room.players.values()) player.ready = true;
        startRace(room, now);
      }
      return;
    }
    if (room.phase !== 'finished') return;
    if (!room.players.get(room.hostId)?.ready) { room.readyEnd = null; return; }
    room.readyEnd ??= now + 10000;
    if ([...room.players.values()].every(player => player.ready) || now >= room.readyEnd) startRace(room, now);
  }
  function startRace(room, now) {
    room.phase = 'countdown'; room.countdownEnd = now + 3000; room.readyEnd = room.forceStartEnd = null;
    room.raceStart = room.raceEnd = room.firstFinish = null;
    room.raceId++; room.finishers = [];
    room.racePlayers = [...room.players.values()].map(describe); room.completedCars = null;
    for (const peer of room.players.values()) { peer.car = createCar(peer.id, peer.slot, peer.vehicle, room.trackId, room.laps); clearCommands(peer); }
    broadcastRoom(room); snapshot(room, now);
  }
  function setEnvironment(room, environment, now) {
    const next = cleanEnvironment(environment);
    if (room.timeOfDay !== 'auto') next.timestamp = room.environment && room.environment.latitude === next.latitude && room.environment.longitude === next.longitude
      ? room.environment.timestamp + now - room.environmentAt
      : skyTime(next.timestamp, next.latitude, next.longitude, room.timeOfDay);
    room.environment = next; room.environmentAt = now;
  }
  function leave(player, notify = false) {
    const room = player.room;
    if (!room) return;
    const previousHost = room.hostId;
    player.room = null;
    if (player.id === room.hostId) room.readyEnd = room.forceStartEnd = null;
    clearCommands(player);
    if (room.phase === 'racing' && player.car?.finished) (room.completedCars ||= []).push({ ...player.car });
    room.players.delete(player.id);
    room.waiting.delete(player.id);
    if (notify) send(player, { type: 'closed', message: 'You left the room.' });
    if (!members(room).length) rooms.delete(room.code);
    else {
      if (!room.players.size) {
        if (room.phase !== 'racing' || room.firstFinish === null) {
          if (room.phase !== 'finished') { room.phase = 'lobby'; room.completedCars = null; }
          promoteWaiting(room);
        }
      }
      else if (room.phase === 'lobby' || room.phase === 'finished') promoteWaiting(room);
      if (!room.players.has(room.hostId)) {
        const next = room.players.values().next().value || room.waiting.values().next().value;
        room.hostId = next.id;
      }
      if (room.phase === 'finished' && room.hostId !== previousHost) {
        room.readyEnd = null;
        const host = room.players.get(room.hostId); if (host) host.ready = false;
      }
      broadcastRoom(room);
    }
  }
  function receive(player, data, binary) {
    const now = performance.now();
    if (now - player.rateStart > 1000) { player.rateStart = now; player.messages = 0; }
    if (++player.messages > 120) { player.socket.close(1008, 'Too many messages'); return; }
    let message;
    try { if (binary) throw new Error(); message = JSON.parse(data.toString()); }
    catch { fail(player, 'Send a valid JSON message.'); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { fail(player, 'Invalid message.'); return; }
    const room = player.room;
    if (message.type === 'list') {
      send(player, { type: 'rooms', rooms: [...rooms.values()].map(target => ({ code: target.code, trackId: target.trackId, laps: target.laps,
        hostName: (target.players.get(target.hostId) || target.waiting.get(target.hostId)).name, playerCount: target.players.size, maxPlayers: 4,
        phase: target.phase, joinable: target.players.size < 4 && ['lobby', 'finished'].includes(target.phase),
        waitingCount: target.waiting.size, watchable: target.waiting.size < MAX_SPECTATORS && (target.players.size >= 4 || ['countdown', 'racing'].includes(target.phase)) })) });
      return;
    }
    if (message.type === 'create' || message.type === 'join') {
      if (message.wait !== undefined && typeof message.wait !== 'boolean') { fail(player, 'Invalid waiting preference.'); return; }
      if (message.name !== undefined && typeof message.name !== 'string') { fail(player, 'Name must be text.'); return; }
      const vehicle = message.vehicle === undefined ? 'PULSE' : message.vehicle;
      if (typeof vehicle !== 'string' || !Object.hasOwn(VEHICLES, vehicle)) { fail(player, 'Choose a valid vehicle.'); return; }
      const name = (message.name ?? 'Driver').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 24) || 'Driver';
      let target, waiting = false;
      if (message.type === 'create') {
        const musicMode = message.musicMode === undefined ? 'random' : message.musicMode;
        if (!['random', 'sequence'].includes(musicMode)) { fail(player, 'Choose a valid music mode.'); return; }
        if (message.musicTrack !== undefined && !validMusic(message.musicTrack)) { fail(player, 'Choose a valid music track.'); return; }
        if (message.environment !== undefined && !validEnvironment(message.environment)) { fail(player, 'Invalid sky environment.'); return; }
        const timeOfDay = message.timeOfDay === undefined ? 'auto' : message.timeOfDay;
        if (!TIMES_OF_DAY.includes(timeOfDay)) { fail(player, 'Choose a valid time of day.'); return; }
        const trackId = message.trackId === undefined ? 'beginner' : message.trackId;
        if (typeof trackId !== 'string' || !Object.hasOwn(TRACKS, trackId)) { fail(player, 'Choose a valid circuit.'); return; }
        const laps = message.laps === undefined ? LAP_OPTIONS[trackId][0] : message.laps;
        if (!LAP_OPTIONS[trackId].includes(laps)) { fail(player, 'Choose a valid lap count for this circuit.'); return; }
        if (rooms.size >= 64) { fail(player, 'Server room limit reached.'); return; }
        let code;
        do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
        target = { code, trackId, laps, timeOfDay, musicMode, musicTrack: message.musicTrack ?? MUSIC_TRACKS[randomInt(MUSIC_TRACKS.length)].id,
          environment: null, environmentAt: now, readyEnd: null, forceStartEnd: null,
          players: new Map(), waiting: new Map(), racePlayers: [], completedCars: null, hostId: player.id, phase: 'lobby', tick: 0,
          stateTime: last - accumulator * 1000, raceStart: null, raceEnd: null, firstFinish: null, countdownEnd: null, raceId: 0, finishers: [] };
        if (message.environment) setEnvironment(target, message.environment, now);
      } else {
        target = typeof message.code === 'string' && rooms.get(message.code.trim().toUpperCase());
        if (!target) { fail(player, 'Room not found.'); return; }
        if (target === room) { fail(player, 'You are already in this room.'); return; }
        if (!['lobby', 'finished'].includes(target.phase)) {
          if (!message.wait) { fail(player, 'Race already started. Join after it finishes.'); return; }
          waiting = true;
        }
        if (target.players.size >= 4) {
          if (!message.wait) { fail(player, 'Room is full (4 players).'); return; }
          waiting = true;
        }
        if (waiting && target.waiting.size >= MAX_SPECTATORS) { fail(player, `Waiting queue is full (${MAX_SPECTATORS} spectators).`); return; }
      }
      leave(player);
      player.name = name; player.vehicle = vehicle; player.room = target;
      player.slot = waiting ? null : [0, 1, 2, 3].find(slot => ![...target.players.values()].some(peer => peer.slot === slot));
      player.ready = waiting || target.hostId === player.id;
      player.car = waiting ? null : createCar(player.id, player.slot, player.vehicle, target.trackId, target.laps);
      clearCommands(player);
      (waiting ? target.waiting : target.players).set(player.id, player); rooms.set(target.code, target);
      broadcastRoom(target); snapshot(target, now); return;
    }
    if (message.type === 'leave') { leave(player, true); return; }
    if (!room) { fail(player, 'Create or join a room first.'); return; }
    if (['input', 'inputs', 'neutral', 'launch'].includes(message.type) && message.raceId !== room.raceId) {
      fail(player, 'Stale race input.'); return;
    }
    if (message.type === 'environment') {
      if (room.hostId !== player.id) { fail(player, 'Only the host can update the sky.'); return; }
      if (message.code !== room.code || !validEnvironment(message.environment)) { fail(player, 'Invalid sky environment.'); return; }
      setEnvironment(room, message.environment, now); broadcastRoom(room);
    } else if (message.type === 'vehicle') {
      if (!room.waiting.has(player.id) && !['lobby', 'finished'].includes(room.phase)) { fail(player, 'Vehicle is locked during a race.'); return; }
      if (typeof message.vehicle !== 'string' || !Object.hasOwn(VEHICLES, message.vehicle)) { fail(player, 'Choose a valid vehicle.'); return; }
      player.vehicle = message.vehicle;
      if (room.players.has(player.id)) {
        player.car = createCar(player.id, player.slot, player.vehicle, room.trackId, room.laps); clearCommands(player);
      }
      broadcastRoom(room); snapshot(room, now);
    } else if (message.type === 'ready') {
      if (!room.waiting.has(player.id) && !['lobby', 'finished'].includes(room.phase)) { fail(player, 'Readiness is locked during a race.'); return; }
      if (typeof message.ready !== 'boolean') { fail(player, 'Ready must be true or false.'); return; }
      player.ready = message.ready; updateAutoStart(room, now); broadcastRoom(room);
    } else if (message.type === 'start') {
      if (room.hostId !== player.id) { fail(player, 'Only the host can start.'); return; }
      if (!['lobby', 'finished'].includes(room.phase)) { fail(player, 'Race already started.'); return; }
      if (message.force !== undefined && typeof message.force !== 'boolean') { fail(player, 'Force start must be true or false.'); return; }
      if (room.forceStartEnd != null) return;
      if (message.force === true) {
        room.forceStartEnd = now + 5000; room.readyEnd = null;
        broadcastRoom(room); snapshot(room, now); return;
      }
      if (![...room.players.values()].every(peer => peer.ready)) { fail(player, 'Every player must be ready.'); return; }
      startRace(room, now);
    } else if (message.type === 'launch') {
      if (room.waiting.has(player.id)) { fail(player, 'Spectators cannot drive.'); return; }
      if (typeof message.pressed !== 'boolean') { fail(player, 'Invalid launch input.'); return; }
      if (player.car && ['countdown', 'racing'].includes(room.phase)) updateStartBoost(player.car, message.pressed, (now - room.countdownEnd) / 1000);
    } else if (message.type === 'inputs' || message.type === 'neutral') {
      if (room.waiting.has(player.id)) { fail(player, 'Spectators cannot drive.'); return; }
      if (message.type === 'inputs' && room.phase !== 'racing') { fail(player, 'Stale race input.'); return; }
      if (message.type === 'neutral') {
        player.inputQueue = []; player.input = {}; player.appliedThrottle = 0; player.lastSeq = player.receivedSeq;
        return;
      }
      if (!Array.isArray(message.commands) || !message.commands.length || message.commands.length > 8) { fail(player, 'Invalid input batch.'); return; }
      let previous = player.receivedSeq;
      for (const command of message.commands) {
        if (!command || typeof command !== 'object' || Array.isArray(command) || !Number.isSafeInteger(command.seq) || command.seq <= previous ||
            ['throttle', 'steer'].some(key => command[key] !== undefined && (!Number.isFinite(command[key]) || Math.abs(command[key]) > 1)) ||
            ['drift', 'boost', 'reset'].some(key => command[key] !== undefined && typeof command[key] !== 'boolean')) {
          fail(player, 'Invalid or stale input command.'); return;
        }
        previous = command.seq;
      }
      player.commandMode = true; player.receivedSeq = previous;
      for (const command of message.commands) player.inputQueue.push({ seq: command.seq, at: now,
        throttle: command.throttle ?? 0, steer: command.steer ?? 0, drift: command.drift ?? false,
        boost: command.boost ?? false, reset: command.reset ?? false });
      // Keep one batch: a reconnect burst must not leave a lasting input backlog.
      while (player.inputQueue.length > 8) player.lastSeq = player.inputQueue.shift().seq;
    } else if (message.type === 'input') {
      if (room.waiting.has(player.id)) { fail(player, 'Spectators cannot drive.'); return; }
      if (!Number.isSafeInteger(message.seq) || message.seq <= Math.max(player.lastSeq, player.receivedSeq) || message.seq < 1 ||
          ['throttle', 'steer'].some(key => message[key] !== undefined && (!Number.isFinite(message[key]) || Math.abs(message[key]) > 1)) ||
          ['drift', 'boost', 'reset'].some(key => message[key] !== undefined && typeof message[key] !== 'boolean')) {
        fail(player, 'Invalid or stale input.'); return;
      }
      if (room.phase !== 'racing') return;
      player.lastSeq = player.receivedSeq = message.seq; player.inputAt = now; player.commandMode = false; player.inputQueue = [];
      player.input = { throttle: message.throttle ?? 0, steer: message.steer ?? 0,
        drift: message.drift ?? false, boost: message.boost ?? false, reset: message.reset ?? false };
    } else fail(player, 'Unknown message type.');
  }
  server.on('upgrade', (request, socket, head) => {
    if (stopping || request.url !== '/' || wss.clients.size >= 128) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', socket => {
    const player = { socket, id: randomUUID(), room: null, input: {}, lastSeq: 0, receivedSeq: 0, inputQueue: [], commandMode: false,
      inputAt: 0, rateStart: performance.now(), messages: 0, alive: true, congestedSince: 0 };
    socket.on('error', () => { socket.terminate(); });
    socket.on('pong', () => { player.alive = true; });
    socket.on('message', (data, binary) => receive(player, data, binary));
    socket.on('close', () => leave(player));
    socket.player = player;
    const shareOrigins = configuredOrigin ? [configuredOrigin] : [...new Set(Object.values(networkInterfaces()).flat()
      .filter(address => address?.family === 'IPv4' && !address.internal)
      .map(address => `http://${address.address}:${server.address().port}`))]
      .sort((a, b) => Number(/^http:\/\/(192\.168\.|10\.)/.test(b)) - Number(/^http:\/\/(192\.168\.|10\.)/.test(a)));
    send(player, { type: 'welcome', id: player.id, version: VERSION, shareOrigins });
  });
  let last = performance.now(), accumulator = 0, lastSnapshot = last;
  const timer = setInterval(() => {
    const now = performance.now();
    // ponytail: discard catch-up beyond 250 ms; move rooms to workers if one process cannot sustain 60 Hz.
    accumulator += Math.min((now - last) / 1000, 0.25); last = now;
    while (accumulator >= STEP) {
      accumulator -= STEP;
      for (const room of rooms.values()) {
        room.tick++;
        room.stateTime = now - accumulator * 1000;
        updateAutoStart(room, now);
        if (room.phase === 'countdown' && room.stateTime >= room.countdownEnd) {
          room.phase = 'racing'; room.raceStart = room.countdownEnd; broadcastRoom(room);
        }
        if (room.phase === 'finished') {
          for (const car of room.completedCars || []) stepCar(car, {}, STEP, true);
          continue;
        }
        if (room.phase !== 'racing') continue;
        const cars = [...room.players.values()].map(player => {
          let controls = now - player.inputAt <= 300 ? player.input : {};
          if (player.commandMode) {
            while (player.inputQueue.length && now - player.inputQueue[0].at > 300) player.lastSeq = player.inputQueue.shift().seq;
            const command = player.inputQueue.shift();
            controls = command || {};
            if (command) player.lastSeq = command.seq;
          }
          stepCar(player.car, controls, STEP);
          player.appliedThrottle = controls.throttle ?? 0;
          player.car.lastInputSeq = player.lastSeq;
          return player.car;
        });
        resolveCollisions(cars);
        const raceTime = (room.stateTime - room.raceStart) / 1000;
        for (const car of cars) {
          updateProgress(car);
          if (car.finished && car.finishTime === null) {
            car.finishTime = raceTime; room.firstFinish ??= raceTime;
            room.finishers.push({ id: car.id, name: room.players.get(car.id).name, finishTime: raceTime });
          }
        }
        if (room.firstFinish !== null && (cars.every(car => car.finished) || raceTime - room.firstFinish >= 10)) {
          room.phase = 'finished'; room.raceEnd = room.stateTime; room.completedCars = [...(room.completedCars || []), ...cars.map(car => ({ ...car }))];
          promoteWaiting(room, true); room.readyEnd = null;
          const host = room.players.get(room.hostId); if (host) host.ready = false;
          broadcastRoom(room); snapshot(room, now);
        }
      }
    }
    if (now - lastSnapshot >= 50) {
      lastSnapshot += Math.floor((now - lastSnapshot) / 50) * 50;
      for (const room of rooms.values()) snapshot(room, now);
    }
  }, 8);
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.player.alive) socket.terminate();
      else { socket.player.alive = false; socket.ping(); }
    }
  }, 15000);
  const closeHTTP = server.close.bind(server);
  let shutdown;
  server.close = callback => {
    shutdown ??= new Promise((resolve, reject) => {
      stopping = true; clearInterval(timer); clearInterval(heartbeat);
      for (const socket of wss.clients) {
        send(socket.player, { type: 'closed', message: 'Server shutting down.' });
        socket.close(1001, 'Server shutting down');
      }
      const force = setTimeout(() => { for (const socket of wss.clients) socket.terminate(); }, 250);
      force.unref();
      Promise.all([
        new Promise(done => wss.close(done)),
        new Promise((done, fail) => closeHTTP(error => error ? fail(error) : done())),
      ]).then(() => { clearTimeout(force); rooms.clear(); resolve(); }, reject);
    });
    if (callback) shutdown.then(() => callback(), callback);
    return server;
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  } catch (error) { clearInterval(timer); clearInterval(heartbeat); wss.close(); throw error; }
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createGameServer({ port: Number(process.env.PORT || 3000), publicOrigin: process.env.PUBLIC_ORIGIN });
  const port = server.address().port;
  console.log(`LANRider: http://localhost:${port}`);
  for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? []) {
    if (address.family === 'IPv4' && !address.internal) console.log(`LAN: http://${address.address}:${port}`);
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(error => {
    if (error) { console.error(error); process.exitCode = 1; }
  }));
}
