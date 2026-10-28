import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as beach from '../public/beach.js';

test('quality thins scenery evenly, preserves landmarks and restores instances without rebuilding', () => {
  assert.equal(typeof beach.setSceneryQuality, 'function');
  const geometry=new THREE.BoxGeometry(),material=new THREE.MeshBasicMaterial();
  const source=new THREE.Group();source.add(new THREE.Mesh(geometry,material));
  const models=Object.fromEntries(['flower_rock_patch','dune_grass_patch','shore_rock_cluster','landmark_assembly'].map(name=>[name,{scene:source}]));
  const items=Object.keys(models).flatMap(name=>Array.from({length:42},(_,i)=>({name,x:i*3,z:0,y:0,rotation:0,scale:1,layer:'near',...(i<2?{authored:'hero'}:{})})));
  const group=beach.createPropInstances(models,items),matrix=new THREE.Matrix4();
  const originals=group.children.map(mesh=>Array.from(mesh.instanceMatrix.array));
  let previous;
  for(const quality of ['high','medium','low']) {
    beach.setSceneryQuality(group,quality);
    const counts=group.children.map(mesh=>mesh.count);
    for(const [i,mesh]of group.children.entries()) {
      assert.equal(mesh.geometry,geometry);assert.equal(mesh.material,material);
      assert.deepEqual(Array.from(mesh.instanceMatrix.array),originals[i],'changing quality only changes active instance counts');
      if(quality!=='low'||mesh.name==='beach/shore_rock_cluster')assert.ok(mesh.count>=2,'authored accents remain except low greenery');
      if(quality==='low'&&['beach/flower_rock_patch','beach/dune_grass_patch'].includes(mesh.name))assert.equal(mesh.count,0);
      if(mesh.name==='beach/landmark_assembly')assert.equal(mesh.count,42,'landmarks stay complete');
      else {
        if(mesh.count){mesh.getMatrixAt(0,matrix);assert.ok(matrix.elements[12]<=3,'protected authored accent remains in front');}
        const xs=Array.from({length:mesh.count},(_,j)=>{mesh.getMatrixAt(j,matrix);return matrix.elements[12];});
        if(mesh.count>4)assert.ok(Math.max(...xs)>90,'retained detail spans the course rather than its first section');
      }
      if(previous)assert.ok(mesh.count<=previous[i]);
    }
    previous=counts;
  }
  const low=group.children.map(m=>m.count);beach.setSceneryQuality(group,'high');
  assert.ok(group.children.some((m,i)=>m.count>low[i]));
  const high=group.children.map(m=>m.count);beach.setSceneryQuality(group,'invalid');assert.deepEqual(group.children.map(m=>m.count),high);
  const again=beach.createPropInstances(models,items);assert.deepEqual(again.children.map(m=>Array.from(m.instanceMatrix.array)),originals,'density order is deterministic');
});

test('medium keeps tall palms; low removes greenery, distant rocks and beach props while retaining navigation', () => {
  const source = (name,height=1) => {
    const scene=new THREE.Group(),mesh=new THREE.Mesh(new THREE.BoxGeometry(1,height,1),new THREE.MeshBasicMaterial());
    mesh.name=name;scene.add(mesh);return {scene};
  };
  const names=['palm_single','coastal_island','lighthouse_islet','landmark_assembly','finish_wreck',
    'reference_inland_wreck','shrub_strip','canopy_cap','beach_seats','parasol','sun_lounger','striped_towel',
    'wooden_crate','wooden_barrel','wood_crate_1m','wood_barrel_1m','foam_strip_visual','corner_chevrons','rope_fence_4m'];
  const models=Object.fromEntries(names.map(name=>[name,source(name,name==='palm_single'?5:1)]));
  const items=names.map((name,i)=>({name,x:i*5,y:0,z:0,rotation:0,scale:1,layer:'near',authored:'hero'}));
  items.push({...items[0],x:100,scale:1.6},{...items[1],x:110,layer:'far'});
  // Composite cliff vegetation must disappear too, without removing its rocks.
  const composite=new THREE.Group();composite.add(source('cliff').scene,source('shrub_strip_pc').scene,
    source('dune_grass_patch_pc').scene,source('flower_rock_patch_pc').scene);
  models.reference_headland={scene:composite};items.push({...items[1],name:'reference_headland'});
  const group=beach.createPropInstances(models,items),counts=name=>group.children.filter(m=>m.name===`beach/${name}`).map(m=>m.count);
  beach.setSceneryQuality(group,'high');assert.deepEqual(counts('palm_single'),[2]);assert.deepEqual(counts('coastal_island'),[2]);
  beach.setSceneryQuality(group,'medium');assert.deepEqual(counts('palm_single'),[1]);assert.deepEqual(counts('beach_seats'),[1]);
  const matrix=new THREE.Matrix4();group.children.find(m=>m.name==='beach/palm_single').getMatrixAt(0,matrix);assert.equal(matrix.elements[12],100);
  beach.setSceneryQuality(group,'low');assert.deepEqual(counts('palm_single'),[1]);assert.deepEqual(counts('coastal_island'),[1]);
  for(const name of names.slice(6,17))assert.deepEqual(counts(name),[0],name);
  for(const name of ['lighthouse_islet','landmark_assembly','finish_wreck','reference_inland_wreck','corner_chevrons','rope_fence_4m'])assert.deepEqual(counts(name),[1],name);
  assert.deepEqual(counts('reference_headland'),[1,0,0,0]);
  beach.setSceneryQuality(group,'high');assert.deepEqual(counts('palm_single'),[2]);assert.deepEqual(counts('coastal_island'),[2]);assert.deepEqual(counts('reference_headland'),[1,1,1,1]);
});
