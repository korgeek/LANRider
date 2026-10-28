import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createMusicPlayer, createMusicCache } from '../public/music.js';
import { MUSIC_TRACKS } from '../shared/music.js';

const testTracks = MUSIC_TRACKS.length > 1 ? MUSIC_TRACKS : [MUSIC_TRACKS[0], { id: 'test-other', title: 'Test other', artist: 'Test', src: '/test-other.mp3' }];

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

test('the music catalog matches its MP3 files and cache versions', async () => {
  const folder = new URL('../public/assets/audio/music/', import.meta.url);
  assert(MUSIC_TRACKS.length > 0);
  assert.equal(new Set(MUSIC_TRACKS.map(track => track.id)).size, MUSIC_TRACKS.length);
  assert.deepEqual((await readdir(folder)).filter(file => file.endsWith('.mp3')).sort(), MUSIC_TRACKS.map(track => `${track.id}.mp3`).sort());
  for (const track of MUSIC_TRACKS) {
    const bytes = await readFile(new URL(`${track.id}.mp3`, folder));
    assert(bytes.length > 0);
    assert.equal(new URL(track.src, 'http://localhost').searchParams.get('v'), createHash('sha256').update(bytes).digest('hex').slice(0, 12));
  }
});

test('waves match the supplied Pixabay recording', async () => {
  const bytes = await readFile(new URL('../public/assets/audio/ambient-waves.mp3', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '685ceeac28a4284b57472c7cec74fe5e4715909727cebed0e3e4ec5e471e2e65');
});

test('each song supports preview, room playback, cache and fixed repetition', async () => {
  for (const { id, title, src } of MUSIC_TRACKS) {
    const remembered = [], ui = setup({ remember: async track => remembered.push(track.id), match: async () => null });
    ui.player.select({ mode: 'sequence', track: id }, 'preview'); await settle();
    assert.equal(ui.player.track?.title, title); assert.equal(ui.media.src, src);
    assert.equal(ui.player.diagnostics().file, `${id}.mp3`);
    assert.deepEqual(remembered, [id]);
    ui.player.select({ mode: 'sequence', track: id }, 'room'); await settle();
    assert.equal(ui.media.loads, 1, 'the chosen preview continues into the room');
    ui.media.paused = true; ui.media.dispatchEvent(new Event('ended')); await settle();
    assert.equal(ui.player.track.id, id);
  }
});

test('replacement music URLs skip cached copies of the old files', async () => {
  for (const track of MUSIC_TRACKS) {
    const oldUrl = `/assets/audio/music/${track.id}.mp3`, requests = [], stored = [];
    const cache = createMusicCache({ storage: { open: async () => ({
      match: async url => url === oldUrl ? new Response('old mp3') : undefined,
      put: async url => stored.push(url),
    }) }, fetch: async url => { requests.push(url); return new Response('replacement mp3'); } });
    await cache.remember(track);
    assert.deepEqual(requests, [track.src]); assert.deepEqual(stored, [track.src]);
    assert.equal(await (await cache.match(track)).text(), 'replacement mp3');
  }
});

test('a selected song repeats while random playback moves to another song', async () => {
  const fixed = setup();
  fixed.player.select({ mode: 'sequence', track: testTracks[0].id }, 'room'); await settle();
  fixed.media.paused = true; fixed.media.dispatchEvent(new Event('ended')); await settle();
  assert.equal(fixed.player.track.id, testTracks[0].id);
  assert.equal(fixed.media.loads, 2);

  const random = setup();
  random.player.select({ mode: 'random', track: testTracks[0].id }, 'room'); await settle();
  random.media.paused = true; random.media.dispatchEvent(new Event('ended')); await settle();
  assert.notEqual(random.player.track.id, testTracks[0].id);
});

test('random mode repeats the sole available song and fixed mode does not substitute another song on failure', async () => {
  const single = setup(undefined, testTracks.slice(0, 1));
  single.player.select({ mode: 'random', track: testTracks[0].id }, 'room'); await settle();
  single.media.paused = true; single.media.dispatchEvent(new Event('ended')); await settle();
  assert.equal(single.player.track.id, testTracks[0].id);
  assert.equal(single.media.loads, 2);

  const fixed = setup({ remember: async () => {}, match: async track =>
    track.id === testTracks[1].id ? new Blob(['other']) : null });
  fixed.player.select({ mode: 'sequence', track: testTracks[0].id }, 'room'); await settle();
  fixed.media.dispatchEvent(new Event('error')); await settle();
  assert.equal(fixed.player.track.id, testTracks[0].id);
  assert.equal(fixed.player.diagnostics().state, 'failed');
});

test('music diagnostics expose blocked playback and repeated gestures without creating extra starts or loads', async () => {
  const ui = setup(); ui.media.failure = 'NotAllowedError';
  ui.player.select({ mode: 'sequence', track: testTracks[0].id }, 'room'); await settle();
  assert.equal(ui.player.diagnostics().state, 'blocked');
  assert.equal(ui.player.diagnostics().lastError, 'NotAllowedError');
  ui.media.failure = null; ui.player.resume(); await settle();
  ui.media.currentTime = 42;
  for (let i = 0; i < 30; i++) ui.player.resume();
  const info = ui.player.diagnostics();
  assert.equal(info.file, `${testTracks[0].id}.mp3`); assert.equal(info.state, 'playing');
  assert.equal(info.currentTime, 42); assert.equal(info.loads, 1);
  assert.equal(info.playRequests, 2); assert.equal(info.starts, 1); assert.equal(info.loop, false);
});

test('pending play promises cannot create duplicate requests or block resuming after a window switch', async () => {
  const ui = setup(), pending = [];
  ui.media.play = () => { ui.media.plays++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); };
  ui.player.select({ mode: 'sequence', track: testTracks[0].id }, 'room');
  for (let i = 0; i < 50; i++) ui.player.resume();
  assert.equal(ui.media.plays, 1);
  ui.player.setAudible(false); ui.player.setAudible(true);
  assert.equal(ui.media.plays, 2, 'pausing invalidates the old pending play request');
  pending[0].reject(new DOMException('Old request failed after focus changed', 'NotSupportedError')); await settle();
  assert.equal(ui.errors.length, 0, 'an obsolete play failure must not recover or stop the new request');
  for (let i = 0; i < 50; i++) ui.player.resume();
  assert.equal(ui.media.plays, 2, 'completion of an older request must not clear the current guard');
  ui.media.paused = false; ui.media.dispatchEvent(new Event('playing')); pending[1].resolve(); await settle();
  assert.equal(ui.player.diagnostics().loads, 1);
});
function setup(cache = { remember: async () => {}, match: async () => null }, tracks = testTracks) {
  const media = new EventTarget(), timers = new Map(), fades = [], changes = [], errors = [];
  let serial = 0;
  Object.assign(media, { paused: true, muted: false, volume: .45, src: '', plays: 0, loads: 0, duration: 120, currentTime: 0 });
  media.play = async () => {
    media.plays++; if (media.failure) throw new DOMException('Playback blocked', media.failure);
    media.paused = false; media.dispatchEvent(new Event('playing'));
  };
  media.pause = () => { media.paused = true; media.dispatchEvent(new Event('pause')); };
  media.load = () => { media.loads++; media.paused = true; media.currentTime = 0; };
  media.removeAttribute = () => { media.src = ''; };
  const player = createMusicPlayer(media, { tracks, cache, fade: (...args) => fades.push(args),
    onChange: (...args) => changes.push(args), onError: error => errors.push(error),
    setTimer: callback => { const id = ++serial; timers.set(id, callback); return id; },
    clearTimer: id => timers.delete(id), random: () => .99 });
  return { media, player, fades, changes, errors, flush() { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(callback => callback()); } };
}

