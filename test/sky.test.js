import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';

const sky = await import('../shared/sky.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

test('room time presets keep auto unchanged and put the sun at sunrise, noon, sunset or night', () => {
  const timestamp = Date.parse('2026-10-23T03:00:00Z'), latitude = -6.2, longitude = 106.8;
  assert.equal(typeof sky.skyTime, 'function');
  assert.equal(sky.skyTime(timestamp, latitude, longitude, 'auto'), timestamp);
  const altitude = mode => sky.calculateSky(sky.skyTime(timestamp, latitude, longitude, mode), latitude, longitude).sun.altitude;
  assert(Math.abs(altitude('sunrise')) < 2); assert(Math.abs(altitude('sunset')) < 2);
  assert(altitude('noon') > 50); assert(altitude('night') < -40);
  assert(Number.isFinite(sky.skyTime(timestamp, 89, 0, 'sunrise')), 'polar dates still produce a usable timestamp');
});

test('observer fallback uses the timezone city rather than confusing UTC offset with location', () => {
  assert.equal(typeof sky.approximateObserver, 'function');
  const seoul = sky.approximateObserver('Asia/Seoul', -540);
  assert.ok(Math.abs(seoul.latitude - 37.55) < .1);
  assert.ok(Math.abs(seoul.longitude - 126.97) < .1);
  const jakarta = sky.approximateObserver('Asia/Jakarta', -420);
  assert.ok(jakarta.latitude < -6 && jakarta.longitude > 106);
  assert.equal(sky.approximateObserver('Etc/GMT+5', 300).longitude, -75);
});

test('sun follows actual location and season, including polar day and night', () => {
  assert.equal(typeof sky.calculateSky, 'function');
  const noon = sky.calculateSky(Date.parse('2026-03-20T12:00:00Z'), 0, 0);
  const midnight = sky.calculateSky(Date.parse('2026-03-20T00:00:00Z'), 0, 0);
  assert.ok(noon.sun.altitude > 85);
  assert.ok(midnight.sun.altitude < -85);
  assert.ok(sky.calculateSky(Date.parse('2026-06-21T00:00:00Z'), 80, 0).sun.altitude > 10);
  assert.ok(sky.calculateSky(Date.parse('2026-12-21T12:00:00Z'), 80, 0).sun.altitude < -10);
});

test('moon uses the real phase and observer, not a fixed nightly crescent', () => {
  assert.equal(typeof sky.calculateSky, 'function');
  // April 2024 eclipse/new moon and the following full moon.
  const fresh = sky.calculateSky(Date.parse('2024-04-08T18:21:00Z'), 32.8, -96.8);
  const full = sky.calculateSky(Date.parse('2024-04-23T23:49:00Z'), 37.55, 126.97);
  assert.ok(fresh.moon.fraction < .002);
  assert.ok(full.moon.fraction > .998);
  assert.ok(fresh.moon.altitude > 50);
  assert.ok(Number.isFinite(full.moon.tilt));
  const opposite = sky.calculateSky(Date.parse('2024-04-08T18:21:00Z'), -32.8, 83.2);
  assert.ok(opposite.moon.altitude < -50);
});

test('catalogue stars rotate with sidereal time and retain north/east sky directions', () => {
  assert.equal(typeof sky.starPosition, 'function');
  // J2000 GMST = 280.46061837 degrees. An equatorial star on that meridian is overhead.
  const date = Date.parse('2000-01-01T12:00:00Z');
  assert.ok(sky.starPosition(date, 0, 0, 280.46061837, 0).altitude > 89.99);
  assert.ok(sky.starPosition(date + 12 * 3600000, 0, 0, 280.46061837, 0).altitude < -89);
  const east = sky.starPosition(date, 0, 0, 10.46061837, 0);
  assert.ok(Math.abs(east.azimuth - 90) < .001);
});

test('rendered sky hides daylight stars, preserves night visibility and scales clouds with weather', async () => {
  const { createSky } = await import('../public/sky.js').catch(error => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return {};
  });
  assert.equal(typeof createSky, 'function');
  const catalogue = JSON.parse(await readFile(new URL('../public/assets/sky-stars.json', import.meta.url), 'utf8'));
  assert.ok(catalogue.stars.length > 900);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), clouds = new THREE.Group();
  for (let i = 0; i < 30; i++) clouds.add(new THREE.Group());
  const controller = createSky(scene, { toneMappingExposure: 1 }, clouds, catalogue);
  camera.position.set(2000, 4, -700); camera.lookAt(2000, 4, -800);
  const environment = { timestamp: Date.parse('2026-03-20T12:00:00Z'), latitude: 0, longitude: 0, cloudCover: 0 };
  controller.setEnvironment(environment); controller.update(camera, { x: 2000, z: -700 });
  assert.ok(controller.sunAltitude()>0,'scene lighting can read the actual daytime solar altitude');
  assert.equal(scene.getObjectByName('sky-stars').material.uniforms.visibility.value, 0);
  assert.equal(clouds.children.filter(cloud => cloud.visible).length, 0);
  assert.ok(scene.getObjectByName('sky-sun').visible);
  const dome = scene.getObjectByName('sky-dome');
  assert.equal(dome.position.x, 2000);
  environment.timestamp = Date.parse('2026-03-20T00:00:00Z'); environment.cloudCover = 100;
  controller.setEnvironment(environment); controller.update(camera, { x: 2000, z: -700 });
  assert.ok(controller.sunAltitude()<-.833,'lighthouse activation receives the same after-sunset sky state');
  assert.equal(scene.getObjectByName('sky-sun').visible, false);
  assert.equal(clouds.children.filter(cloud => cloud.visible).length, 30);
  environment.cloudCover = 0;
  controller.setEnvironment(environment); controller.update(camera, { x: 2000, z: -700 });
  assert.ok(scene.getObjectByName('sky-stars').material.uniforms.visibility.value > .9);
  assert.ok(scene.getObjectByName('sky-fill').intensity > .3, 'night racing stays legible');
});
