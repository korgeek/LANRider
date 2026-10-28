import test from 'node:test';
import assert from 'node:assert/strict';

const environment = await import('../public/environment.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

test('only hosts request weather and stale callbacks cannot update a different room', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const pending = [], sent = [], applied = [];
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => pending.push(resolve)));
  const sync = environment.createEnvironmentSync(message => sent.push(message), value => applied.push(value));
  const remote = { ...environment.browserEnvironment(), timestamp: Date.parse('2020-01-01T00:00:00Z') };
  const room = { code: 'ABC123', hostId: 'other', environment: remote };
  sync.setRoom(room, 'me');
  assert.equal(pending.length, 0);
  assert.ok(Math.abs(sync.current().timestamp - remote.timestamp) < 100, 'guest uses the host clock rather than its own wall clock');
  sync.setRoom({ ...room, hostId: 'me' }, 'me');
  assert.equal(pending.length, 1);
  assert.equal(sent.length, 1);
  sync.setRoom(room, 'me');
  pending[0](Response.json({ current: { cloud_cover: 99, time: 1792638000 } }));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(60000);
  assert.equal(sent.length, 1, 'demotion cancels timers and old weather results');
  sync.setRoom({ ...room, code: 'NEW123', hostId: 'me' }, 'me');
  assert.equal(sent.at(-1).code, 'NEW123');
  assert.notEqual(sent.at(-1).environment.source, 'geolocation');
  sync.setRoom(null, 'me');
  assert.ok(Math.abs(sync.current().timestamp - Date.now()) < 100);
});

test('hosting never accesses geolocation even when location permission is available', t => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const secureDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
  let locationReads = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    get geolocation() { locationReads++; return { getCurrentPosition() {} }; },
  } });
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
  t.after(() => {
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    if (secureDescriptor) Object.defineProperty(globalThis, 'isSecureContext', secureDescriptor); else delete globalThis.isSecureContext;
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  const sent = [], sync = environment.createEnvironmentSync(message => sent.push(message), () => {});
  try {
    sync.setRoom({ code: 'ABC123', hostId: 'me' }, 'me');
    assert.equal(locationReads, 0, 'location permission must never be requested');
    assert.ok(['timezone', 'offset'].includes(sent[0].environment.source));
    assert.ok(Math.abs(sent[0].environment.timestamp - Date.now()) < 100);
  }
  finally { sync.setRoom(null, 'me'); }
});
test('weather accepts clear skies, requests current cloud cover and rejects malformed or failed responses', async () => {
  assert.equal(typeof environment.readCloudCover, 'function');
  const result = await environment.readCloudCover(37.55, 126.97, async url => {
    const query = new URL(url).searchParams;
    assert.equal(query.get('current'), 'cloud_cover');
    assert.equal(query.get('latitude'), '37.55');
    assert.equal(query.get('longitude'), '126.97');
    return Response.json({ current: { cloud_cover: 0, time: 1792638000 } });
  });
  assert.deepEqual(result, { cloudCover: 0, weatherAt: 1792638000000 });
  for (const body of [{}, { current: { cloud_cover: null, time: 1 } }, { current: { cloud_cover: 101, time: 1 } },
    { current: { cloud_cover: 30 } }, { current: { cloud_cover: 30, time: -1 } }]) {
    assert.equal(await environment.readCloudCover(0, 0, async () => Response.json(body)), null);
  }
  assert.equal(await environment.readCloudCover(0, 0, async () => new Response('', { status: 429 })), null);
  assert.equal(await environment.readCloudCover(0, 0, async () => { throw new Error('offline'); }), null);
});
