import { approximateObserver } from '../shared/sky.js';

export function browserEnvironment() {
  const date = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return { timestamp: date.getTime(), timeZone, utcOffset: -date.getTimezoneOffset(),
    ...approximateObserver(timeZone, date.getTimezoneOffset()), cloudCover: null, weatherAt: null };
}

export async function readCloudCover(latitude, longitude, fetcher = fetch) {
  try {
    const query = new URLSearchParams({ latitude, longitude, current: 'cloud_cover', timeformat: 'unixtime' });
    const response = await fetcher(`https://api.open-meteo.com/v1/forecast?${query}`, {
      signal: AbortSignal.timeout(5000), credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) return null;
    const { current } = await response.json();
    if (!Number.isFinite(current?.cloud_cover) || current.cloud_cover < 0 || current.cloud_cover > 100 ||
        !Number.isFinite(current.time) || current.time < 0) return null;
    return { cloudCover: current.cloud_cover, weatherAt: current.time * 1000 };
  } catch { return null; }
}

export function createEnvironmentSync(send, onChange) {
  let anchor = browserEnvironment(), receivedAt = performance.now();
  let token = '', timer, observer = null, weather = null, weatherReceivedAt = -Infinity, weatherAttemptAt = -Infinity;
  let generation = 0, request = 0;
  function apply(environment) {
    anchor = environment; receivedAt = performance.now(); onChange(environment);
  }
  function publish(code) {
    const environment = { ...browserEnvironment(), ...observer };
    if (weather && performance.now() - weatherReceivedAt < 30 * 60000) Object.assign(environment, weather);
    send({ type: 'environment', code, environment });
  }
  async function updateWeather(code, epoch) {
    const attempt = ++request; weatherAttemptAt = performance.now();
    const result = await readCloudCover(observer.latitude, observer.longitude);
    if (generation !== epoch || attempt !== request) return;
    if (result) { weather = result; weatherReceivedAt = performance.now(); }
    publish(code);
  }
  return {
    current: () => ({ ...anchor, timestamp: anchor.timestamp + performance.now() - receivedAt }),
    setRoom(room, localId) {
      const nextToken = room ? `${room.code}:${room.hostId}` : '';
      if (room?.environment) apply(room.environment);
      if (nextToken === token) return;
      token = nextToken; clearInterval(timer); generation++; request++;
      if (!room) { apply(browserEnvironment()); return; }
      if (room.hostId !== localId) return;
      const epoch = generation, code = room.code;
      observer = approximateObserver(Intl.DateTimeFormat().resolvedOptions().timeZone, new Date().getTimezoneOffset());
      weather = null; weatherReceivedAt = weatherAttemptAt = -Infinity;
      publish(code); void updateWeather(code, epoch);
      timer = setInterval(() => {
        const next = approximateObserver(Intl.DateTimeFormat().resolvedOptions().timeZone, new Date().getTimezoneOffset());
        if (observer.latitude !== next.latitude || observer.longitude !== next.longitude) {
          observer = next; weather = null; weatherAttemptAt = -Infinity; request++;
        }
        publish(code);
        if (performance.now() - weatherAttemptAt >= 10 * 60000) void updateWeather(code, epoch);
      }, 60000);
    },
  };
}
