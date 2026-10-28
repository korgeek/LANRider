import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

test('lighthouse starts after sunset, rotates continuously and softly lights distant ground without shadow passes', async () => {
  const {createLighthouseBeacon}=await import('../public/beach.js');
  assert.equal(typeof createLighthouseBeacon,'function');
  const model=new THREE.Group();model.name='BeaconRotor';model.position.set(4,31.49,-4);
  const lens=new THREE.Mesh(new THREE.BoxGeometry(.055,1.3,.92),new THREE.MeshStandardMaterial());lens.name='Beacon_Lens_PC';model.add(lens);
  const originalEmissive=lens.material.emissiveIntensity;
  const beacon=createLighthouseBeacon(model,{x:0,y:-.08,z:-270,scale:2,rotation:0});
  const light=beacon.group.getObjectByProperty('isSpotLight',true),beam=beacon.group.getObjectByName('lighthouse-beam');
  beacon.update(10,0);assert.equal(light.visible,false);assert.equal(beam.visible,false);
  beacon.update(-.5,1);assert.equal(light.visible,false,'the lamp waits for sunset below the horizon');
  beacon.update(-5,0);beacon.group.updateMatrixWorld(true);assert.ok(light.visible&&beam.visible);
  const before=light.target.getWorldPosition(new THREE.Vector3());
  assert.ok(Math.abs(before.y+.08)<.01,'the swept light reaches sand and road height');
  assert.ok(before.distanceTo(light.getWorldPosition(new THREE.Vector3()))>500,'beam reaches the distant course');
  beacon.update(-5,6);beacon.group.updateMatrixWorld(true);
  assert.ok(before.distanceTo(light.target.getWorldPosition(new THREE.Vector3()))>500,'a quarter-turn sweeps a different part of the course');
  assert.equal(light.castShadow,false);assert.ok(light.penumbra>=.8);
  assert.equal(beam.material.depthWrite,false);assert.equal(beam.material.depthTest,true);
  assert.ok(beam.material.uniforms.strength.value<=.04,'the visible beam remains translucent');
  assert.equal(lens.material.emissiveIntensity,originalEmissive,'the source lens material is not mutated');
  beacon.update(5,10);assert.equal(light.visible,false);assert.equal(beam.visible,false);
});
