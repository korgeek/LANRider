import { t } from './i18n.js';
import { createEngineAudio } from './engine-audio.js';
import { TRACKS } from '../shared/game.js';
import { MUSIC_TRACKS } from '../shared/music.js';
import { createMusicPlayer } from './music.js';
import { createAudioMix } from './audio-mix.js';

export function initAudio(document, engines, { tracks = MUSIC_TRACKS, cache, mix = createAudioMix() } = {}) {
  const $ = id => document.getElementById(id);
  let focused = document.hasFocus?.() ?? true;
  const ambient = $('ambient-audio'), music = $('music-audio');
  const collision = $('collision-audio'), boost = $('boost-audio');
  const drifts = [$('drift-d02-audio'), $('drift-d03-audio')], drivingEffects = [collision, boost, ...drifts];
  const tick = $('countdown-tick-audio'), go = $('countdown-go-audio'), cheer = $('finish-audio');
  const raceEffects = [tick, go, cheer], effects = [...drivingEffects, ...raceEffects];
  mix.attach([ambient, music, ...effects], music);
  engines ??= createEngineAudio({ createContext: () => mix.context, output: () => mix.input });
  let saved = {};
  try {
    const cookie = document.cookie.split(';').find(part => part.trim().startsWith('nextrider_audio='));
    if (cookie) saved = JSON.parse(decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)));
  } catch { /* Cookies may be blocked or malformed; keep the defaults. */ }
  let masterMuted = saved?.masterMuted === true;
  const settings = { masterMuted };
  mix.setMuted(masterMuted);
  function save(id, audio) {
    settings[id] = { volume: Math.round(audio.volume * 100), muted: audio.muted };
    try { document.cookie = `nextrider_audio=${encodeURIComponent(JSON.stringify(settings))}; Path=/; Max-Age=31536000; SameSite=Lax`; }
    catch { /* Sound controls remain usable when storage is blocked. */ }
  }
  let circuit = null, engineRace = null, previousCar = null, driftSound = null, lastImpact = -Infinity, raceCue = null, player;
  let raceMusic = null, musicPhase = 'preview';
  function startRaceMusic() {
    if (musicPhase === 'racing' && raceMusic?.choice && raceCue?.musicReady) {
      player.select(raceMusic.choice, `${raceMusic.session}:${raceCue.id}`);
    }
  }
  go.addEventListener('ended', () => {
    if (raceCue?.phase === 'racing') { raceCue.musicReady = true; startRaceMusic(); }
  });
  function credit() {
    const song = player?.track, visible = song && !music.paused && !music.muted && music.volume > 0;
    $('music-status').hidden = !visible;
    $('music-status').textContent = song ? `♪ ${song.artist} · ${song.title}` : '';
  }
  player = createMusicPlayer(music, { tracks, cache, fade: (value, seconds) => mix.fadeMusic(value, seconds), onChange: credit,
    onError: () => { $('sound-status').textContent = t('음악을 불러오지 못했습니다. 다른 곡을 선택해 다시 시도하세요.'); } });
  player.setAudible(!document.hidden && focused && !masterMuted);
  function play(audio) {
    if (audio === music) { player.resume(); return; }
    if (document.hidden || !focused || masterMuted) { audio.pause(); return; }
    if (audio.muted || !audio.volume || (audio === ambient && !audio.src) || !audio.paused) return;
    const source = audio.src;
    audio.play().catch(error => {
      if (source !== audio.src || ['NotAllowedError', 'AbortError'].includes(error.name)) return;
      audio.muted = true;
      $('sound-status').textContent = t('소리를 재생하지 못했습니다. 음소거를 해제해 다시 시도하세요.');
      credit();
    });
  }
  function stopEffects() {
    for (const effect of drivingEffects) { effect.pause(); effect.currentTime = 0; }
    previousCar = driftSound = null; lastImpact = -Infinity;
  }
  function oneShot(effect) { effect.pause(); effect.currentTime = 0; play(effect); }
  function drift() {
    driftSound = drifts[Math.floor(Math.random() * drifts.length)]; oneShot(driftSound);
  }
  for (const effect of drifts) effect.addEventListener('ended', () => {
    if (effect === driftSound && previousCar?.drifting) drift();
  });
  for (const [id, channel, defaultVolume] of [['ambient', [ambient], 30], ['music', [music], 50], ['sfx', effects, 20]]) {
    const audio = channel[0];
    const slider = $(`${id}-volume`), mute = $(`${id}-mute`);
    const stored = saved?.[id];
    slider.value = String(Number.isInteger(stored?.volume) && stored.volume >= 0 && stored.volume <= 100 ? stored.volume : defaultVolume);
    for (const item of channel) {
      item.loop = id === 'ambient'; item.volume = Number(slider.value) / 100; item.muted = stored?.muted === true;
    }
    settings[id] = { volume: Number(slider.value), muted: audio.muted };
    const resume = () => { if (id !== 'sfx') play(audio); else if (driftSound) play(driftSound); };
    function render() {
      if (id === 'sfx') engines.setVolume(settings.sfx.volume / 100, settings.sfx.muted);
      const silent = audio.muted || audio.volume === 0;
      mute.setAttribute('aria-pressed', String(silent));
      mute.textContent = t(silent ? '음소거 해제' : '음소거');
      mute.setAttribute('aria-label', t('{channel} {action}', {
        channel: t(id === 'ambient' ? '앰비언트' : id === 'music' ? '음악' : '효과음'), action: mute.textContent,
      }));
      $(`${id}-level`).textContent = `${Math.round(audio.volume * 100)}%`;
      credit();
    }
    slider.addEventListener('input', () => {
      for (const item of channel) {
        item.volume = Number(slider.value) / 100;
        if (item.volume > 0) item.muted = false;
      }
      save(id, audio); render(); resume();
    });
    mute.addEventListener('click', () => {
      const muted = !(audio.muted || audio.volume === 0);
      if (!muted && !audio.volume) slider.value = String(defaultVolume);
      for (const item of channel) { item.muted = muted; item.volume = Number(slider.value) / 100; }
      save(id, audio); render(); resume();
    });
    audio.addEventListener('volumechange', render);
    render();
  }
  for (const event of ['playing', 'pause', 'emptied']) music.addEventListener(event, credit);
  for (const event of ['pointerdown', 'keydown']) document.addEventListener(event, input => {
    void mix.unlock().catch(() => { $('sound-status').textContent = t('소리를 재생하지 못했습니다. 음소거를 해제해 다시 시도하세요.'); });
    engines.unlock().catch(error => {
      if (error.name !== 'NotAllowedError') $('sound-status').textContent = t('엔진음을 불러오지 못했습니다. 다시 클릭해 재시도하세요.');
    });
    if ($('sound-settings').contains(input.target)) return;
    play(ambient); play(music); if (driftSound) play(driftSound);
  });
  function syncAudibility() {
    const audible = !document.hidden && focused && !masterMuted;
    player.setAudible(audible);
    if (audible) play(ambient); else ambient.pause();
    if (!audible) { engines.setAudible(false); for (const effect of effects) effect.pause(); }
  }
  document.addEventListener('visibilitychange', syncAudibility);
  document.defaultView?.addEventListener('focus', () => { focused = true; syncAudibility(); });
  document.defaultView?.addEventListener('blur', () => { focused = false; syncAudibility(); });
  function renderMaster() {
    $('master-mute').setAttribute('aria-pressed', String(masterMuted));
    $('master-mute').setAttribute('aria-label', t(masterMuted ? '전체 소리 음소거 해제' : '전체 소리 음소거'));
    $('master-mute').title = t(masterMuted ? '전체 소리 음소거 해제' : '전체 소리 음소거');
  }
  $('master-mute').addEventListener('click', () => {
    masterMuted = !masterMuted; settings.masterMuted = masterMuted; mix.setMuted(masterMuted);
    try { document.cookie = `nextrider_audio=${encodeURIComponent(JSON.stringify(settings))}; Path=/; Max-Age=31536000; SameSite=Lax`; } catch { /* The button still works without cookies. */ }
    renderMaster(); syncAudibility();
  });
  renderMaster();
  play(ambient);
  return {
    diagnostics() {
      const media = [...(document.querySelectorAll?.('audio') ?? [ambient, music, ...effects])];
      const active = media.filter(item => !item.paused && !item.ended && !item.muted && item.volume > 0);
      const bgm = media.filter(item => item === music || tracks.some(track => (item.currentSrc || item.src || '').endsWith(track.src)));
      return { music: player.diagnostics(), bgmElements: bgm.length, activeBgm: active.filter(item => bgm.includes(item)).length,
        activeMedia: active.map(item => item.id || 'audio'), hidden: Boolean(document.hidden), focused, masterMuted, context: mix.context?.state ?? 'locked' };
    },
    setMusic(choice, session, phase = 'preview') {
      musicPhase = phase;
      raceMusic = phase === 'preview' ? null : { choice, session };
      if (phase === 'preview') player.select(choice, session);
      else if (phase !== 'racing') player.select(null);
      else startRaceMusic();
    },
    setRace(id, raceId = null) {
      const next = Object.hasOwn(TRACKS, id) ? id : null;
      if (engineRace !== raceId || next !== circuit) {
        engines.clear(); engineRace = raceId; raceCue = null; stopEffects();
        for (const effect of raceEffects) { effect.pause(); effect.currentTime = 0; }
      }
      if (next === circuit) return;
      circuit = next; stopEffects();
    },
    updateEngines(own, others, throttle, audible) { engines.update(own, others, throttle, audible && focused && !masterMuted); },
    updateRace(state, elapsed = 0, audible = true) {
      if (!circuit || !state) return;
      if (raceCue?.id !== state.raceId) raceCue = { id: state.raceId, count: Infinity, phase: null, go: false, cheered: false, musicReady: false };
      const count = Math.max(0, Math.ceil(state.countdown - elapsed));
      if (state.phase === 'countdown' && count < raceCue.count) {
        raceCue.count = count;
        if (audible && count >= 1 && count <= 3) oneShot(tick);
      }
      if (state.phase === 'racing' && !raceCue.go) {
        raceCue.go = true;
        const age = state.raceTime + elapsed + Math.max(0, (state.serverNow - state.stateTime) / 1000 || 0);
        if (audible && age < .35) oneShot(go);
      }
      const age = state.raceTime + elapsed + Math.max(0, (state.serverNow - state.stateTime) / 1000 || 0);
      if (state.phase === 'racing' && age >= (Number.isFinite(go.duration) ? go.duration : .3) && (go.paused || go.ended)) {
        raceCue.musicReady = true; startRaceMusic();
      }
      if (state.phase === 'finished' && !raceCue.cheered) {
        raceCue.cheered = true;
        if (audible && ['countdown', 'racing'].includes(raceCue.phase)) oneShot(cheer);
      }
      raceCue.phase = state.phase;
    },
    updateCar(car, now) {
      if (!circuit || !car || car.finished) { if (previousCar) stopEffects(); return; }
      if (previousCar && (car.id !== previousCar.id || car.resetId !== previousCar.resetId)) stopEffects();
      if (car.collisionTime > (previousCar?.collisionTime || 0) + .04 && now - lastImpact > .18) {
        oneShot(collision); lastImpact = now;
      }
      if (car.boostTime > 0 && (!(previousCar?.boostTime > 0) ||
        (car.boostPadInside && !previousCar?.boostPadInside && car.boostTime > previousCar.boostTime))) oneShot(boost);
      if (car.drifting && !previousCar?.drifting) drift();
      if (!car.drifting && driftSound) { driftSound.pause(); driftSound = null; }
      previousCar = { id: car.id, resetId: car.resetId, collisionTime: car.collisionTime,
        boostTime: car.boostTime, boostPadInside: car.boostPadInside, drifting: car.drifting };
    },
  };
}
