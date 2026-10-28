export function createAudioMix({ createContext = () => {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  return Context ? new Context({ latencyHint: 'interactive' }) : null;
} } = {}) {
  let context, input, music, elements = [], musicElement, target = 0, muted = false;
  return {
    get context() { return context; }, get input() { return input; },
    attach(items, song) { elements = items; musicElement = song; },
    async unlock() {
      if (!context) {
        context = createContext(); if (!context) return false;
        input = context.createGain(); input.gain.value = muted ? 0 : .65;
        const compressor = context.createDynamicsCompressor(), ceiling = context.createWaveShaper();
        Object.assign(compressor.threshold, { value: -8 }); compressor.knee.value = 8; compressor.ratio.value = 12;
        compressor.attack.value = .003; compressor.release.value = .18;
        ceiling.curve = new Float32Array([-.9, 0, .9]); ceiling.oversample = 'none';
        input.connect(compressor); compressor.connect(ceiling); ceiling.connect(context.destination);
        music = context.createGain(); music.gain.value = target; music.connect(input);
        for (const element of elements) context.createMediaElementSource(element).connect(element === musicElement ? music : input);
      }
      await context.resume(); return true;
    },
    fadeMusic(value, seconds) {
      target = value; if (!music) return;
      const gain = music.gain, now = context.currentTime;
      if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now);
      else { gain.cancelScheduledValues(now); gain.setValueAtTime(gain.value, now); }
      if (seconds) gain.linearRampToValueAtTime(value, now + seconds);
      else gain.setValueAtTime(value, now);
    },
    setMuted(value) { muted = value; if (input) input.gain.value = value ? 0 : .65; },
  };
}