test('music loads only a selected song, keeps room refreshes and repeats it when it ends', async () => {
  const remembered = [], ui = setup({ remember: async track => remembered.push(track.id), match: async () => null });
  assert.equal(ui.media.src, ''); assert.equal(ui.media.plays, 0);
  const choice = { mode: 'sequence', track: testTracks[1].id };
  ui.player.select(choice, 'room'); await settle();
  assert.equal(ui.media.src, testTracks[1].src); assert.equal(ui.player.track.title, testTracks[1].title);
  assert.equal(ui.media.loop, false); assert.equal(ui.media.preload, 'none');
  assert.deepEqual(remembered, [choice.track]);
  const plays = ui.media.plays, loads = ui.media.loads;
  for (let i = 0; i < 30; i++) { ui.player.select(choice, 'room'); ui.player.resume(); }
  assert.equal(ui.media.loads, loads); assert.equal(ui.media.plays, plays);
  ui.media.currentTime = 119.7; ui.media.dispatchEvent(new Event('timeupdate'));
  assert.equal(ui.fades.at(-1)[0], 0);
  ui.media.paused = true; ui.media.dispatchEvent(new Event('ended')); await settle();
  assert.equal(ui.player.track.id, choice.track); assert.equal(ui.media.volume, .45);
  ui.player.select(choice, 'room'); assert.equal(ui.player.track.id, choice.track, 'snapshots must not reset the playlist');
});

