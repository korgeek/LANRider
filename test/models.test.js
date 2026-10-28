import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

test('selected bodies mount independent drivers and retain real wheel and exhaust positions', async t => {
  const { VEHICLE_MODELS, VEHICLE_LIGHT_MODELS, createVehicleModel, createVehiclePortrait } = await import('../public/models.js');
  globalThis.self = globalThis;
  const loader = new GLTFLoader();
  // Node has no image decoder. Structure/animation checks use real GLBs; browser QA checks textures.
  loader.register(parser => {
    parser.textureLoader = { load(_url, loaded) { loaded(new THREE.Texture()); } };
    return { name: 'NODE_TEXTURE_ADAPTER' };
  });
  async function load(url) {
    const bytes = await readFile(new URL(`../public${url}`, import.meta.url));
    return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  }
  const bodies = Object.fromEntries(await Promise.all(Object.entries(VEHICLE_MODELS).map(async ([id, url]) => [id, {normal:await load(url),light:await load(VEHICLE_LIGHT_MODELS[id])}])));
  const driver = await load('/assets/drivers/vnext/driver_lod0.glb');
  await t.test('vehicle portraits show the selected real body and frame its complete bounds', () => {
    assert.equal(typeof createVehiclePortrait, 'function');
    for (const id of ['PULSE', 'APEX', 'BOLT', 'COMET', 'BULWARK', 'SLIDE', 'IGNIS', 'RALLY']) {
      const { root, camera } = createVehiclePortrait(bodies, driver, id);
      const source = (bodies[id] || bodies.PULSE).normal;
      assert.equal(root.getObjectByName('body_mesh').getObjectByProperty('isMesh', true).geometry,
        source.scene.getObjectByName('body_mesh').getObjectByProperty('isMesh', true).geometry, id);
      const bounds = new THREE.Box3().setFromObject(root);
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const projected = new THREE.Vector3(x, y, z).project(camera);
        assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && Math.abs(projected.z) < 1, `${id}: clipped portrait`);
      }
    }
  });
  for (const id of ['PULSE', 'APEX', 'BOLT', 'COMET', 'BULWARK', 'SLIDE', 'IGNIS', 'RALLY', 'unknown']) {
    const source = (bodies[id] || bodies.PULSE).normal;
    const a = createVehicleModel(bodies, driver, id), b = createVehicleModel(bodies, driver, id);
    assert.equal(a.root.getObjectByName('body_mesh').getObjectByProperty('isMesh', true).geometry,
      source.scene.getObjectByName('body_mesh').getObjectByProperty('isMesh', true).geometry, id);
    assert.equal(a.person.parent.name, 'driver_mount');
    assert.deepEqual(a.person.parent.position.toArray().map(n => +n.toFixed(2)), [0, .47, .17]);
    assert.ok(a.radius > .15 && a.radius < .4, `${id}: ${a.radius}`);
    assert.equal(a.exhausts.length, 2, id);
    assert.ok(a.exhausts.every(p => p.z > 1 && p.y > .3));
    const skin = a.person.getObjectByProperty('isSkinnedMesh', true);
    assert.notEqual(skin.skeleton, b.person.getObjectByProperty('isSkinnedMesh', true).skeleton);
    const mixer = new THREE.AnimationMixer(a.person);
    for (const name of ['drive_idle', 'hit', 'victory']) {
      const clip = driver.animations.find(c => c.name === name);
      assert.ok(clip, name); mixer.stopAllAction(); mixer.clipAction(clip).play(); mixer.update(clip.duration / 2);
      a.root.updateMatrixWorld(true); skin.skeleton.update();
      const bounds = new THREE.Box3().setFromObject(a.person);
      assert.ok(Number.isFinite(bounds.max.y) && bounds.max.y < 2, `${id}/${name}`);
    }
    a.root.getObjectByName('spin_fl').rotation.x = 1;
    assert.ok(Math.abs(b.root.getObjectByName('spin_fl').rotation.x) < .000001);
  }
  await t.test('steering moves shoulders/head, boost tips the head back, and animated grips stay fixed', async () => {
    const { createDriverInertia } = await import('../public/driver-motion.js');
    const { root, person } = createVehicleModel(bodies, driver, 'IGNIS');
    root.rotation.y = 1.3; root.position.set(20, 0, -40); root.updateMatrixWorld(true);
    const head = person.getObjectByName('head'), chest = person.getObjectByName('chest');
    const hands = ['hand_l', 'hand_r'].map(name => person.getObjectByName(name));
    const grips = hands.map(hand => hand.getWorldPosition(new THREE.Vector3()));
    const headRest = head.getWorldQuaternion(new THREE.Quaternion()), chestRest = chest.getWorldQuaternion(new THREE.Quaternion());
    const parent = person.getWorldQuaternion(new THREE.Quaternion());
    const motion = createDriverInertia(person);
    function delta(bone, rest) {
      const world = bone.getWorldQuaternion(new THREE.Quaternion()).multiply(rest.clone().invert());
      return new THREE.Euler().setFromQuaternion(parent.clone().invert().multiply(world).multiply(parent));
    }
    function run(steer, boostTime) {
      for (let i = 0; i < 180; i++) { motion.beforeAnimation(); motion.afterAnimation({ steer, speed: 35, boostTime }, 1 / 60); }
    }
    run(1, 1);
    assert.ok(delta(head, headRest).x > .1, 'boost head tilt is visible from the chase camera (over 6 degrees)');
    assert.ok(delta(head, headRest).z > .087 && delta(chest, chestRest).z > .052, 'head and shoulders visibly lean (over 5 and 3 degrees)');
    for (let i = 0; i < 2; i++) assert.ok(hands[i].getWorldPosition(new THREE.Vector3()).distanceTo(grips[i]) < .00001, 'grip maintained');
    run(-1, 0); assert.ok(delta(head, headRest).z < -.03 && Math.abs(delta(head, headRest).x) < .00001);
    run(0, 0); assert.ok(head.getWorldQuaternion(new THREE.Quaternion()).angleTo(headRest) < .00001, 'returns to idle without accumulating offsets');
    run(1, 1); motion.beforeAnimation(); motion.afterAnimation({ steer: 1, speed: 35, boostTime: 1, finished: true }, 1 / 60);
    assert.ok(head.getWorldQuaternion(new THREE.Quaternion()).angleTo(headRest) < .00001, 'victory stays authored');
    const mixer = new THREE.AnimationMixer(person); mixer.clipAction(driver.animations.find(clip => clip.name === 'drive_idle')).play();
    for (let frame = 0; frame < 120; frame++) {
      motion.beforeAnimation(); mixer.update(1 / 60); person.updateWorldMatrix(true, true);
      const animatedGrips = hands.map(position => position.getWorldPosition(new THREE.Vector3()));
      motion.afterAnimation({ steer: Math.sin(frame / 10), speed: 35, boostTime: 1 }, 1 / 60);
      hands.forEach((hand, i) => assert.ok(hand.getWorldPosition(new THREE.Vector3()).distanceTo(animatedGrips[i]) < .00001, 'animated grip maintained'));
    }
  });
});
