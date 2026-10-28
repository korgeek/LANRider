import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import * as models from '../public/models.js';
import { collisionBox } from '../shared/game.js';

globalThis.self=globalThis;
const loader=new GLTFLoader();
loader.register(parser=>{parser.textureLoader={load(_url,done){done(new THREE.Texture());}};return{name:'NODE_TEXTURE_ADAPTER'};});
async function load(url){const b=await readFile(new URL('../public'+url,import.meta.url));return loader.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');}

test('PULSE pilot swaps cached bodies while keeping the driver, mixer, world transform and wheel phase',async()=>{
  assert(models.VEHICLE_LIGHT_MODELS,'LIGHT mapping is explicit');
  const normal=await load(models.VEHICLE_MODELS.PULSE),light=await load(models.VEHICLE_LIGHT_MODELS.PULSE);
  const driver=await load('/assets/drivers/vnext/driver_lod0.glb'),body={PULSE:{normal,light}};
  const model=models.createVehicleModel(body,driver,'PULSE','high');
  const {root,person}=model,skin=person.getObjectByProperty('isSkinnedMesh',true),skeleton=skin.skeleton;
  const mixer=new THREE.AnimationMixer(person),idle=mixer.clipAction(driver.animations.find(c=>c.name==='drive_idle')).play();mixer.update(.4);
  root.position.set(13,.035,-28);root.rotation.y=1.2;
  const matrix=root.updateMatrix(),before=root.matrix.clone(),time=idle.time,normalBody=model.body;
  model.spin.forEach((p,i)=>p.rotation.x=i+.7);model.steer.forEach(p=>p.rotation.y=.31);
  let lightBody;
  for(let i=0;i<100;i++){
    model.setQuality('low');lightBody??=model.body;assert.equal(model.body,lightBody);
    assert.equal(person.parent,model.body.getObjectByName('driver_mount'));
    model.setQuality('high');assert.equal(model.body,normalBody);
    assert.equal(model.root,root);assert.equal(model.person,person);assert.equal(skin.skeleton,skeleton);
    root.updateMatrix();assert(root.matrix.equals(before));assert.equal(idle.time,time);assert(idle.isRunning());
    model.spin.forEach((p,i)=>assert.equal(p.rotation.x,i+.7));model.steer.forEach(p=>assert.equal(p.rotation.y,.31));
    assert.equal(root.children.length,1,'only the active body is attached');
  }
  assert.notEqual(normalBody,lightBody);
  for(const quality of ['high','low']){
    model.setQuality(quality);const source=quality==='low'?light:normal;
    assert.equal(model.body.getObjectByName('body_mesh').getObjectByProperty('isMesh',true).geometry,source.scene.getObjectByName('body_mesh').getObjectByProperty('isMesh',true).geometry);
    assert(model.wheelRadii.every(r=>r>.15&&r<.4));
  }
  let sourceDisposed=0;normal.scene.traverse(o=>o.geometry?.addEventListener('dispose',()=>sourceDisposed++));
  model.dispose();assert.equal(sourceDisposed,0,'cached source geometry belongs to the scene, not an individual car');
  assert.equal(root.children.length,0);
});

test('all eight V4 pairs retain metre-scale pivots and the current driver grip contract',async()=>{
  const ids=['PULSE','APEX','BOLT','COMET','BULWARK','SLIDE','IGNIS','RALLY'];
  assert.deepEqual(Object.keys(models.VEHICLE_MODELS),ids);assert.deepEqual(Object.keys(models.VEHICLE_LIGHT_MODELS),ids);
  const expected={PULSE:[9694,3178],APEX:[9690,3940],BOLT:[9692,3934],COMET:[9692,3157],BULWARK:[9696,3162],SLIDE:[9698,3934],IGNIS:[9698,3808],RALLY:[9692,3175]};
  const driver=await load('/assets/drivers/vnext/driver_lod0.glb');
  for(const id of ids){
    const normal=await load(models.VEHICLE_MODELS[id]),light=await load(models.VEHICLE_LIGHT_MODELS[id]);
    const model=models.createVehicleModel({[id]:{normal,light}},driver,id),pivots=[];
    const mixer=new THREE.AnimationMixer(model.person);mixer.clipAction(driver.animations.find(c=>c.name==='drive_idle')).play();mixer.update(0);
    const box=collisionBox(id),size=new THREE.Box3().setFromObject(normal.scene).getSize(new THREE.Vector3());
    assert(Math.abs(box.width/size.x-.9)<.001,`${id}: body width is 90%`);
    assert(Math.abs(box.length/size.z-.9)<.001,`${id}: body length is 90%`);
    assert(box.height>=new THREE.Box3().setFromObject(model.root).max.y,`${id}: height includes the mounted driver`);
    for(const [i,quality]of ['high','low'].entries()){
      model.setQuality(quality);model.root.updateMatrixWorld(true);let triangles=0;
      model.body.traverse(o=>{if(o.isMesh&&!o.isSkinnedMesh)triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;});
      assert.equal(triangles,expected[id][i],`${id}/${quality}`);
      pivots.push(model.spin.map(p=>p.getWorldPosition(new THREE.Vector3())));
      for(const side of ['l','r'])assert(model.person.getObjectByName('hand_'+side).getWorldPosition(new THREE.Vector3()).distanceTo(model.body.getObjectByName('hand_'+side+'_anchor').getWorldPosition(new THREE.Vector3()))<.001,`${id}: vNext hand meets provided anchor`);
      // LIGHT's decimated tyre surface varies by up to 2.96mm; axle pivots remain identical.
      for(const wheel of ['wheel_fl','wheel_fr','wheel_rl','wheel_rr'])assert(Math.abs(new THREE.Box3().setFromObject(model.body.getObjectByName(wheel)).min.y)<.0031,`${id}: tyre meets ground within source decimation tolerance`);
    }
    for(let i=0;i<4;i++)assert(pivots[0][i].distanceTo(pivots[1][i])<.00001,`${id}: LOD pivots match`);
    model.dispose();
  }
});