test('rapid selections cancel stale fades and entering a room keeps its already playing preview', async () => {
  const ui = setup(); ui.player.select({ mode: 'random', track: testTracks[0].id }, 'preview'); await settle();
  ui.player.select({ mode: 'sequence', track: testTracks[1].id }, 'preview');
  ui.player.select({ mode: 'sequence', track: testTracks[1].id }, 'preview'); ui.flush(); await settle();
  assert.equal(ui.media.src, testTracks[1].src); assert.equal(ui.media.loads, 2);
  const loads = ui.media.loads;
  ui.player.select({ mode: 'sequence', track: testTracks[1].id }, 'room'); await settle();
  assert.equal(ui.media.loads, loads);
  ui.player.select(null); ui.player.select({ mode: 'random', track: testTracks[0].id }, 'new-room'); ui.flush(); await settle();
  assert.equal(ui.media.src, testTracks[0].src); assert(!ui.media.paused);
  ui.media.paused = true; ui.media.dispatchEvent(new Event('ended')); await settle();
  assert.notEqual(ui.player.track.id, testTracks[0].id, 'random mode avoids immediate repeats');
});

test('returning to the playing preview and immediately creating a room cancels pending switches and restores its fade', async () => {
  const ui = setup(), first = { mode: 'sequence', track: testTracks[0].id };
  ui.player.select(first, 'preview'); await settle();
  ui.player.select({ mode: 'sequence', track: testTracks[1].id }, 'preview');
  ui.player.select(first, 'preview'); ui.player.select(first, 'room'); ui.flush(); await settle();
  assert.equal(ui.media.loads, 1); assert.equal(ui.media.src, testTracks[0].src);
  assert.equal(ui.fades.at(-1)[0], 1, 'canceled fade-out must become audible again');
});

test('entering a room with the current preview retains its in-flight compressed fallback download', async () => {
  let signal;
  const ui = setup({ remember: async (_track, selectedSignal) => { signal = selectedSignal; }, match: async () => null });
  const choice = { mode: 'random', track: testTracks[0].id };
  ui.player.select(choice, 'preview'); await settle();
  ui.player.select(choice, 'room');
  assert.equal(signal.aborted, false);
});

test('blocked autoplay waits for a gesture; mute/zero volume prevent playback and preserve position', async () => {
  const ui = setup(); ui.media.failure = 'NotAllowedError';
  ui.player.select({ mode: 'sequence', track: testTracks[0].id }, 'room'); await settle();
  assert(ui.media.paused); assert.equal(ui.errors.length, 0);
  ui.media.failure = null; ui.player.resume(); await settle(); assert(!ui.media.paused);
  ui.media.currentTime = 42; ui.media.muted = true; ui.player.resume(); assert(ui.media.paused);
  ui.media.muted = false; ui.player.resume(); await settle(); assert.equal(ui.media.currentTime, 42);
  ui.media.volume = 0; ui.player.resume(); assert(ui.media.paused);
});

test('download failure uses an available cached song without changing mute or looping through uncached downloads', async () => {
  const requests = [], remembered = [];
  const ui = setup({ remember: async track => remembered.push(track.id), match: async track => {
    requests.push(track.id); return track.id === testTracks[0].id ? new Blob(['cached mp3'], { type: 'audio/mpeg' }) : null;
  } });
  ui.player.select({ mode: 'random', track: testTracks[1].id }, 'room'); await settle();
  ui.media.paused = true; ui.media.dispatchEvent(new Event('error')); await settle();
  ui.flush(); await settle();
  assert.match(ui.media.src, /^blob:/); assert.equal(ui.player.track.id, testTracks[0].id);
  assert.equal(ui.media.muted, false); assert(!ui.media.paused);
  assert(requests.length <= testTracks.length);
  assert.deepEqual(remembered, [testTracks[1].id], 'cached fallback does not download again');
});

test('stopped and superseded cache lookups cannot restart playback', async () => {
  let resolveCache;
  const ui = setup({ remember: async () => {}, match: () => new Promise(resolve => { resolveCache = resolve; }) });
  ui.player.select({ mode: 'sequence', track: testTracks[0].id }, 'one'); await settle();
  ui.media.dispatchEvent(new Event('error')); await settle();
  ui.player.select(null); ui.flush();
  resolveCache(new Blob(['old'])); await settle(); ui.flush();
  assert(ui.media.paused); assert.equal(ui.media.src, '');
});

test('compressed cache fetches only requested songs, recovers from storage denial and does not decode PCM', async () => {
  const requests = [], cache = createMusicCache({ storage: { open: async () => { throw new Error('HTTP LAN storage unavailable'); } },
    fetch: async (url, options) => { requests.push([url, options.cache]); return new Response(new Blob(['mp3'], { type: 'audio/mpeg' })); } });
  assert.equal(requests.length, 0);
  await cache.remember(testTracks[1]); await cache.remember(testTracks[1]);
  const blob = await cache.match(testTracks[1]);
  assert.equal(await blob.text(), 'mp3'); assert.equal(requests.length, 1);
  assert.equal(requests[0][0], testTracks[1].src);
});
