import { VEHICLES } from '../shared/game.js';

export function invitationCode(url) {
  const location = new URL(url);
  const code = (/^\/([a-f0-9]{6})\/?$/i.exec(location.pathname)?.[1] || location.searchParams.get('room'))?.trim().toUpperCase();
  return /^[A-F0-9]{6}$/.test(code || '') ? code : null;
}
export function invitationUrl(origin, code) {
  return new URL(`/${code.toUpperCase()}`, origin).href;
}
export function spectatorTarget(selectedId, players, standings = []) {
  const available = id => players.some(player => player.id === id);
  return (available(selectedId) ? selectedId : standings.find(player => player.rank === 1 && available(player.id))?.id)
    || players[0]?.id || null;
}
export function finishAnnouncements(snapshot, seen) {
  if (seen.raceId !== snapshot.raceId) { seen.raceId = snapshot.raceId; seen.ids.clear(); }
  return (snapshot.finishers || []).filter(finisher => {
    if (seen.ids.has(finisher.id)) return false;
    seen.ids.add(finisher.id); return true;
  });
}
function normalizeDriver(name, vehicle) {
  return { name: Array.from((name || '').replace(/[\x00-\x1f\x7f]/g, '').trim()).slice(0, 16).join('') || 'Rider',
    vehicle: Object.hasOwn(VEHICLES, vehicle) ? vehicle : 'PULSE' };
}
function readDriverCookies(header) {
  return new Map(header.split(';').map(part => {
    const index = part.indexOf('=');
    try { return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))]; }
    catch { return ['', '']; }
  }));
}
export function hasDriverName(header) {
  return Boolean(readDriverCookies(header).get('nextrider_name')?.replace(/[\x00-\x1f\x7f]/g, '').trim());
}
export function driverPreferences(header) {
  const cookies = readDriverCookies(header);
  return normalizeDriver(cookies.get('nextrider_name'), cookies.get('nextrider_vehicle'));
}
export function driverCookies(name, vehicle) {
  return Object.entries(normalizeDriver(name, vehicle)).map(([key, value]) =>
    `nextrider_${key}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`);
}
