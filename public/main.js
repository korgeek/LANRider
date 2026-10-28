import { VERSION, MAX_SPECTATORS, LAPS, LAP_OPTIONS, TRACK, TRACKS, VEHICLES, STEP, createCar, stepCar, isWrongWay, sampleTrack } from '/shared/game.js';
import { t } from './i18n.js';
import { LocalPrediction, SnapshotBuffer } from './netcode.js';
import { createScene, COLORS } from './scene.js';
import { invitationCode, invitationUrl, finishAnnouncements, driverPreferences, driverCookies, hasDriverName, spectatorTarget } from './session.js';
import { browserEnvironment, createEnvironmentSync } from './environment.js';
import { initAudio } from './audio.js';
import { MUSIC_TRACKS } from '/shared/music.js';

const $ = id => document.getElementById(id);
const audio = initAudio(document);
$('sound-toggle').addEventListener('click', () => $('sound-settings').showModal());
$('sound-close').addEventListener('click', () => $('sound-settings').close());
$('debug-music-toggle').addEventListener('click', () => $('music-mute').click());
const debugToggle = $('debug-toggle');
function setDebug(enabled) {
  debugToggle.checked = enabled;
  $('debug-status').hidden = $('net-stats').hidden = !enabled;
  world?.setCollisionDebug(enabled);
}
debugToggle.addEventListener('change', () => setDebug(debugToggle.checked));
const graphicsSelect = $('graphics-quality');
const graphicsStatus = $('graphics-status');
const graphicsQualities = ['high', 'medium', 'low'];
let graphicsChosen = false;
try {
  const saved = localStorage.getItem('nextrider.graphicsQuality');
  if (graphicsQualities.includes(saved)) { graphicsSelect.value = saved; graphicsChosen = true; }
} catch { /* Settings remain usable when storage is blocked. */ }
function applyGraphicsQuality() {
  if (!graphicsQualities.includes(graphicsSelect.value)) return;
  graphicsChosen = true;
  world?.setGraphicsQuality(graphicsSelect.value);
  const image = $('queued-vehicle-image');
  if (world && image?.dataset?.vehicle) image.src = world.vehiclePortrait(image.dataset.vehicle);
  try { localStorage.setItem('nextrider.graphicsQuality', graphicsSelect.value); }
  catch { /* Keep the selection for this visit when storage is blocked. */ }
}
graphicsSelect.addEventListener('change', () => {
  applyGraphicsQuality();
  graphicsStatus.textContent = t('직접 선택한 그래픽 품질을 사용합니다.');
});
async function autoGraphicsQuality() {
  if (graphicsChosen) return;
  graphicsStatus.textContent = t('자동 측정 중…');
  try {
    const result = await world.benchmarkGraphicsQuality();
    if (graphicsChosen) return;
    if (!graphicsQualities.includes(result?.quality)) throw new Error('Invalid graphics quality');
    graphicsSelect.value = result.quality;
    applyGraphicsQuality();
    graphicsStatus.textContent = t('기기에 맞는 그래픽 품질을 선택했습니다.');
  } catch (error) {
    if (!graphicsChosen) {
      console.warn('Graphics measurement skipped', error);
      graphicsStatus.textContent = t('자동 측정을 완료하지 못했습니다. 현재 품질을 유지합니다.');
    }
  }
}
const keys = new Set();
const drivingKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space', 'KeyR']);
let socket, localId, room = null, snapshot = null, predicted = null, world;
let assetsReady = false, connected = false, fatal = false, practicePending = false, stalled = false;
let nameConfirmed = false;
let latestTick = -1, lastSnapshotAt = 0, hudAt = 0, frameMs = 0, pendingSnapshot = null;
const prediction = new LocalPrediction(), snapshots = new SnapshotBuffer();
const frameSamples = [], alphaSamples = [];
let statsAt = 0;
let invite = invitationCode(location.href), shareOrigin = location.origin;
let inviteAttempted = false;
const announced = { raceId: null, ids: new Set() };
let announcementUntil = 0;
let watchId = null, watchSelection = '';
let wrongWaySince = null;
let track = TRACKS.technical;
let selectedTrackId = track.id, practiceSelection = false;
let selectedLaps = LAP_OPTIONS[selectedTrackId][0];
let selectedMusic = { mode: 'random', track: MUSIC_TRACKS[0].id };
let musicChoiceIndex = 0;
const environmentSync = createEnvironmentSync(send, environment => world?.setEnvironment(environment));
let skyStatusAt = -Infinity;
function skyStatus() {
  const environment = environmentSync.current();
  const time = new Intl.DateTimeFormat(navigator.language, { timeZone: environment.timeZone,
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(environment.timestamp);
  const source = t('추정 위치');
  const weather = environment.cloudCover === null ? t('기본 구름') : t('구름 {cover}%', { cover: environment.cloudCover });
  $('sky-description').textContent = `${room ? t('방장 하늘') : t('내 하늘')} · ${time} · ${environment.timeZone} · ${source} · ${weather}`;
  $('sky-status').title = `${environment.latitude.toFixed(2)}, ${environment.longitude.toFixed(2)}`;
  $('weather-credit').hidden = environment.cloudCover === null;
}
const trackLabel = course => `${t(course.name)} · ${Math.round(course.length)} m`;
function selectTrack(id) {
  track = TRACKS[id] || TRACK;
  world?.setTrack(track);
  world?.setLaps(room?.laps ?? selectedLaps);
}
const queued = () => room?.waiting?.some(player => player.id === localId);
const phase = () => room?.phase || 'lobby';
const healthy = () => connected && !fatal && (!room || performance.now() - lastSnapshotAt < 2500);
const racing = () => phase() === 'racing' && healthy() && room?.players.some(player => player.id === localId);
const clock = seconds => {
  seconds = Math.max(0, seconds || 0);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
};
function send(message) {
  if (socket?.readyState === WebSocket.OPEN && !fatal) socket.send(JSON.stringify(message));
}
function input() {
  const held = (...codes) => codes.some(code => keys.has(code));
  return { throttle: Number(held('KeyW', 'ArrowUp')) - Number(held('KeyS', 'ArrowDown')),
    steer: Number(held('KeyD', 'ArrowRight')) - Number(held('KeyA', 'ArrowLeft')),
    drift: held('ShiftLeft', 'ShiftRight'), boost: held('Space'), reset: held('KeyR') };
}
function sendStartInput() {
  if (!healthy() || !['countdown', 'racing'].includes(phase()) || !room?.players.some(player => player.id === localId)) return;
  send({ type: 'launch', raceId: room.raceId, pressed: keys.has('KeyW') || keys.has('ArrowUp') });
}
function sendInput() {
  if (!racing() || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024) return;
  const commands = prediction.drain();
  if (commands.length) send({ type: 'inputs', raceId: room.raceId, commands });
}
function clearInput() {
  keys.clear();
  sendStartInput();
  if (racing()) send({ type: 'neutral', raceId: room.raceId });
  prediction.neutral();
}
function resetNetwork() { prediction.reset(); snapshots.reset(); predicted = null; pendingSnapshot = null; frameSamples.length = alphaSamples.length = 0; }
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('toast').hidden = true; }, 5500);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* HTTP LAN pages need the user-gesture fallback. */ }
  const focus = document.activeElement, input = document.createElement('textarea');
  input.value = text; input.style.cssText = 'position:fixed;inset:0;width:1px;height:1px;opacity:0';
  (document.querySelector('dialog[open]') || document.body).append(input); input.select();
  try { if (!document.execCommand('copy')) throw new Error('Clipboard unavailable'); }
  finally { input.remove(); focus?.focus({ preventScroll: true }); }
}
function fail(message) {
  environmentSync.setRoom(null, localId);
  clearInput(); clearCelebration(); fatal = true; connected = false; practicePending = false;
  $('loading-title').textContent = t('잠시 멈췄어요'); $('loading-status').textContent = message;
  $('loading-bar').hidden = true; $('reload').hidden = false;
  document.body.classList.remove('boosting', 'drifting'); updateUI();
}
const errors = new Map([
  ['Choose a valid music mode.', t('올바른 음악 재생 방식을 선택해 주세요.')],
  ['Choose a valid music track.', t('올바른 음악을 선택해 주세요.')],
  ['Choose a valid circuit.', t('올바른 서킷을 선택해 주세요.')],
  ['Choose a valid time of day.', t('올바른 시간대를 선택해 주세요.')],
  ['Choose a valid vehicle.', t('올바른 차량을 선택해 주세요.')],
  ['Vehicle is locked during a race.', t('출발 후에는 차량을 변경할 수 없습니다.')],
  ['Room not found.', t('방을 찾을 수 없습니다. 6자리 코드를 확인해 주세요.')],
  ['Room is full (4 players).', t('이미 4명이 참가한 방입니다. 다른 방을 만들어 주세요.')],
  ['Race already started. Join after it finishes.', t('경주가 진행 중입니다. 경주가 끝난 뒤 참가해 주세요.')],
  ['Every player must be ready.', t('모든 드라이버가 준비를 완료해야 출발할 수 있습니다.')],
  ['Only the host can start.', t('방장만 경주를 시작할 수 있습니다.')],
  ['You are already in this room.', t('이미 참가한 방입니다.')],
  ['Server room limit reached.', t('서버의 방이 가득 찼습니다. 잠시 후 다시 시도해 주세요.')],
  ['Race already started.', t('이미 경주가 시작되었습니다.')],
  [`Waiting queue is full (${MAX_SPECTATORS} spectators).`, t('관전·대기 인원 {max}명이 모두 찼습니다. 잠시 후 다시 참가해 주세요.', { max: MAX_SPECTATORS })],
]);
function playerName(id) { return room?.players.find(player => player.id === id)?.name || 'Rider'; }
function node(tag, className, text) {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text; return result;
}
function watchPlayers() {
  const players = (phase() === 'finished' ? room?.racePlayers : room?.players) || room?.players || [];
  return snapshot?.raceId === room?.raceId && phase() !== 'lobby'
    ? players.filter(player => snapshot.cars.some(car => car.id === player.id)) : players;
}
function updateWatchTarget(rebuild = false) {
  const players = watchPlayers();
  if (rebuild) {
    const automatic = node('option', '', t('자동 · 1위 관전')); automatic.value = '';
    $('watch-target').replaceChildren(automatic, ...players.map(player => {
      const option = node('option', '', `${player.name} · ${player.vehicle}`); option.value = player.id; return option;
    }));
  }
  if (!players.some(player => player.id === watchSelection)) watchSelection = '';
  watchId = spectatorTarget(watchSelection, players, snapshot?.raceId === room?.raceId ? snapshot?.standings : []);
  if ($('watch-target').value !== watchSelection) $('watch-target').value = watchSelection;
}
function playerItem(player, rank, result = false) {
  const item = node('li', '');
  const number = node('span', result ? 'result-rank' : 'slot-number', String(rank));
  number.style.color = COLORS[player.slot];
  item.append(number, node('span', result ? 'result-name' : 'slot-name', `${player.name}${player.id === localId ? t(' · 나') : ''}${result ? '' : ` · ${player.vehicle || 'PULSE'}`}`));
  return item;
}
function updateUI() {
  audio.setRace(room && ['countdown', 'racing', 'finished'].includes(phase()) ? track.id : null, room?.raceId);
  if (room) audio.setMusic({ mode: room.musicMode, track: room.musicTrack }, room.code, phase());
  else if (!$('circuit-picker').open) audio.setMusic(null);
  const ready = assetsReady && connected && !fatal;
  if (connected && !fatal && !room && !nameConfirmed && !$('driver-welcome').open) $('driver-welcome').showModal();
  if ((fatal || nameConfirmed) && $('driver-welcome').open) $('driver-welcome').close();
  if ((!ready || room) && $('circuit-picker').open) $('circuit-picker').close();
  if ((!ready || !room || phase() !== 'lobby') && $('share-box').open) $('share-box').close();
  if ((!ready || !room) && $('leave-confirm').open) $('leave-confirm').close();
  if ((!ready || !room || room.hostId !== localId || room.forceStarting || !['lobby', 'finished'].includes(phase())) && $('start-confirm').open) $('start-confirm').close();
  $('force-start-notice').hidden = !ready || !room?.forceStarting || !queued();
  if (!racing()) { wrongWaySince = null; $('wrong-way-warning').hidden = true; }
  $('loading').hidden = ready;
  $('lobby').hidden = !ready || Boolean(room) || !nameConfirmed;
  $('room-panel').hidden = !ready || !room || phase() !== 'lobby';
  $('race').hidden = !ready || !room || !['countdown', 'racing'].includes(phase());
  $('results').hidden = !ready || !room || phase() !== 'finished';
  $('connection').textContent = !connected ? (fatal ? t('연결 끊김') : t('서버 연결 중')) : room ? t('연결됨 · {code}', { code: room.code }) : t('서버 연결됨');
  $('connection').classList.toggle('online', connected && !fatal);
  $('connection').disabled = !room;
  $('connection').title = room ? t('현재 방 링크 복사') : '';
  $('controls').hidden = !ready || !room || Boolean(queued());
  $('race-leave').hidden = !ready || !room;
  $('spectator-panel').hidden = !ready || !room || !queued();
  $('queue-notice').hidden = !ready || !room || !room.waiting?.length;
  $('invite-notice').hidden = !invite;
  document.body.dataset.phase = fatal ? 'error' : !ready ? 'loading' : room ? phase() : 'lobby';
  if (!room) {
    selectTrack(selectedTrackId);
    if (ready && nameConfirmed && invite && !inviteAttempted) { inviteAttempted = true; enterRoom('join', invite); }
    return;
  }
  $('room-label').textContent = room.code;
  $('room-track').textContent = `${trackLabel(track)} · ${t('{count}랩', { count: room.laps ?? LAPS })}`;
  $('result-track').textContent = `${trackLabel(track)} · ${t('{count}랩', { count: room.laps ?? LAPS })}`;
  $('player-count').textContent = `${room.players.length} / 4`;
  const slots = [];
  for (let slot = 0; slot < 4; slot++) {
    const player = room.players.find(p => p.slot === slot);
    if (player) {
      const item = playerItem(player, slot + 1);
      item.append(node('span', `slot-status${player.ready ? ' ready' : ''}`, `${player.id === room.hostId ? t('방장 · ') : ''}${player.ready ? t('준비 완료') : t('대기 중')}`)); slots.push(item);
    } else {
      const item = node('li', 'empty'); item.append(node('span', 'slot-number', String(slot + 1)), node('span', '', t('드라이버를 기다리는 중'))); slots.push(item);
    }
  }
  $('slots').replaceChildren(...slots);
  const waitingPlayers = room.waiting || [];
  const me = [...room.players, ...waitingPlayers].find(player => player.id === localId), host = room.hostId === localId;
  if (me) {
    for (const id of ['room-vehicle', 'result-vehicle', 'spectator-vehicle']) $(id).value = me.vehicle;
    if ($('vehicle').value !== me.vehicle) { $('vehicle').value = me.vehicle; describeVehicle(); saveDriver(); }
    if (queued()) {
      $('queued-vehicle-name').textContent = me.vehicle;
      $('queued-vehicle-description').textContent = t(VEHICLES[me.vehicle].description);
      const image = $('queued-vehicle-image'); image.alt = t('내 다음 경기 차량: {vehicle}', { vehicle: me.vehicle });
      if (world && image.dataset.vehicle !== me.vehicle) { image.src = world.vehiclePortrait(me.vehicle); image.dataset.vehicle = me.vehicle; image.hidden = false; }
    }
  }
  $('result-vehicle').hidden = Boolean(queued());
  document.querySelector('label[for="result-vehicle"]').hidden = Boolean(queued());
  const queueNames = waitingPlayers.map(player => `${player.name}${player.ready ? ' ✓' : ''}`);
  $('queue-notice').textContent = t('다음 경기 대기 {count}명 · {names}', { count: waitingPlayers.length, names: queueNames.slice(0, 4).join(', ') + (queueNames.length > 4 ? t(' 외 {count}명', { count: queueNames.length - 4 }) : '') });
  $('queue-notice').title = queueNames.join(', ');
  $('next-grid').textContent = t('다음 출전: {names}', { names: room.players.map(player => `${player.name} · ${player.vehicle}${player.ready ? ' ✓' : t(' (준비 대기)')}`).join(' / ') });
  $('spectator-status').textContent = t('다음 경기 대기 {position}번 · {status}', { position: waitingPlayers.findIndex(player => player.id === localId) + 1, status: me?.ready ? t('준비 완료') : t('준비 대기') });
  updateWatchTarget(true);
  const allReady = room.players.every(player => player.ready);
  for (const id of ['ready', 'result-ready', 'spectator-ready']) {
    $(id).textContent = me?.ready ? t('준비 취소') : t('준비 완료');
    $(id).setAttribute('aria-pressed', String(Boolean(me?.ready)));
  }
  for (const id of ['start', 'restart']) { $(id).hidden = !host; $(id).disabled = Boolean(room.forceStarting); }
  const waiting = host ? allReady ? room.players.length === 1 ? t('준비 완료! 혼자서도 출발할 수 있습니다.') : t('모든 드라이버가 준비를 마쳤습니다.') : t('준비 대기 중인 드라이버가 있습니다. 경주 시작을 누르면 5초 뒤 모두 출발합니다.') : allReady ? t('방장의 출발을 기다리고 있습니다.') : t('준비를 완료하고 함께 출발하세요.');
  $('waiting').textContent = $('result-waiting').textContent = waiting;
  updateRematchUI();
  updateForcedStartUI();
  updateStandings();
}
function requestStart(force = false) {
  if (!room || room.hostId !== localId || room.forceStarting || !['lobby', 'finished'].includes(phase())) return;
  const unready = room.players.some(player => !player.ready);
  if (unready && !force) { $('start-confirm').showModal(); return; }
  clearInput(); send({ type: 'start', force: unready });
}
function updateForcedStartUI(now = performance.now()) {
  const starting = Boolean(connected && !fatal && room?.forceStarting && ['lobby', 'finished'].includes(phase()));
  $('force-start-notice').hidden = !starting || !queued();
  for (const id of ['ready', 'result-ready']) $(id).disabled = starting;
  if (!starting) return;
  const remaining = snapshot?.raceId === room.raceId ? snapshot.forceStartRemaining : null;
  const seconds = remaining == null ? 5 : Math.max(1, Math.ceil(remaining - Math.max(0, now - lastSnapshotAt) / 1000));
  const notice = t('{seconds}초 뒤 경기 시작 · 모든 출전자가 자동으로 준비됩니다.', { seconds });
  for (const id of ['waiting', 'result-waiting', 'force-start-notice']) $(id).textContent = notice;
  for (const id of ['ready', 'result-ready']) $(id).textContent = t('게임 준비 ({seconds})', { seconds });
}
function updateRematchUI(now = performance.now()) {
  if (!room || phase() !== 'finished' || room.forceStarting) return;
  const me = room.players.find(player => player.id === localId);
  const remaining = snapshot?.raceId === room.raceId ? snapshot.readyRemaining : null;
  const seconds = remaining == null ? null : Math.max(0, Math.ceil(remaining - Math.max(0, now - lastSnapshotAt) / 1000));
  $('result-ready').textContent = t('준비 완료') + (!me?.ready && seconds !== null ? ` (${seconds})` : '');
  $('result-ready').setAttribute('aria-pressed', String(Boolean(me?.ready)));
  $('result-ready').title = me?.ready ? t('준비 취소') : '';
  $('result-waiting').textContent = seconds === null
    ? t('차량을 변경한 뒤 준비해 주세요. 방장이 준비하면 10초 뒤 다음 경기가 시작됩니다.')
    : t('{seconds}초 뒤 자동 시작 · 모두 준비하면 바로 시작합니다.', { seconds });
}
function updateStandings() {
  if (!room || !snapshot) return;
  const rows = [], results = [];
  for (const standing of snapshot.standings) {
    const player = [...(room.racePlayers || []), ...room.players].find(p => p.id === standing.id); if (!player) continue;
    const row = playerItem(player, standing.rank);
    row.append(node('b', '', standing.finished ? 'FINISH' : '')); rows.push(row);
    const result = playerItem(player, standing.rank, true);
    result.append(node('span', 'result-time', standing.dnf ? t('종료 시점 진행도') : standing.finished ? clock(standing.finishTime) : t('주행 중'))); results.push(result);
  }
  $('race-players').replaceChildren(...rows); $('result-list').replaceChildren(...results);
  const me = snapshot.standings.find(p => p.id === localId);
  $('place').textContent = queued() ? t('관전') : `${me?.rank || 1} / ${snapshot.cars.length}`;
}
function changePhase(nextPhase) {
  if (!room || room.phase === nextPhase) return;
  if (!(room.phase === 'countdown' && nextPhase === 'racing')) clearInput();
  room.phase = nextPhase;
  if (nextPhase === 'countdown') { resetNetwork(); clearCelebration(); }
  updateUI();
}
function receiveSnapshot(message) {
  if (!room || message.tick <= latestTick) return;
  latestTick = message.tick; lastSnapshotAt = performance.now();
  const newPhase = snapshot?.phase !== message.phase || snapshot?.raceId !== message.raceId;
  changePhase(message.phase); snapshot = message;
  audio.updateRace(message, 0, healthy() && !document.hidden);
  updateWatchTarget(newPhase);
  if (finishAnnouncements(message, announced).length) {
    $('finish-title').textContent = t('🏁 {name} 선두 완주!', { name: message.finishers[0].name });
    $('finish-detail').textContent = message.finishers.map(finisher => `${finisher.name}${finisher.id === localId ? t(' (나)') : ''} ${clock(finisher.finishTime)}`).join(' / ');
    $('finish-banner').hidden = false; announcementUntil = performance.now() + 8500;
    world?.celebrate();
  }
  pendingSnapshot = message;
  snapshots.push(message, lastSnapshotAt);
  updateRematchUI();
  updateStandings();
}
function requestExit() {
  if (!room || $('leave-confirm').open) return;
  clearInput();
  const others = [...room.players, ...(room.waiting || [])].some(player => player.id !== localId);
  const warning = room.hostId === localId
    ? others ? '나가면 다른 참가자에게 방장이 넘어갑니다. 내 경주 참여와 관전은 종료됩니다.' : '나가면 방이 닫히고 진행 중인 경주가 종료됩니다.'
    : queued() ? '나가면 관전과 다음 경기 대기가 종료됩니다.'
      : ['countdown', 'racing'].includes(phase()) ? '나가면 현재 경주 참여가 중단되고 로비로 돌아갑니다.' : '나가면 현재 방과의 연결이 종료되고 로비로 돌아갑니다.';
  $('leave-message').textContent = t(warning);
  $('leave-confirm').showModal();
}
function exitRoom() {
  document.body.classList.remove('boosting', 'drifting');
  clearInput(); send({ type: 'leave' }); room = null; snapshot = null; predicted = null;
  resetNetwork(); latestTick = -1; practicePending = false; clearCelebration(); updateUI();
  history.replaceState(null, '', '/');
  invite = null; $('invite-notice').hidden = true; refreshRooms();
}
function clearCelebration() {
  announced.raceId = null; announced.ids.clear(); announcementUntil = 0;
  $('finish-banner').hidden = true; world?.clearCelebration();
}
function refreshRooms() {
  if (connected && !fatal && !room) send({ type: 'list' });
}
function renderRooms(rooms) {
  const phases = { lobby: t('대기 중'), countdown: t('출발 중'), racing: t('경주 중'), finished: t('경주 종료') };
  $('room-list-status').textContent = rooms.length ? t('{count}개 방 · 3초마다 갱신', { count: rooms.length }) : t('열린 방이 없습니다. 첫 방을 만들어 보세요.');
  $('room-list').replaceChildren(...rooms.map(entry => {
    const item = node('li', ''), button = node('button', 'directory-entry');
    button.type = 'button'; button.disabled = !entry.joinable && !entry.watchable;
    button.setAttribute('aria-label', t('방 {code} 참가', { code: entry.code }));
    button.append(node('strong', '', entry.code), node('span', 'directory-host', t('{name} · 주행 {count}/{max}명 · 대기 {waiting}/{waitingMax}명', { name: entry.hostName, count: entry.playerCount, max: entry.maxPlayers, waiting: entry.waitingCount || 0, waitingMax: MAX_SPECTATORS })),
      node('span', 'directory-track', `${trackLabel(TRACKS[entry.trackId] || TRACK)} · ${t('{count}랩', { count: entry.laps ?? LAPS })}`),
      node('span', 'directory-state', `${phases[entry.phase] || entry.phase} · ${entry.joinable ? t('참가 →') : entry.watchable ? t('관전·대기 →') : t('대기열 마감')}`));
    button.addEventListener('click', () => enterRoom('join', entry.code));
    item.append(button); return item;
  }));
}
function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`);
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      if (fatal) return;
      if (message.type === 'welcome') {
        localId = message.id; connected = true;
        if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && message.shareOrigins?.length) shareOrigin = message.shareOrigins[0];
        $('share-origin').value = shareOrigin;
        $('build-version').textContent = t('(배포 {version}{notice})', { version: message.version || VERSION, notice: message.version && message.version !== VERSION ? t(' · 새로고침 필요') : '' });
        if (message.version !== VERSION) {
          fail(t('서버와 화면의 버전이 다릅니다. 서버를 최신 버전으로 재시작한 뒤 새로고침해 주세요.'));
          socket.close(); return;
        }
        updateUI(); refreshRooms();
      }
      else if (message.type === 'room') {
        const newRoom = room?.code !== message.code, oldPhase = room?.phase, wasQueued = queued();
        if (newRoom) { latestTick = -1; snapshot = null; watchSelection = ''; watchId = null; resetNetwork(); clearCelebration(); $('share-box').close(); lastSnapshotAt = performance.now(); }
        room = message; invite = null; selectTrack(message.trackId);
        history.replaceState(null, '', `/${room.code}`);
        environmentSync.setRoom(room, localId); skyStatusAt = -Infinity;
        if (wasQueued && room.players.some(player => player.id === localId)) toast(t('다음 경기 출전 명단에 배정되었습니다. 준비 상태를 확인하세요.'));
        if (oldPhase !== message.phase) { if (!(oldPhase === 'countdown' && message.phase === 'racing')) clearInput(); if (message.phase === 'countdown') { resetNetwork(); clearCelebration(); } }
        updateUI();
        if (practicePending && message.hostId === localId && message.phase === 'lobby') { practicePending = false; send({ type: 'start' }); }
      } else if (message.type === 'snapshot') receiveSnapshot(message);
      else if (message.type === 'rooms') { if (!room) renderRooms(message.rooms); }
      else if (message.type === 'error') {
        practicePending = false;
        const notice = errors.get(message.message) || t('요청을 처리하지 못했습니다: {message}', { message: message.message });
        if (invite) { invite = null; updateUI(); }
        toast(notice);
      }
      else if (message.type === 'closed') {
        if (message.message === 'You left the room.') { room = null; environmentSync.setRoom(null, localId); snapshot = null; resetNetwork(); latestTick = -1; updateUI(); refreshRooms(); }
        else fail(t('서버가 연결을 종료했습니다. 서버를 실행한 뒤 다시 연결해 주세요.'));
      }
    } catch (error) { console.error('Server message processing error', error); fail(t('서버 응답을 처리하지 못했습니다. 다시 연결해 주세요.')); }
  });
  socket.addEventListener('close', () => { if (!fatal) fail(t('서버와 연결이 끊겼습니다. 서버와 네트워크를 확인하고 다시 연결해 주세요.')); });
  socket.addEventListener('error', () => { if (!fatal) fail(t('서버에 연결할 수 없습니다. npm start로 서버를 실행한 주소인지 확인해 주세요.')); });
}
for (const [id, vehicle] of Object.entries(VEHICLES)) {
  const option = document.createElement('option'); option.value = id; option.textContent = `${id} · ${t(vehicle.description)}`; $('vehicle').append(option);
}
for (const id of ['room-vehicle', 'result-vehicle', 'spectator-vehicle']) {
  $(id).replaceChildren(...[...$('vehicle').options].map(option => option.cloneNode(true)));
  $(id).addEventListener('change', () => send({ type: 'vehicle', vehicle: $(id).value }));
}
try {
  const saved = driverPreferences(document.cookie);
  $('name').value = saved.name; $('vehicle').value = saved.vehicle;
  nameConfirmed = hasDriverName(document.cookie);
} catch { /* Cookie restrictions must not prevent playing. */ }
function submitDriverName(event) {
  event.preventDefault();
  const input = $('welcome-name'), name = Array.from(input.value.replace(/[\x00-\x1f\x7f]/g, '').trim()).slice(0, 16).join('');
  if (!name) { input.setCustomValidity(t('드라이버 이름을 입력해 주세요.')); input.reportValidity(); return; }
  $('name').value = name; nameConfirmed = true; saveDriver();
  $('driver-welcome').close(); updateUI();
}
function saveDriver() {
  try { for (const cookie of driverCookies($('name').value, $('vehicle').value)) document.cookie = cookie; }
  catch { toast(t('선택값을 쿠키에 저장할 수 없습니다. 브라우저 설정을 확인하세요.')); }
}
function enterRoom(type, code, practice = false) {
  if (!assetsReady || !connected || fatal || room || !nameConfirmed) return;
  practicePending = practice; saveDriver();
  send({ type, name: $('name').value.trim().slice(0, 16) || 'Rider', vehicle: $('vehicle').value, ...(type === 'create' ? { trackId: selectedTrackId, laps: selectedLaps, timeOfDay: $('time-of-day').value, musicMode: selectedMusic.mode, musicTrack: selectedMusic.track, environment: browserEnvironment() } : {}), ...(code ? { code, wait: true } : {}) });
}
if (invite) {
  $('room-code').value = invite;
  $('invite-notice').textContent = t('방 {code}에 입장하는 중입니다.', { code: invite });
}
const vehicleAccelerationTimes = new Map();
function vehicleAccelerationTime(id) {
  if (vehicleAccelerationTimes.has(id)) return vehicleAccelerationTimes.get(id);
  const car = createCar('vehicle-spec', 0, id), straight = sampleTrack(0);
  let ticks = 0;
  while (car.speed < 100 / 3.6 && ticks < 30 / STEP) {
    Object.assign(car, straight);
    stepCar(car, { throttle: 1 }, STEP); ticks++;
  }
  const seconds = car.speed >= 100 / 3.6 ? ticks * STEP : null;
  vehicleAccelerationTimes.set(id, seconds);
  return seconds;
}
function describeVehicle() {
  const id = Object.hasOwn(VEHICLES, $('vehicle').value) ? $('vehicle').value : 'PULSE', vehicle = VEHICLES[id];
  const seconds = vehicleAccelerationTime(id);
  $('vehicle-performance').replaceChildren(...[[t('기본 최고 속도'), `${Math.round(vehicle.maxSpeed * 3.6)} km/h`],
    [t('0–100 km/h 가속'), seconds === null ? '—' : t('{seconds}초', { seconds: seconds.toFixed(1) })]].map(([label, value]) => {
    const stat = node('span', 'vehicle-stat'); stat.append(node('span', '', label), node('strong', '', value)); return stat;
  }));
  $('vehicle-info').replaceChildren(...[[t('상대 질량'), vehicle.mass], [t('반발'), `${Math.round(vehicle.restitution * 100)}%`]].map(([label, value]) => {
    const stat = node('span', 'vehicle-stat'); stat.append(node('span', '', label), node('strong', '', String(value))); return stat;
  }));
  $('preview-name').textContent = id;
  $('preview-description').textContent = t(vehicle.description);
  world?.previewVehicle(id);
}
$('vehicle').addEventListener('change', () => { describeVehicle(); saveDriver(); }); describeVehicle();
for (const course of Object.values(TRACKS)) {
  const row = node('div', 'circuit-row'), lapLabel = node('label', 'circuit-laps', t('랩 수'));
  const laps = node('select', ''); laps.id = `laps-${course.id}`;
  laps.setAttribute('aria-label', t('{course} 랩 수', { course: t(course.name) }));
  for (const count of LAP_OPTIONS[course.id]) { const option = node('option', '', t('{count}랩', { count })); option.value = String(count); laps.append(option); }
  lapLabel.append(laps);
  const button = node('button', 'circuit-option'); button.type = 'button';
  button.append(node('strong', '', t(course.name)), node('span', '', `${Math.round(course.length)} m · ${t('도로 폭 18m')}`));
  button.addEventListener('click', () => {
    selectedTrackId = course.id; selectedLaps = Number(laps.value); selectTrack(course.id); $('circuit-picker').close();
    enterRoom('create', null, practiceSelection);
  });
  row.append(button, lapLabel); $('circuit-options').append(row);
}
function chooseCircuit(practice = false) {
  if (!assetsReady || !connected || fatal || room || $('circuit-picker').open) return;
  practiceSelection = practice;
  for (const course of Object.values(TRACKS)) $(`laps-${course.id}`).value = String(LAP_OPTIONS[course.id][0]);
  $('time-of-day').value = 'auto';
  $('time-of-day-auto').textContent = t('자동 · 방장 현지 시간 {time} 기준', {
    time: new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }),
  });
  $('circuit-picker-title').textContent = practice ? t('연습할 서킷 선택') : t('방을 만들 서킷 선택');
  $('circuit-picker-help').textContent = practice ? t('서킷을 고르면 바로 연습을 시작합니다.') : t('서킷을 고르면 바로 방을 만듭니다.');
  $('circuit-picker').showModal();
  chooseMusic(0);
}
function chooseMusic(direction) {
  musicChoiceIndex = direction === 0 ? 0 : (musicChoiceIndex + direction + MUSIC_TRACKS.length + 1) % (MUSIC_TRACKS.length + 1);
  const song = musicChoiceIndex ? MUSIC_TRACKS[musicChoiceIndex - 1] : MUSIC_TRACKS[Math.floor(Math.random() * MUSIC_TRACKS.length)];
  selectedMusic = { mode: musicChoiceIndex ? 'sequence' : 'random', track: song.id };
  $('music-choice').textContent = musicChoiceIndex ? song.title : t('랜덤');
  audio.setMusic(selectedMusic, 'preview');
}
$('music-previous').addEventListener('click', () => chooseMusic(-1));
$('music-next').addEventListener('click', () => chooseMusic(1));
$('cancel-circuit').addEventListener('click', () => { $('circuit-picker').close(); audio.setMusic(null); });
$('circuit-picker').addEventListener('cancel', () => audio.setMusic(null));
selectTrack(track.id);
$('name').addEventListener('input', saveDriver);
$('driver-welcome-form').addEventListener('submit', submitDriverName);
$('welcome-name').addEventListener('input', () => $('welcome-name').setCustomValidity(''));
$('driver-welcome').addEventListener('cancel', event => event.preventDefault());
$('create').addEventListener('click', () => chooseCircuit());
$('practice').addEventListener('click', () => chooseCircuit(true));
$('join-form').addEventListener('submit', event => { event.preventDefault(); enterRoom('join', $('room-code').value.trim()); });
$('refresh-rooms').addEventListener('click', refreshRooms);
setInterval(() => { if (!document.hidden) refreshRooms(); }, 3000);
for (const id of ['ready', 'result-ready', 'spectator-ready']) $(id).addEventListener('click', () => send({ type: 'ready', ready: ![...(room?.players || []), ...(room?.waiting || [])].find(p => p.id === localId)?.ready }));
$('watch-target').addEventListener('change', () => { watchSelection = $('watch-target').value; updateWatchTarget(); });
for (const id of ['start', 'restart']) $(id).addEventListener('click', () => requestStart());
$('cancel-start').addEventListener('click', () => $('start-confirm').close());
$('confirm-start').addEventListener('click', () => { $('start-confirm').close(); requestStart(true); });
document.querySelectorAll('.leave').forEach(button => button.addEventListener('click', requestExit));
$('cancel-leave').addEventListener('click', () => $('leave-confirm').close());
$('confirm-leave').addEventListener('click', () => { $('leave-confirm').close(); exitRoom(); });
document.querySelector('#brand a').addEventListener('click', event => { if (room) { event.preventDefault(); requestExit(); } });
$('reload').addEventListener('click', () => location.reload());
$('connection').addEventListener('click', async () => {
  if (!room) return;
  try { await copyText(invitationUrl(location.origin, room.code)); toast(t('방 링크가 복사되었습니다.')); }
  catch { toast(t('방 링크를 복사하지 못했습니다. 방 공유하기를 이용해 주세요.')); }
});
$('copy-code').addEventListener('click', async () => {
  try { await copyText(room.code); toast(t('방 코드를 복사했습니다. 친구에게 공유해 주세요.')); }
  catch { toast(t('방 코드는 {code}입니다. 이 코드를 친구에게 알려주세요.', { code: room.code })); }
});
async function shareRoom() {
  if (!$('share-box').open) $('share-box').showModal();
  let origin;
  try { origin = new URL($('share-origin').value); if (!['http:', 'https:'].includes(origin.protocol)) throw new Error(); }
  catch { $('share-status').textContent = t('친구가 접속할 수 있는 http:// 또는 https:// 서버 주소를 입력하세요.'); $('share-origin').focus(); return; }
  const text = t('LANRider · 방 {code}\n{url}', { code: room.code, url: invitationUrl(origin.origin, room.code) });
  $('share-message').value = text;
  $('share-message').focus(); $('share-message').select();
  try { await copyText(text); $('share-status').textContent = t('초대 링크를 복사했습니다. 링크를 열면 바로 입장합니다.'); }
  catch { $('share-status').textContent = t('선택된 초대 내용을 Ctrl+C로 복사해 공유하세요.'); }
}
$('share-room').addEventListener('click', shareRoom);
$('copy-share').addEventListener('click', shareRoom);
$('close-share').addEventListener('click', () => $('share-box').close());
addEventListener('keydown', event => {
  if (event.code === 'F3') {
    event.preventDefault(); if (!event.repeat) setDebug(!debugToggle.checked); return;
  }
  const starting = phase() === 'countdown' && healthy() && room?.players.some(player => player.id === localId);
  const orbiting = room && phase() === 'lobby' && healthy() && ['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'].includes(event.code);
  if (!drivingKeys.has(event.code) || (!racing() && !starting && !orbiting) || document.hidden ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.tagName === 'BUTTON' && !orbiting || event.target.isContentEditable) return;
  event.preventDefault(); if (event.repeat || keys.has(event.code)) return;
  keys.add(event.code);
  if (event.code === 'KeyW' || event.code === 'ArrowUp') sendStartInput();
});
addEventListener('keyup', event => {
  if (!drivingKeys.has(event.code)) return;
  if (racing() && !/^(BUTTON|INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) event.preventDefault();
  keys.delete(event.code);
  if (event.code === 'KeyW' || event.code === 'ArrowUp') sendStartInput();
});
addEventListener('blur', clearInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearInput(); audio.updateCar(null, performance.now() / 1000); }
});
$('world').addEventListener('webglcontextlost', event => { event.preventDefault(); fail(t('3D 그래픽 연결이 끊겼습니다. 다른 그래픽 작업을 닫고 다시 연결해 주세요.')); });
setInterval(() => { if (racing() && !document.hidden) sendInput(); }, 1000 / 30);

const minimap = $('minimap').getContext('2d');
function updateWrongWay(now) {
  const wrong = racing() && !document.hidden && !snapshot?.cars.find(car => car.id === localId)?.finished && isWrongWay(predicted);
  if (wrong) wrongWaySince ??= now;
  else wrongWaySince = null;
  $('wrong-way-warning').hidden = wrongWaySince === null || now - wrongWaySince < 600;
}
function hud(states, now) {
  if (!snapshot || !room) return;
  updateRematchUI(now);
  updateForcedStartUI(now);
  const extraTime = phase() === 'racing' && healthy() ? (now - lastSnapshotAt + (snapshot.serverNow - snapshot.stateTime || 0)) / 1000 : 0;
  const finishSeconds = snapshot.finishRemaining === null ? null : Math.max(0, Math.ceil(snapshot.finishRemaining - extraTime));
  $('finish-countdown').hidden = phase() !== 'racing' || finishSeconds === null;
  $('finish-countdown').textContent = finishSeconds === null ? '' : t('경기 종료까지 {seconds}초', { seconds: finishSeconds });
  const bounds = track.points.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), maxX: Math.max(b.maxX, p.x), minZ: Math.min(b.minZ, p.z), maxZ: Math.max(b.maxZ, p.z) }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
  const scale = Math.min(200 / (bounds.maxX - bounds.minX), 220 / (bounds.maxZ - bounds.minZ));
  const mapPoint = p => [120 + (p.x - (bounds.minX + bounds.maxX) / 2) * scale, 130 + (p.z - (bounds.minZ + bounds.maxZ) / 2) * scale];
  const followId = queued() ? watchId : localId;
  const authoritative = snapshot.cars.find(car => car.id === followId), me = queued() ? states.find(car => car.id === followId) || authoritative : predicted || authoritative;
  if (!me) return;
  $('speed').textContent = String(Math.round(Math.abs(me.speed) * 3.6));
  const laps = snapshot.laps ?? room.laps ?? LAPS;
  $('lap').replaceChildren(document.createTextNode(`${Math.min((authoritative?.lap || 0) + 1, laps)} `), node('small', '', `/ ${laps}`));
  const charge = Math.round(me.charge || 0);
  const stats = VEHICLES[me.vehicle] || VEHICLES.PULSE;
  $('charge').textContent = `${charge}%`; $('charge-bar').style.width = `${charge}%`;
  document.querySelector('.gauge').setAttribute('aria-valuenow', String(charge));
  $('race-time').textContent = clock(snapshot.raceTime + extraTime);
  const countdown = snapshot.countdown - (now - lastSnapshotAt) / 1000;
  $('countdown').textContent = phase() === 'countdown' ? String(Math.max(1, Math.ceil(countdown))) : phase() === 'racing' && snapshot.raceTime + extraTime < .8 ? 'GO!' : '';
  const winner = snapshot.finishers?.[0];
  $('race-notice').textContent = !healthy() ? t('연결을 기다리는 중 · 조작이 일시 정지되었습니다') : authoritative?.finished ? t('완주! 다른 드라이버를 기다리고 있습니다.') : winner ? t('🏁 {name} 선두 완주!', { name: winner.name }) : '';
  $('drive-state').textContent = me.boostTime > 0 ? 'BOOST / FULL SEND' : me.drifting ? 'DRIFT / CHARGING' : charge >= stats.boostCost ? 'BOOST / READY' : `${me.vehicle || 'PULSE'} / DRIVE`;
  document.querySelector('.gauge b').style.left = `${stats.boostCost}%`;
  document.body.classList.toggle('boosting', me.boostTime > 0 && racing());
  document.body.classList.toggle('drifting', me.drifting && racing());
  minimap.clearRect(0, 0, 240, 260); minimap.beginPath();
  track.points.forEach((p, i) => { const [x, y] = mapPoint(p); if (!i) minimap.moveTo(x, y); else minimap.lineTo(x, y); });
  minimap.strokeStyle = '#082e43b0'; minimap.lineWidth = 14; minimap.stroke();
  minimap.strokeStyle = '#d7edee'; minimap.lineWidth = 4; minimap.stroke();
  const [sx, sy] = mapPoint(sampleTrack(0, 0, track)); minimap.fillStyle = '#fff'; minimap.fillRect(sx - 6, sy - 2, 12, 4);
  for (const car of states) {
    const [x, y] = mapPoint(car); minimap.beginPath(); minimap.arc(x, y, car.id === localId ? 6 : 4.5, 0, Math.PI * 2);
    minimap.fillStyle = COLORS[car.slot]; minimap.fill(); minimap.strokeStyle = '#082e43'; minimap.lineWidth = 2; minimap.stroke();
  }
}
let previous = performance.now();
function simulate(now) {
  prediction.advance(now, racing() && !document.hidden ? input() : null);
  // Both timer and RAF finish due steps before reconciling or displaying a pose.
  if (pendingSnapshot) {
    prediction.receive(pendingSnapshot, localId, prediction.alpha); pendingSnapshot = null;
  }
  predicted = prediction.car;
}
setInterval(() => simulate(performance.now()), 8);
function frame(now) {
  requestAnimationFrame(frame);
  frameMs = now - previous;
  if (now - skyStatusAt >= 1000) { skyStatus(); skyStatusAt = now; }
  const dt = Math.min(frameMs / 1000, .1); previous = now;
  if (announcementUntil && now > announcementUntil) { $('finish-banner').hidden = true; announcementUntil = 0; }
  if (room && !healthy() && !stalled) { clearInput(); stalled = true; }
  if (healthy()) stalled = false;
  if (room && !fatal && lastSnapshotAt && now - lastSnapshotAt > 8000) { fail(t('서버 응답이 지연되고 있습니다. 네트워크를 확인하고 다시 연결해 주세요.')); socket.close(); }
  simulate(performance.now());
  updateWrongWay(now);
  audio.updateCar(racing() && !document.hidden ? predicted : null, now / 1000);
  audio.updateRace(room ? snapshot : null, Math.max(0, (now - lastSnapshotAt) / 1000), healthy() && !document.hidden);
  const states = [];
  const alpha = racing() && !document.hidden ? prediction.alpha : 1;
  const ownVisual = prediction.visual(frameMs / 1000, alpha);
  frameSamples.push(frameMs); alphaSamples.push(alpha > 1 ? 1 : 0);
  if (frameSamples.length > 180) { frameSamples.shift(); alphaSamples.shift(); }
  if (ownVisual) states.push({ ...ownVisual, steer: racing() ? input().steer : ownVisual.steer,
    braking: racing() && input().throttle * ownVisual.speed < -.1 });
  for (const car of snapshots.sample(now, racing() && !document.hidden ? prediction : null, alpha)) if (car.id !== localId) states.push(car);
  const enginePhase = Boolean(room && ['countdown', 'racing'].includes(phase()));
  audio.updateEngines(enginePhase && !queued() ? predicted : null, enginePhase ? states : [],
    racing() ? input().throttle : 0, enginePhase && healthy() && !document.hidden);
  if (world) {
    try { world.render(states, phase() === 'finished' ? room?.racePlayers || [] : room?.players || [], queued() ? watchId : localId, Boolean(room && ['countdown', 'racing', 'finished'].includes(phase())), dt, now / 1000, frameMs / 1000,
      room && phase() === 'lobby' && healthy() && !document.hidden ? input().steer : 0); }
    catch (error) { console.error(error); world = null; fail(t('3D 화면을 그리지 못했습니다. 브라우저의 하드웨어 가속을 확인하고 다시 연결해 주세요.')); }
  }
  if (now - hudAt > 65) { hud(states, now); hudAt = now; }
  if (!$('net-stats').hidden && now - statsAt > 250) {
    statsAt = now;
    const percentile = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : 0;
    const metrics = world?.stats() || {};
    const network = !connected ? t(fatal ? '연결 끊김' : '서버 연결 중') : room && !healthy() ? t('수신 지연') : t('서버 연결됨');
    $('net-stats').textContent = `FPS ${(1000 / (frameSamples.reduce((a,b) => a+b, 0) / frameSamples.length)).toFixed(1)} · frame ${frameMs.toFixed(1)} / p95 ${percentile(frameSamples).toFixed(1)} ms\n` +
      `network ${network}\n` +
      `snapshot age ${room && lastSnapshotAt ? Math.round(now - lastSnapshotAt) + ' ms' : '—'} · state lag ${snapshot ? Math.round(snapshot.serverNow - snapshot.stateTime || 0) + ' ms' : '—'}\n` +
      `ACK ${prediction.car?.lastInputSeq || 0} · pending ${prediction.pending.length} · outbox ${prediction.outbox.length}\n` +
      `correction ${(100 * (prediction.corrections.at(-1) || 0)).toFixed(1)} cm · p95 ${(100 * percentile(prediction.corrections)).toFixed(1)} cm\n` +
      `offset ${(100 * Math.hypot(prediction.error.x, prediction.error.z)).toFixed(1)} cm · camera ${(metrics.cameraLag || 0).toFixed(2)} m\n` +
      `alpha ${alpha.toFixed(2)} · clamped ${alphaSamples.reduce((a,b) => a+b, 0)}/${alphaSamples.length}\n` +
      `draw calls ${metrics.calls || 0} · triangles ${metrics.triangles || 0}\n` +
      `render ${metrics.drawingWidth || 0}×${metrics.drawingHeight || 0} · DPR ${metrics.pixelRatio?.toFixed(2) ?? '—'} · MSAA ${metrics.antialias ? 'on' : 'off'}\n` +
      `shadows ${metrics.shadows ? metrics.shadowSize + '²' : 'off'} · GPU ${metrics.gpu || '—'}\n` +
      `geometries ${metrics.geometries || 0} · textures ${metrics.textures || 0}`;
    const sound = audio.diagnostics(), song = sound.music;
    $('audio-stats').textContent = `BGM ${sound.activeBgm}/${sound.bgmElements} · ${song.state}${sound.activeBgm > 1 ? ' · DUPLICATE' : ''}\n` +
      `file ${song.file || '—'}\n` +
      `time ${song.currentTime.toFixed(1)} / ${song.duration?.toFixed(1) ?? '—'} s · ${song.mode} · ${song.source}\n` +
      `volume ${Math.round(song.volume * 100)}% · mute ${song.muted} · master ${sound.masterMuted} · loop ${song.loop}\n` +
      `play requests ${song.playRequests} · loads ${song.loads} · playing events ${song.starts}\n` +
      `active ${sound.activeMedia.join(', ') || '—'}\n` +
      `context ${sound.context} · tab ${sound.hidden ? 'hidden' : sound.focused ? 'focused' : 'inactive'}\n` +
      `last ${song.lastEvent} · error ${song.lastError || '—'}`;
  }
}
connect();
createScene($('world'), text => { if (!fatal) $('loading-status').textContent = text; })
  .then(async scene => { world = scene; world.setGraphicsQuality(graphicsSelect.value); world.setEnvironment(environmentSync.current());
    world.setCollisionDebug(debugToggle.checked);
    if (!graphicsChosen && !fatal) $('loading-status').textContent = t('그래픽 성능을 확인하고 있습니다…');
    await autoGraphicsQuality();
    selectTrack(room?.trackId || selectedTrackId); describeVehicle(); assetsReady = true; updateUI(); })
  .catch(error => { console.error(error); fail(t('3D 에셋을 불러오지 못했습니다. 서버 파일과 브라우저의 WebGL 지원을 확인한 뒤 다시 연결해 주세요.')); });
requestAnimationFrame(frame);
