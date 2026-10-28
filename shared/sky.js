import { getPosition, getMoonPosition, getMoonIllumination, getTimes } from 'suncalc';
import { TIMEZONE_LOCATIONS } from './sky-locations.js';

const RAD = Math.PI / 180;
export const TIMES_OF_DAY = ['auto', 'sunrise', 'noon', 'sunset', 'night'];
export function skyTime(timestamp, latitude, longitude, mode) {
  if (mode === 'auto') return timestamp;
  const times = getTimes(new Date(timestamp), latitude, longitude), noon = times.solarNoon.getTime();
  if (mode === 'noon') return noon;
  if (mode === 'night') return noon + 12 * 3600000;
  return times[mode]?.getTime() ?? noon + (mode === 'sunrise' ? -6 : 6) * 3600000;
}
export function approximateObserver(timeZone, timezoneOffset) {
  const city = TIMEZONE_LOCATIONS[timeZone];
  // ponytail: use the timezone's representative city; this is an approximate sky, not a precise observing site.
  return { latitude: city?.[0] ?? 0, longitude: city?.[1] ?? ((-timezoneOffset / 4 + 540) % 360 - 180),
    source: city ? 'timezone' : 'offset' };
}

export function calculateSky(timestamp, latitude, longitude) {
  const date = new Date(timestamp), moon = getMoonPosition(date, latitude, longitude);
  const illumination = getMoonIllumination(date);
  return { sun: getPosition(date, latitude, longitude),
    moon: { ...moon, ...illumination, tilt: illumination.angle - moon.parallacticAngle } };
}

export function starPosition(timestamp, latitude, longitude, rightAscension, declination) {
  // Precess J2000 catalogue coordinates to the observation epoch (Meeus chapter 21).
  // ponytail: omit stellar proper motion/refraction at driving resolution; add them for precision astronomy.
  const centuries = (timestamp / 86400000 - 10957.5) / 36525;
  const zeta = (2306.2181 * centuries + .30188 * centuries ** 2 + .017998 * centuries ** 3) / 3600 * RAD;
  const z = (2306.2181 * centuries + 1.09468 * centuries ** 2 + .018203 * centuries ** 3) / 3600 * RAD;
  const theta = (2004.3109 * centuries - .42665 * centuries ** 2 - .041833 * centuries ** 3) / 3600 * RAD;
  const ra = rightAscension * RAD, dec = declination * RAD;
  const a = Math.cos(dec) * Math.sin(ra + zeta);
  const b = Math.cos(theta) * Math.cos(dec) * Math.cos(ra + zeta) - Math.sin(theta) * Math.sin(dec);
  const c = Math.sin(theta) * Math.cos(dec) * Math.cos(ra + zeta) + Math.cos(theta) * Math.sin(dec);
  const currentRa = Math.atan2(a, b) + z, currentDec = Math.asin(Math.max(-1, Math.min(1, c)));
  const hourAngle = (280.46061837 + 360.98564736629 * (timestamp / 86400000 - 10957.5) + longitude) * RAD - currentRa;
  const lat = latitude * RAD;
  return {
    altitude: Math.asin(Math.max(-1, Math.min(1, Math.sin(lat) * Math.sin(currentDec) + Math.cos(lat) * Math.cos(currentDec) * Math.cos(hourAngle)))) / RAD,
    azimuth: (Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(currentDec) * Math.cos(lat)) / RAD + 540) % 360,
  };
}

export function validEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Number.isFinite(value.timestamp) || value.timestamp < Date.UTC(1900, 0) || value.timestamp > Date.UTC(2100, 0) ||
      !Number.isFinite(value.latitude) || Math.abs(value.latitude) > 90 ||
      !Number.isFinite(value.longitude) || Math.abs(value.longitude) > 180 ||
      !Number.isFinite(value.utcOffset) || Math.abs(value.utcOffset) > 840 ||
      typeof value.timeZone !== 'string' || value.timeZone.length > 80 ||
      !['timezone', 'offset'].includes(value.source) ||
      !(value.cloudCover === null || Number.isFinite(value.cloudCover) && value.cloudCover >= 0 && value.cloudCover <= 100) ||
      !(value.weatherAt === null || Number.isFinite(value.weatherAt) && value.weatherAt >= 0 && value.weatherAt <= Date.UTC(2100, 0)) ||
      (value.cloudCover === null) !== (value.weatherAt === null)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }); return true; } catch { return false; }
}

export function cleanEnvironment(value) {
  const { timestamp, timeZone, utcOffset, latitude, longitude, source, cloudCover, weatherAt } = value;
  return { timestamp, timeZone, utcOffset, latitude, longitude, source, cloudCover, weatherAt };
}
