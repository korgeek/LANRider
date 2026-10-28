export const MUSIC_TRACKS = [
  ['rush-to-wave', 'Rush to Wave', 'musicbysantai', '13c6ab848d0f'],
  ['run-on-ocean', 'Run on Ocean', 'musicbysantai', 'a9451f185b43'],
  ['beachside-kart-groove', 'Beachside Kart Groove', 'musicbysantai', '06e0875260dd'],
].map(([id, title, artist, version]) => ({ id, title, artist, src: `/assets/audio/music/${id}.mp3${version ? `?v=${version}` : ''}` }));

export const validMusic = id => typeof id === 'string' && MUSIC_TRACKS.some(track => track.id === id);
