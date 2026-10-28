import { MUSIC_TRACKS } from '../shared/music.js';

export function createMusicCache({ fetch = globalThis.fetch, storage = globalThis.caches } = {}) {
  const memory = new Map();
  let store;
  const disk = () => store ??= Promise.resolve().then(() => storage?.open('localhost-rider-music-v1')).catch(() => null);
  function keep(id, blob) {
    memory.delete(id); memory.set(id, blob);
    if (memory.size > MUSIC_TRACKS.length) memory.delete(memory.keys().next().value);
  }
  return {
    async remember(track, signal) {
      if (memory.has(track.id)) return;
      const cached = await disk();
      const response = await cached?.match(track.src) || await fetch(track.src, { cache: 'force-cache', signal });
      if (response.status !== 200) return;
      const blob = await response.blob();
      if (signal?.aborted || !blob.size) return;
      keep(track.id, blob);
      await cached?.put(track.src, new Response(blob, { headers: { 'Content-Type': 'audio/mpeg' } }));
    },
    async match(track) {
      if (memory.has(track.id)) return memory.get(track.id);
      try {
        const response = await (await disk())?.match(track.src) ||
          await fetch(track.src, { cache: 'only-if-cached', mode: 'same-origin' });
        if (response.status !== 200) return null;
        const blob = await response.blob();
        if (!blob.size) return null;
        keep(track.id, blob); return blob;
      } catch { return null; }
    },
  };
}

export function createMusicPlayer(media, { tracks = MUSIC_TRACKS, cache = createMusicCache(), fade = () => {},
  onChange = () => {}, onError = () => {}, random = Math.random, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let current = null, session = null, mode = 'random', generation = 0, timer, download, objectURL, playing, recovering = false, failed = false;
  let audible = true, blocked = false, loads = 0, playRequests = 0, starts = 0, lastEvent = 'idle', lastError = null;
  const rejected = new Set();
  media.loop = false; media.preload = 'none';
  const notify = () => onChange(current);
  function cancel() { clearTimer(timer); download?.abort(); }
  function remember() {
    if (!current || objectURL) return;
    download?.abort(); download = new AbortController();
    void cache.remember(current, download.signal).catch(() => {});
  }
  function releaseURL() { if (objectURL) URL.revokeObjectURL(objectURL); objectURL = null; }
  function resume() {
    if (!current || failed) return;
    if (!audible || media.muted || !media.volume) { playing = null; media.pause(); return; }
    if (!media.paused || playing) return;
    const token = generation, ticket = Symbol(); playing = ticket;
    playRequests++;
    media.play().catch(error => {
      if (token !== generation || playing !== ticket) return;
      lastError = error.name; blocked = error.name === 'NotAllowedError';
      if (['NotAllowedError', 'AbortError'].includes(error.name)) return;
      void recover();
    }).finally(() => { if (playing === ticket) playing = null; });
  }
  function load(track, blob = null) {
    releaseURL(); current = track; failed = blocked = false; playing = null; loads++; lastError = null;
    media.pause(); fade(0, 0);
    media.src = blob ? (objectURL = URL.createObjectURL(blob)) : track.src;
    media.load(); notify(); resume();
  }
  async function recover() {
    if (!current || recovering || failed) return;
    recovering = true; rejected.add(current.id); download?.abort();
    const token = generation;
    // Only cache lookups: failure never downloads the rest of the playlist.
    for (const track of [current, ...(mode === 'random' ? tracks.filter(track => track.id !== current.id) : [])]) {
      const blob = await cache.match(track).catch(() => null);
      if (token !== generation) return;
      if (!blob || (rejected.has(track.id) && track !== current)) continue;
      if (track === current && objectURL) continue;
      recovering = false; load(track, blob); return;
    }
    recovering = false; failed = true; media.pause(); fade(0, .15); onError(); notify();
  }
  function select(choice, key = 'preview') {
    const identity = choice ? `${key}:${choice.mode}:${choice.track}` : null;
    if (identity === session) return;
    session = identity; generation++; clearTimer(timer); recovering = false; rejected.clear();
    const token = generation;
    if (!choice) {
      download?.abort();
      fade(0, .25); current = null; notify();
      timer = setTimer(() => { if (token !== generation) return; media.pause(); media.removeAttribute('src'); media.load(); releaseURL(); }, 250);
      return;
    }
    const next = tracks.find(track => track.id === choice.track);
    if (!next) return;
    mode = choice.mode === 'sequence' ? 'sequence' : 'random';
    if (current?.id === next.id && !failed) {
      if (!media.paused) { fade(1, .15); if (download?.signal.aborted) remember(); }
      resume(); return;
    }
    download?.abort();
    const start = () => { if (token === generation) load(next); };
    if (!media.paused && current) { fade(0, .25); timer = setTimer(start, 250); }
    else start();
  }
  media.addEventListener('playing', () => {
    if (!current) return;
    if (!audible) { media.pause(); return; }
    blocked = false; starts++;
    fade(1, .4); notify();
    // The browser streams directly. Only the song actually playing gets a compressed fallback copy.
    remember();
  });
  for (const event of ['pause', 'volumechange']) media.addEventListener(event, notify);
  media.addEventListener('error', () => { lastError = `MediaError ${media.error?.code ?? 'unknown'}`; void recover(); });
  for (const event of ['loadstart', 'playing', 'pause', 'waiting', 'stalled', 'ended', 'error', 'emptied']) {
    media.addEventListener(event, () => { lastEvent = event; });
  }
  media.addEventListener('timeupdate', () => {
    const remaining = media.duration - media.currentTime;
    if (current && Number.isFinite(remaining) && remaining > 0 && remaining <= .6) fade(0, remaining);
  });
  media.addEventListener('ended', () => {
    if (!current || !audible || media.muted || !media.volume) return;
    const candidates = tracks.filter(track => track.id !== current.id);
    const next = mode === 'random' && candidates.length ? candidates[Math.floor(random() * candidates.length)] : current;
    if (next) { generation++; cancel(); rejected.clear(); recovering = false; load(next); }
  });
  return { select, resume, get track() { return current; },
    setAudible(value) { audible = value; if (value) resume(); else { playing = null; media.pause(); } },
    diagnostics() {
      return { file: current?.src.split('/').at(-1).split('?')[0] ?? null, mode, source: objectURL ? 'cache' : 'stream',
        state: !current ? 'stopped' : !audible ? 'suspended' : failed ? 'failed' : blocked ? 'blocked' : media.paused ? 'paused' : media.readyState < 3 ? 'buffering' : 'playing',
        currentTime: Number(media.currentTime) || 0, duration: Number.isFinite(media.duration) ? media.duration : null,
        muted: media.muted, volume: media.volume, loop: media.loop, loads, playRequests, starts, lastEvent, lastError };
    },
  };
}
