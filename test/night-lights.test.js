import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VEHICLE_MODELS } from '../public/models.js';
import { TRACKS, sampleTrack, nearestTrack } from '../shared/game.js';

test('sunset lighting fades together, fits all cars, and adds only one shadowless headlight', async () => {
  const { sunsetStrength, createVehicleLights, createHeadlights } = await import('../public/night-lights.js');
  assert.equal(typeof sunsetStrength, 'function');
  assert.equal(sunsetStrength(10), 0);
  assert.equal(sunsetStrength(-.5), 0);
  assert.ok(sunsetStrength(-1.4) > 0 && sunsetStrength(-1.4) < 1);
  assert.equal(sunsetStrength(-5), 1);
  globalThis.self = globalThis;
  const loader = new GLTFLoader();
  loader.register(parser => {
    parser.textureLoader = { load(_url, loaded) { loaded(new THREE.Texture()); } };
    return { name: 'NODE_TEXTURE_ADAPTER' };
  });
  for (const [name, url] of Object.entries(VEHICLE_MODELS)) {
    const bytes = await readFile(new URL(`../public${url}`, import.meta.url));
    const { scene } = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    const car=scene.clone(true),peer=scene.clone(true),lights=createVehicleLights(car);
    const lamp=(root,kind)=>root.getObjectByName(`light_${kind}_mesh`).getObjectByProperty('isMesh',true).material;
    assert.notEqual(lamp(car,'head'),lamp(peer,'head'),'car-local emissive controls never mutate cached/shared materials');
    const source=lamp(peer,'head').emissiveIntensity;
    lights.update(1,false);assert.equal(lamp(car,'head').emissiveIntensity,source);
    lights.update(.01,false);assert.ok(lamp(car,'head').emissiveIntensity<source*.02);
    lights.update(0,false);assert.equal(lamp(car,'head').emissiveIntensity,0);assert.equal(lamp(car,'tail').emissiveIntensity,0);
    lights.update(0,true);assert(lamp(car,'brake').emissiveIntensity>2,'brake indication remains visible in daylight');
    assert.equal(lamp(peer,'head').emissiveIntensity,source);
    const headMaterial=lamp(car,'head');
    for(let i=0;i<20;i++){lights.bind(peer);lights.bind(car);}
    assert.equal(lamp(car,'head'),headMaterial,'repeated body binding reuses its owned material');
    assert.equal(car.children.length,scene.children.length,'no synthetic lamp meshes are added');
    lights.dispose();
  }
  const headlights = createHeadlights(), spot = headlights.group.getObjectByProperty('isSpotLight', true);
  assert.equal(headlights.group.children.filter(child => child.isLight).length, 1);
  assert.equal(spot.castShadow, false);
  assert.ok(spot.target.position.z < spot.position.z && spot.target.position.y < spot.position.y);
  const first = new THREE.Group(), next = new THREE.Group();
  first.add(headlights.group); next.add(headlights.group);
  assert.equal(first.children.length, 0, 'camera focus changes reuse the same light');
  headlights.update(1); assert.equal(spot.visible, true); assert.ok(spot.intensity > 0);
  headlights.update(0); assert.equal(spot.visible, false);
});

test('tall palm downlighting reuses trunk draws and batches ground glow without lights or shadows', async () => {
  const { createPalmDownlights } = await import('../public/night-lights.js');
  assert.equal(typeof createPalmDownlights, 'function');
  const { createPropInstances } = await import('../public/beach.js');
  const geometry = new THREE.CylinderGeometry(.2, .3, 5, 6).translate(0, 2.5, 0);
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: geometry.attributes.position.count }, () => [.3, .15, .05]).flat(), 3));
  const original = new THREE.MeshStandardMaterial({ vertexColors: true });
  const source = new THREE.Group(), trunk = new THREE.Mesh(geometry, original); trunk.name = 'palm_single_pc'; source.add(trunk);
  const track = TRACKS.beginner;
  const scenery = createPropInstances({ reference_headland: { scene: source } }, [
    ...[-14, 14].map(offset => ({ name: 'reference_headland', ...sampleTrack(20, offset, track), y: -.08, scale: 2, rotation: 0 })),
    { name: 'reference_headland', ...sampleTrack(20, 20, track), y: -.08, scale: 1, rotation: 0 },
  ]);
  const palms = scenery.children[0];
  const lighting = createPalmDownlights(scenery, track), pools = scenery.getObjectByName('palm-downlight-pools');
  assert.ok(pools.isInstancedMesh);
  assert.equal(pools.count, 2, 'only palms at least 7m tall get downlighting');
  for (let i = 0; i < pools.count; i++) {
    const matrix = new THREE.Matrix4(); pools.getMatrixAt(i, matrix);
    const center = new THREE.Vector3().setFromMatrixPosition(matrix);
    assert.ok(Math.abs(nearestTrack(center.x, center.z, track).offset) < track.width / 2, 'the bright center reaches the road on either verge');
    assert.ok(center.y > .04, 'the glow clears road markings as well as sand');
    const width = new THREE.Vector3().setFromMatrixColumn(matrix, 0).length() * 2;
    const length = new THREE.Vector3().setFromMatrixColumn(matrix, 2).length() * 2;
    assert.ok(Math.abs(width - 20) < .001, 'ground glow width doubles from 10m to 20m');
    assert.ok(Math.abs(length - 44) < .001, 'ground glow length doubles from 22m to 44m at a 14m road offset');
    const direction = new THREE.Vector3(0, 0, 1).transformDirection(matrix);
    const road = sampleTrack(20, 0, track), base = sampleTrack(20, i ? 14 : -14, track);
    assert.ok(direction.dot(new THREE.Vector3(road.x - base.x, 0, road.z - base.z).normalize()) > .99, 'the long axis aims toward the road');
  }
  assert.equal(pools.castShadow, false); assert.equal(pools.receiveShadow, false);
  assert.equal(pools.material.depthWrite, false); assert.equal(pools.material.depthTest, true);
  assert.notEqual(palms.material, original); assert.equal(palms.geometry, geometry, 'source geometry remains shared');
  assert.ok(original.emissive.equals(new THREE.Color(0)), 'shared source material remains untouched');
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  palms.material.onBeforeCompile(shader);
  for (const altitude of [30, 0, -2, -6]) {
    lighting.update(altitude); assert.equal(pools.visible, false, 'daylight and sunset twilight leave palm lights off');
    assert.equal(shader.uniforms.palmNightStrength.value, 0);
  }
  lighting.update(-7); assert.equal(pools.visible, true);
  assert.ok(shader.uniforms.palmNightStrength.value > 0 && shader.uniforms.palmNightStrength.value < 1);
  lighting.update(-9); assert.equal(shader.uniforms.palmNightStrength.value, 1);
  lighting.update(10); assert.equal(pools.visible, false);
  assert.equal(shader.uniforms.palmNightStrength.value, 0, 'both trunk lighting and ground glow turn off at dawn');
  let lightCount = 0; scenery.traverse(object => { if (object.isLight) lightCount++; });
  assert.equal(lightCount, 0, 'palm count never increases the real light count');
});
