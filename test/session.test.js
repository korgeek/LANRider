import test from 'node:test';
import assert from 'node:assert/strict';
import { invitationCode, invitationUrl, finishAnnouncements } from '../public/session.js';
import * as session from '../public/session.js';

test('first-visit name gate accepts a saved nickname but rejects absent, blank and corrupt cookies', () => {
  assert.equal(typeof session.hasDriverName, 'function');
  for (const header of ['', 'other=1', 'nextrider_name=', 'nextrider_name=%20%00%0A', 'nextrider_name=%ZZ']) {
    assert.equal(session.hasDriverName(header), false, header);
  }
  assert.equal(session.hasDriverName('nextrider_name=Rider'), true);
  assert.equal(session.hasDriverName('other=1; nextrider_name=%ED%95%98%EB%8A%98'), true);
});

test('spectating follows first place automatically, keeps a manual driver, and falls back when they leave', () => {
  const players = [{ id: 'a' }, { id: 'b' }];
  const standings = [{ id: 'a', rank: 2 }, { id: 'b', rank: 1, finished: true }];
  assert.equal(session.spectatorTarget('', players, standings), 'b');
  const changedLead = [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }];
  assert.equal(session.spectatorTarget('', players, changedLead), 'a');
  assert.equal(session.spectatorTarget('b', players, changedLead), 'b');
  assert.equal(session.spectatorTarget('b', [players[0]], changedLead), 'a');
  assert.equal(session.spectatorTarget('', players, []), 'a');
  assert.equal(session.spectatorTarget('', [], standings), null);
});

test('driver cookies round-trip Korean names and reject corrupt or unknown preferences', () => {
  assert.equal(typeof session.driverCookies, 'function');
  const cookies = session.driverCookies('  해안;=레이서%  ', 'APEX');
  assert.equal(cookies.length, 2);
  for (const cookie of cookies) assert.match(cookie, /; Path=\/; Max-Age=31536000; SameSite=Lax$/);
  const header = cookies.map(cookie => cookie.split(';')[0]).join('; ');
  assert.deepEqual(session.driverPreferences(header), { name: '해안;=레이서%', vehicle: 'APEX' });
  assert.deepEqual(session.driverPreferences('other=1; nextrider_name=%ZZ; nextrider_vehicle=__proto__'), { name: 'Rider', vehicle: 'PULSE' });
  assert.deepEqual(session.driverPreferences('nextrider_name=%00%0A; nextrider_vehicle=INVALID'), { name: 'Rider', vehicle: 'PULSE' });
  assert.deepEqual(session.driverPreferences(''), { name: 'Rider', vehicle: 'PULSE' });
  const long = session.driverCookies('x'.repeat(30), 'BOLT').map(cookie => cookie.split(';')[0]).join('; ');
  assert.deepEqual(session.driverPreferences(long), { name: 'x'.repeat(16), vehicle: 'BOLT' });
});

test('invitation carries a validated room code on the reachable server origin', () => {
  const url = invitationUrl('http://192.0.2.27:3000', 'a1b2c3');
  assert.equal(url, 'http://192.0.2.27:3000/A1B2C3');
  assert.equal(invitationCode(url), 'A1B2C3');
  assert.equal(invitationCode('http://localhost:3000/a1b2c3/'), 'A1B2C3');
  assert.equal(invitationCode('http://localhost:3000/?room=a1b2c3'), 'A1B2C3');
  for (const path of ['/invalid', '/A1B2C3/extra', '/ABC1234', '/assets/ABC123']) {
    assert.equal(invitationCode(`http://localhost:3000${path}`), null);
  }
  assert.equal(invitationCode('http://localhost:3000/?room=invalid'), null);
  assert.equal(invitationCode('http://localhost:3000/'), null);
});

test('finish announcements reach each client once per finisher and reset for a new race', () => {
  const seen = { raceId: null, ids: new Set() };
  const first = { id: 'a', name: 'First', finishTime: 92 };
  const second = { id: 'b', name: 'Second', finishTime: 97 };
  assert.deepEqual(finishAnnouncements({ raceId: 1, finishers: [first] }, seen), [first]);
  assert.deepEqual(finishAnnouncements({ raceId: 1, finishers: [first] }, seen), []);
  assert.deepEqual(finishAnnouncements({ raceId: 1, finishers: [first, second] }, seen), [second]);
  assert.deepEqual(finishAnnouncements({ raceId: 2, finishers: [] }, seen), []);
  assert.deepEqual(finishAnnouncements({ raceId: 2, finishers: [first] }, seen), [first]);
  assert.deepEqual(finishAnnouncements({ raceId: 3, finishers: [first, second] }, seen), [first, second]);
});
