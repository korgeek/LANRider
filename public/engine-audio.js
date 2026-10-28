import { VEHICLES } from '../shared/game.js';

export const ENGINE_SOURCES = {
  sport: { src: '/assets/audio/engines/engine-sport-loop.wav' },
  rough: { src: '/assets/audio/engines/engine-rough-loop.wav' },
};
export const ENGINE_VEHICLES = {
  PULSE: 'sport', APEX: 'sport', BOLT: 'sport', COMET: 'sport',
  BULWARK: 'rough', SLIDE: 'sport', IGNIS: 'sport', RALLY: 'rough',
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const speedOf = car => Number.isFinite(car.speed) ? Math.abs(car.speed) : 0;

export function createEngineAudio({ createContext = () => {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  return Context ? new Context({ latencyHint: 'interactive' }) : null;
}, fetch = globalThis.fetch, random = Math.random, output = () => null } = {}) {
  let context, master, loading, level = .7, muted = false, audible = false;
  const buffers = new Map(), voices = new Map();
  function masterVolume() {
    master?.gain.setTargetAtTime(audible && !muted ? level : 0, context.currentTime, .02);
  }
  function retire(voice) {
    voice.gain.gain.setTargetAtTime(0, context.currentTime, .015);
    voice.source.stop(context.currentTime + .12);
    voice.source.onended = () => { voice.source.disconnect(); voice.filter.disconnect(); voice.gain.disconnect(); };
  }
  function target(voice, key, param, value) {
    const previous = voice.targets[key];
    if (Math.abs(value - previous) < .0001) return;
    param.setTargetAtTime(value, context.currentTime, value > previous ? .2 : .5);
    voice.targets[key] = value;
  }
  return {
    async unlock() {
      if (!context) {
        context = createContext(); if (!context) return false;
        master = context.createGain(); master.gain.value = 0; master.connect(output() || context.destination); masterVolume();
      }
      if (!loading) loading = Promise.all(Object.entries(ENGINE_SOURCES).map(async ([name, { src }]) => {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`Engine audio unavailable: ${src}`);
        return [name, await context.decodeAudioData(await response.arrayBuffer())];
      })).then(entries => { for (const [name, buffer] of entries) buffers.set(name, buffer); })
        .catch(error => { loading = null; throw error; });
      await Promise.all([context.resume(), loading]); return true;
    },
    setVolume(volume, silent) { level = clamp(volume, 0, 1); muted = silent; masterVolume(); },
    setAudible(value) { if (audible !== value) { audible = value; masterVolume(); } },
    clear() { for (const voice of voices.values()) retire(voice); voices.clear(); },
    update(own, others, throttle, active = true) {
      this.setAudible(active);
      if (!context || buffers.size !== 2) return;
      const cars = new Map(others.filter(car => !car.finished).map(car => [car.id, car]));
      if (own && !own.finished) cars.set(own.id, own);
      // Put the local car first; one persistent voice per physical car, including distant cars.
      const ordered = own && cars.has(own.id) ? [own, ...[...cars.values()].filter(car => car.id !== own.id)] : [...cars.values()];
      for (const [id, voice] of voices) if (!cars.has(id) || cars.get(id).vehicle !== voice.vehicle) {
        retire(voice); voices.delete(id);
      }
      const listener = own || ordered[0];
      for (const car of ordered) {
        let voice = voices.get(car.id);
        if (!voice) {
          const source = context.createBufferSource(), filter = context.createBiquadFilter(), gain = context.createGain();
          const pitch = 1 + (random() * 2 - 1) * .04, variation = 10 ** ((random() * 2 - 1) * 1.5 / 20);
          source.buffer = buffers.get(ENGINE_VEHICLES[car.vehicle] || 'sport'); source.loop = true;
          source.loopStart = 0; source.loopEnd = source.buffer.duration; source.playbackRate.value = .85 * pitch;
          filter.type = 'lowpass'; filter.Q.value = .65; filter.frequency.value = 500; gain.gain.value = 0;
          source.connect(filter); filter.connect(gain); gain.connect(master);
          source.start(context.currentTime, random() * source.buffer.duration);
          voice = { vehicle: car.vehicle, source, filter, gain, pitch, variation, speed: speedOf(car), remoteLoad: .3,
            targets: { rate: .85 * pitch, gain: 0, cutoff: 500 } };
          voices.set(car.id, voice);
        }
        const speed = speedOf(car), local = car.id === own?.id;
        if (Math.abs(speed - voice.speed) > .02) voice.remoteLoad = speed > voice.speed ? .65 : 0;
        const load = local ? (throttle * (car.speed || 0) >= 0 || speed < 1 ? clamp(Math.abs(throttle), 0, 1) : 0) : speed < 1 ? 0 : voice.remoteLoad;
        const normalized = clamp(speed / (VEHICLES[car.vehicle]?.maxSpeed || VEHICLES.PULSE.maxSpeed), 0, 1);
        const distance = Math.hypot(car.x - listener.x, car.z - listener.z);
        const attenuation = local ? 1 : distance >= 90 ? 0 : .22 / (1 + (distance / 14) ** 2);
        target(voice, 'rate', voice.source.playbackRate, (.85 + normalized * .6) * voice.pitch);
        const gain = (.12 + normalized * .18 + load * .4) * voice.variation * attenuation;
        const localGain = voices.get(own?.id)?.targets.gain;
        target(voice, 'gain', voice.gain.gain, local || localGain === undefined ? gain : Math.min(gain, localGain * .25));
        target(voice, 'cutoff', voice.filter.frequency, 500 + normalized * 800 + load * 2200);
        voice.speed = speed;
      }
    },
  };
}
