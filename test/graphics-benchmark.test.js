import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';
import { TRACKS, sampleTrack } from '../shared/game.js';

test('quality and viewport changes resize the actual framebuffer, free old shadow maps and restore higher quality', async () => {
  const source = await readFile(new URL('../public/scene.js', import.meta.url), 'utf8');
  const settings = source.match(/export function graphicsSettings\([\s\S]+?(?=\nconst angle)/)?.[0];
  assert(settings, 'render quality must include framebuffer and shadow costs');
  const resize = source.match(/function resize\(\) \{[\s\S]+?(?=\n  addEventListener\('resize')/)?.[0]; assert(resize);
  let ratio, disposed = 0, dimensions;
  const shadow = { mapSize: new THREE.Vector2(2048, 2048), map: { dispose() { disposed++; } } };
  const context = { graphicsQuality: 'high', innerWidth: 1440, innerHeight: 900, devicePixelRatio: 2,
    scene: { getObjectByName: () => ({ shadow }) }, camera: { updateProjectionMatrix() {} },
    renderer: { shadowMap: { enabled: true }, setPixelRatio: value => { ratio = value; },
      setSize: (width, height) => { dimensions = [width * ratio, height * ratio]; } } };
  runInNewContext(settings.replace('export ', '')+'\n'+resize, context);
  runInNewContext('resize();',context); const highPixels = dimensions[0]*dimensions[1];
  context.graphicsQuality='low'; runInNewContext('resize();',context);
  assert.equal(context.renderer.shadowMap.enabled,false); assert.equal(disposed,1); assert.equal(shadow.map,null);
  assert(dimensions[0]*dimensions[1]<highPixels*.25,'low quality must materially reduce GPU pixel work');
  for(const [width,height]of [[1920,1080],[3840,2160],[8192,8192]]){
    context.innerWidth=width;context.innerHeight=height;runInNewContext('resize();',context);
    assert(dimensions[0]*dimensions[1]<=1280*720+1,'large windows must respect the low pixel budget');
  }
  context.graphicsQuality='medium'; runInNewContext('resize();',context);
  assert.equal(context.renderer.shadowMap.enabled,true); assert.equal(shadow.mapSize.x,1024);
  context.graphicsQuality='high'; runInNewContext('resize();',context);
  assert.equal(shadow.mapSize.x,2048); assert.equal(ratio,1.75);
});

test('graphics selection uses render-cost thresholds rather than display frame intervals', async () => {
  const source = await readFile(new URL('../public/scene.js', import.meta.url), 'utf8');
  const helper = source.match(/export const graphicsQualityForFrameMs = [^;]+;/)?.[0];
  assert(helper, 'the benchmark exposes its cost classification for a small regression check');
  const classify = runInNewContext(`${helper.replace('export ', '')}\ngraphicsQualityForFrameMs`);
  for (const [cost, quality] of [[0, 'high'], [12, 'high'], [12.01, 'medium'], [22, 'medium'], [22.01, 'low'], [Infinity, 'low'], [NaN, 'low']]) {
    assert.equal(classify(cost), quality);
  }
  assert.match(source, /async benchmarkGraphicsQuality\(/);
  assert.match(source, /Object\.values\(TRACKS\)/);
  assert.match(source, /for \(const hour of \[12, 0\]\)/);
  assert.match(source, /\['PULSE', 'BOLT', 'COMET', 'BULWARK'\]/);
  assert.match(source, /gl\.finish\(\)/);
  assert.match(source, /if \(benchmark && !benchmark\.rendering\) return;/);
});

test('one-off render probe restores camera and latest environment on completion, manual override, hidden tabs or timeout', async () => {
  const source = await readFile(new URL('../public/scene.js', import.meta.url), 'utf8');
  const methods = source.slice(source.indexOf('    async benchmarkGraphicsQuality()'), source.indexOf('    setTrack(track)'));
  for (const mode of ['complete', 'manual', 'hidden', 'timeout', 'context-lost']) {
    const document = new EventTarget(); document.hidden = false;
    let clock = 0, frames = 0, finishes = 0, yields = 0, timeout, cleared = false;
    const environments = [], settings = [];
    const context = { benchmark: null, graphicsQuality: 'high', vehicleQuality: 'high', cars: new Map(), TRACK: TRACKS.beginner, TRACKS, sample: sampleTrack,
      camera: { position: new THREE.Vector3(1, 2, 3), quaternion: new THREE.Quaternion(), fov: 55, updateProjectionMatrix() {} },
      cameraYaw: .7, cameraReady: true, wasRacing: false, currentEnvironment: { timestamp: 1000 }, environmentAt: 0,
      courses: new Map(Object.values(TRACKS).map(track => [track.id, {}])), document,
      performance: { now: () => clock += 2 },
      setTimeout(callback, delay) {
        if (delay) { assert.equal(delay, 12000); timeout = callback; return 1; }
        return setImmediate(() => {
          yields++;
          if (frames === 0) {
            context.world.setEnvironment({ timestamp: 3000, latitude: 7 });
            if (mode === 'manual') context.world.setGraphicsQuality('high');
            if (mode === 'hidden') { document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); }
            if (mode === 'timeout') timeout();
          }
          callback();
        });
      },
      clearTimeout: () => { cleared = true; },
      sky: { setEnvironment: value => environments.push(value) }, setSceneryQuality: (_, value) => settings.push(value),
      graphicsQualityForFrameMs: value => value <= 12 ? 'high' : value <= 22 ? 'medium' : 'low',
      renderer: { getContext: () => ({ finish: () => { finishes++; }, isContextLost: () => mode === 'context-lost' }) },
      resize() {},
      requestAnimationFrame() { throw new Error('Animation frames may be throttled while the document is visible'); },
    };
    for (const key of ['camPosition', 'camLook', 'wantedPosition', 'wantedLook']) context[key] = new THREE.Vector3(1, 2, 3);
    const world = runInNewContext(`world = {${methods}}; world`, context);
    world.setTrack = track => { context.TRACK = track; };
    world.render = states => {
      frames++; assert.equal(states.length, 4); assert.deepEqual(Array.from(states, state => state.vehicle), ['PULSE', 'BOLT', 'COMET', 'BULWARK']);
      context.camera.position.set(99, 99, 99); context.camPosition.set(99, 99, 99); context.camera.fov = 66;
    };
    if (mode === 'complete') {
      const result = await world.benchmarkGraphicsQuality();
      const expectedFrames = Object.keys(TRACKS).length * 48;
      assert.equal(result.quality, 'high'); assert.equal(result.frameMs, 2); assert.equal(frames, expectedFrames); assert.equal(finishes, expectedFrames);
      assert.equal(yields, expectedFrames, 'probe frames yield without depending on display refresh');
      assert.equal(environments.length, Object.keys(TRACKS).length * 2 + 1, 'each track has day and night plus the restored sky');
    } else await assert.rejects(world.benchmarkGraphicsQuality(), /interrupted|unavailable/);
    assert.equal(context.benchmark, null); assert(cleared);
    assert.equal(context.TRACK, TRACKS.beginner); assert.equal(context.graphicsQuality, 'high');
    assert.deepEqual(context.camera.position.toArray(), [1, 2, 3]); assert.deepEqual(context.camPosition.toArray(), [1, 2, 3]);
    assert.equal(context.camera.fov, 55); assert.equal(context.cameraYaw, .7); assert.equal(context.cameraReady, true);
    if (mode !== 'context-lost') assert.equal(environments.at(-1).latitude, 7, 'environment updates during the test survive restoration');
    assert.equal(settings.at(-1), 'high');
  }
});
