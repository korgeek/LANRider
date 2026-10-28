import * as THREE from 'three';
import { BOOST_PAD, sampleTrack, nearestTrack } from '../shared/game.js';
import { createPalmDownlights, sunsetStrength } from './night-lights.js';

export const BEACH_MODELS = [
  'beach_radio', 'bollard', 'changing_hut', 'channel_buoy', 'cooler',
  'hedge_planter', 'icecream_cart', 'jetski', 'lifeguard_tower', 'menu_sign', 'outdoor_shower',
  'palm_single', 'parasol', 'picnic_table', 'pier_section', 'promenade_bench', 'promenade_lantern',
  'recycling_bin', 'rowboat', 'sailboat', 'sandcastle', 'shore_rock_cluster', 'striped_towel',
  'sun_lounger', 'surf_rack', 'surfboard', 'swim_ring', 'volleyball_net', 'cliff_fragment',
  'corner_arrow_single', 'corner_chevrons', 'dune_grass_patch', 'flower_rock_patch',
  'foam_strip_visual', 'palm_crooked', 'palm_fan_short', 'palm_twin', 'rope_fence_4m', 'timber_fence_4m',
];
export const TROPICAL_MODELS = ['distant_arch', 'canopy_cap', 'shrub_strip', 'shore_skirt'];
export const INLAND_MODELS = ['landmark_assembly'];
export const CLOUD_MODELS = ['C02_Tuft', 'C04_Cumulus', 'C03_Ribbon'];
export const TRACK_PROP_MODELS = ['barrier_bluewhite_2m', 'bunting_span_6m', 'red_flag_pole_3m',
  'wood_crate_1m', 'wood_barrel_1m', 'boost_chevrons_visual_3m', 'road_forward_arrow_visual'];

// Authored box details occasionally share a plane with differently coloured faces.
// Offset only those colour layers by 1 mm; retain the original GLB and shared geometry.
export function separateCoplanarDetails(geometry) {
  const positions=geometry.attributes.position,colors=geometry.attributes.color,index=geometry.index;
  if(!colors) return geometry;
  let floor=Infinity;for(let i=0;i<positions.count;i++)floor=Math.min(floor,positions.getY(i));
  const cross=(a,b,c)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
  function overlap(a,b) {
    let polygon=a;const sign=Math.sign(cross(...b));
    for(let edge=0;edge<3;edge++) {
      const first=b[edge],last=b[(edge+1)%3],next=[];
      for(let i=0;i<polygon.length;i++) {
        const p=polygon[i],q=polygon[(i+1)%polygon.length],u=cross(first,last,p)*sign,v=cross(first,last,q)*sign;
        if(u>=0) next.push(p);
        if((u>=0)!==(v>=0)) {const t=u/(u-v);next.push({x:p.x+(q.x-p.x)*t,z:p.z+(q.z-p.z)*t});}
      }
      polygon=next;if(polygon.length<3)return 0;
    }
    return Math.abs(polygon.reduce((sum,p,i)=>sum+p.x*polygon[(i+1)%polygon.length].z-p.z*polygon[(i+1)%polygon.length].x,0))/2;
  }
  const planes=new Map();
  for(let i=0;i<(index?index.count:positions.count);i+=3) {
    const ids=[0,1,2].map(k=>index?index.getX(i+k):i+k),points=ids.map(id=>new THREE.Vector3().fromBufferAttribute(positions,id));
    const normal=points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0]));
    if(normal.lengthSq()<1e-12) continue;normal.normalize();
    // Ground-facing foundations are buried, and must retain their contact height.
    if(normal.y<-.999 && points.every(p=>p.y<=floor+.00001))continue;
    const key=[...normal.toArray(),normal.dot(points[0])].map(n=>Math.round(n*10000)).join('/');
    const plane=planes.get(key)||{faces:[],active:false};
    const axes=['x','y','z'].sort((a,b)=>Math.abs(normal[b])-Math.abs(normal[a])).slice(1);
    const triangle=points.map(p=>({x:p[axes[0]],z:p[axes[1]]}));
    const colour=[0,1,2].map(axis=>Math.round(ids.reduce((sum,id)=>sum+colors.array[id*colors.itemSize+axis],0)/3*10000)).join('/');
    if(!plane.active) plane.active=plane.faces.some(face=>face.colour!==colour && overlap(face.triangle,triangle)>1e-6);
    plane.faces.push({i,triangle,colour,normal});planes.set(key,plane);
  }
  const active=[...planes.values()].filter(plane=>plane.active);
  if(!active.length)return geometry;
  const result=index?geometry.toNonIndexed():geometry.clone(),p=result.attributes.position;
  let maximum=0;
  for(const plane of active) {
    const layers=[...new Set(plane.faces.map(face=>face.colour))].sort();
    for(const face of plane.faces) {
      const offset=layers.indexOf(face.colour)*.001;maximum=Math.max(maximum,offset);
      for(let k=0;k<3;k++) {const i=face.i+k;p.setXYZ(i,p.getX(i)+face.normal.x*offset,p.getY(i)+face.normal.y*offset,p.getZ(i)+face.normal.z*offset);}
    }
  }
  p.needsUpdate=true;result.computeBoundingBox();result.computeBoundingSphere();
  result.userData.coplanarOffset=maximum;
  return result;
}

export function prepareBeachModels(source) {
  const repaired=new Map();
  for(const model of Object.values(source)) model.scene.traverse(mesh=>{
    if(!mesh.isMesh || mesh.material.map)return;
    if(!repaired.has(mesh.geometry))repaired.set(mesh.geometry,separateCoplanarDetails(mesh.geometry));
    mesh.geometry=repaired.get(mesh.geometry);
  });
  const models = { ...source };
  models.avenue_palm_single=source.palm_single;
  models.avenue_palm_crooked=source.palm_crooked;
  if (source.landmark_assembly) {
    const scene=source.landmark_assembly.scene.clone(true);
    // Replace the authored short beam with the sweeping long-distance light.
    scene.getObjectByName('BeaconBeam_Optional_PC')?.removeFromParent();
    scene.updateMatrixWorld(true);
    const rotor=scene.getObjectByName('BeaconRotor'),rotorMatrix=rotor.matrixWorld.clone();rotor.removeFromParent();
    rotorMatrix.decompose(rotor.position,rotor.quaternion,rotor.scale);models.lighthouse_rotor={scene:rotor};
    models.landmark_assembly={...source.landmark_assembly,scene};
    const wreck=scene.getObjectByName('Wreck_PC').clone(true);
    wreck.position.set(0,0,0);wreck.rotation.set(0,0,8*Math.PI/180);
    models.finish_wreck={scene:wreck};
    const dryWreck=wreck.clone(true);dryWreck.rotation.z=2*Math.PI/180;
    models.reference_inland_wreck={scene:dryWreck};
  }
  const tropicalMaterial = source.distant_arch.scene.getObjectByProperty('isMesh', true).material;
  for (const name of TROPICAL_MODELS) models[name].scene.traverse(mesh => { if (mesh.isMesh) mesh.material = tropicalMaterial; });
  const wood = new THREE.MeshStandardMaterial({ color: '#b57b45', roughness: .85 });
  const propMaterial = source.wood_crate_1m.scene.getObjectByProperty('isMesh', true).material;
  for (const name of TRACK_PROP_MODELS) models[name].scene.traverse(mesh => { if (mesh.isMesh) mesh.material = propMaterial; });
  models.wooden_crate = source.wood_crate_1m; models.wooden_barrel = source.wood_barrel_1m;
  const beachSeats = source.parasol.scene.clone(true);
  for (const [name, x, z] of [['sun_lounger', -1.3, 1.3], ['sun_lounger', 1.5, 1.3], ['striped_towel', 1.5, -.9]]) {
    const prop = source[name].scene.clone(true); prop.position.set(x, 0, z); beachSeats.add(prop);
  }
  models.beach_seats = { scene: beachSeats };
  const bunting = source.bunting_span_6m.scene.clone(true), endPole = source.red_flag_pole_3m.scene.clone(true);
  endPole.position.x = 6; bunting.add(endPole); models.beach_bunting = { scene: bunting };
  for (const name of ['surf_shop', 'wooden_dock']) {
    const scene = name === 'surf_shop' ? source.thatch_hut.scene.clone(true) : new THREE.Group();
    if (name === 'wooden_dock') {
      for (const z of [-6.16, -2.11, 1.94, 5.99]) { const section = source.pier_section.scene.clone(true); section.position.z = z; scene.add(section); }
    } else {
      const box = new THREE.Mesh(new THREE.BoxGeometry(2.7, .8, .6), wood);
      box.position.set(0, 1.65, 1.7); scene.add(box);
    }
    models[name] = { scene };
  }
  // Repaint only the tower's paint primitive; retain rocks, foliage, railings and source files.
  const lighthouse = source.lighthouse_islet.scene.clone(true), red = new THREE.Color('#e34d44'), white = new THREE.Color('#fff5de');
  lighthouse.traverse(mesh => {
    if (!mesh.isMesh || !mesh.material.name.includes('paint')) return;
    mesh.geometry = mesh.geometry.toNonIndexed();
    const p = mesh.geometry.attributes.position, colors = mesh.geometry.attributes.color;
    for (let i = 0; i < p.count; i += 3) {
      const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
      const color = y > 10.9 || Math.floor((y - 4.51) / 1.26) % 2 ? red : white;
      for (let k = 0; k < 3; k++) colors.setXYZ(i + k, color.r, color.g, color.b);
    }
  });
  models.lighthouse_islet = { scene: lighthouse };
  // Join existing cliff modules into broad landforms; rock seams are intentional terrain joins.
  for (const [name, parts] of [
    ['coastal_headland', [['cliff_terrace', -8, 0, 2.1, 1.4, 2.1], ['cliff_columns', 9, -3, 1.4, 1.6, 1.9]]],
    ['coastal_island', [['cliff_terrace', -15, 2, 2.8, 2.5, 2.8], ['cliff_columns', 8, -3, 2.1, 3.2, 3.1],
      ['cliff_terrace', 26, 2, 2.3, 1.8, 2.5]]],
  ]) {
    const scene = new THREE.Group();
    for (const [id, x, z, sx, sy, sz] of parts) {
      const cliff = source[id].scene.clone(true), minY = new THREE.Box3().setFromObject(cliff).min.y;
      cliff.scale.set(sx, sy, sz); cliff.position.set(x, -minY * sy, z); scene.add(cliff);
    }
    models[name] = { scene };
  }
  const planted = new THREE.Group(), rocks = models.coastal_headland.scene.clone(true);
  rocks.name = 'rock-terraces'; planted.add(rocks);
  const ledge = source.cliff_terrace.scene.clone(true);
  ledge.scale.set(2.1, .6, 1.9);
  ledge.position.set(-11, -new THREE.Box3().setFromObject(source.cliff_terrace.scene).min.y * .6, 8);
  rocks.add(ledge); rocks.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  for (const [name, x, z, scale] of [
    ['palm_crooked', -10, 1, 1.5], ['palm_single', 5, -2, 2],
    ['palm_fan_short', 14, -3, 1.7], ['palm_single', -15, 8, 1.8],
    ['shrub_strip', -7, 6, 1.3], ['shrub_strip', 10, 0, 1.2],
  ]) {
    ray.set(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
    const surface = ray.intersectObject(rocks, true)[0];
    if (!surface) continue;
    const prop = source[name].scene.clone(true); prop.name = name.startsWith('palm_') ? 'terrace-palm' : 'terrace-shrub';
    prop.scale.setScalar(scale); prop.rotation.y = x * .4; prop.position.set(x, surface.point.y - .03, z); planted.add(prop);
  }
  models.planted_headland = { scene: planted };
  // Reference-only variants share the original meshes; palms omit the wide root-grass group.
  for (const [id, tilt] of [['hero',-5],['middle',-3],['near',6]]) {
    const scene=source.palm_crooked.scene.clone(true);scene.rotation.z=tilt*Math.PI/180;
    scene.position.y=-new THREE.Box3().setFromObject(scene,true).min.y;scene.userData.tiltDegrees=tilt;
    models[`reference_palm_${id}`]={scene};
  }
  for (const [id, color, tilt] of [['red','#ef5546',-6], ['yellow','#ffc348',2], ['blue','#159bd5',5]]) {
    const scene = source.surfboard.scene.clone(true), paint = new THREE.Color(color);
    scene.traverse(mesh => { if (mesh.isMesh) {
      mesh.geometry = mesh.geometry.clone(); const colors = mesh.geometry.attributes.color;
      for (let i=0;i<colors.count;i++) if (colors.getY(i)>colors.getX(i)*1.2 && colors.getZ(i)>colors.getX(i)) colors.setXYZ(i,paint.r,paint.g,paint.b);
    } });
    scene.rotation.z=tilt*Math.PI/180;scene.position.y=-new THREE.Box3().setFromObject(scene,true).min.y;scene.userData.tiltDegrees=tilt;
    models[`reference_board_${id}`] = { scene };
  }
  const boards=new THREE.Group();
  for(const [id,x,z] of [['red',-.8,0],['yellow',0,.15],['blue',.8,-.1]]) {
    const board=models[`reference_board_${id}`].scene.clone(true);board.position.x+=x;board.position.z+=z;boards.add(board);
  }
  models.reference_boards={scene:boards};
  for (const [id,name] of [['chevrons','corner_chevrons'],['arrow','corner_arrow_single']]) {
    const scene=source[name].scene.clone(true), red=new THREE.Color('#e95345'), white=new THREE.Color('#fff8e9');
    scene.traverse(mesh=>{if(mesh.isMesh){
      mesh.geometry=mesh.geometry.clone();const colors=mesh.geometry.attributes.color;
      for(let i=0;i<colors.count;i++) {
        const r=colors.getX(i),g=colors.getY(i),b=colors.getZ(i),paint=r<.05&&b>.05?red:r>.85&&g>.4&&b<.1?white:null;
        if(paint) colors.setXYZ(i,paint.r,paint.g,paint.b);
      }
    }});models[`reference_sign_${id}`]={scene};
  }
  const headland = planted.clone(true), headlandRocks = headland.getObjectByName('rock-terraces');
  headlandRocks.scale.y = 1.4; headlandRocks.updateMatrixWorld(true);
  for (const prop of headland.children.filter(child => child !== headlandRocks)) {
    ray.set(new THREE.Vector3(prop.position.x,100,prop.position.z),new THREE.Vector3(0,-1,0));
    const surface=ray.intersectObject(headlandRocks,true)[0]; if(surface) prop.position.y=surface.point.y-.03;
  }
  for (const [name,x,z,scale,yaw] of [
    ['lifeguard_tower',-16,11.5,1.25,.15], ['lifeguard_tower',9,-3,1.1,-.3],
    ['timber_fence_4m',-10,9,1,.1], ['timber_fence_4m',12,1,1,0],
    ['flower_rock_patch',-7,5,1.7,.3], ['flower_rock_patch',1,-2,1.4,1],
    ['flower_rock_patch',13,-2,1.4,2], ['flower_rock_patch',-17,7,1.5,.7],
  ]) {
    ray.set(new THREE.Vector3(x,100,z),new THREE.Vector3(0,-1,0));
    const surface=ray.intersectObject(headlandRocks,true)[0]; if(!surface) continue;
    const prop=source[name].scene.clone(true); prop.scale.setScalar(scale); prop.rotation.y=yaw;prop.position.set(x,surface.point.y-.03,z);headland.add(prop);
  }
  for (const [x,z,width] of [[9,-3,2.8],[-11,12,2.4]]) {
    ray.set(new THREE.Vector3(x,100,z),new THREE.Vector3(0,-1,0));
    const roof=ray.intersectObject(headlandRocks,true)[0];if(!roof) continue;
    const top=roof.point.y-.06;
    ray.set(new THREE.Vector3(x,top,100),new THREE.Vector3(0,0,-1));
    const face=ray.intersectObject(headlandRocks,true)[0];if(!face) continue;
    const water=source.water_surface.scene.clone(true);water.name='waterfall';water.rotation.x=Math.PI/2;
    water.scale.set(width/24,1,top/24);water.position.set(x,top/2,face.point.z+.025);
    water.traverse(mesh=>{if(mesh.isMesh) mesh.userData.noShadow=true;});headland.add(water);
  }
  for (const [x,y,z] of [[-13,12,6],[0,21,6],[10,15,3],[15,9,3],[-18,5,12]]) {
    const vine=source.shrub_strip.scene.clone(true);vine.rotation.z=Math.PI/2;vine.scale.set(.9,.6,.45);vine.position.set(x,y,z);headland.add(vine);
  }
  models.reference_headland = { scene: headland };
  // Low undergrowth shares each palm's anchor, below its crown and clear of its trunk.
  for (const name of ['palm_single', 'palm_crooked', 'palm_fan_short', 'palm_twin']) {
    const scene = source[name].scene.clone(true);
    for (const [x, z, rotation] of [[-1, .7, .5], [.8, 1.1, 2.4]]) {
      const grass = source.dune_grass_patch.scene.clone(true);
      grass.position.set(x, 0, z); grass.rotation.y = rotation; grass.scale.setScalar(.8); scene.add(grass);
    }
    models[name] = { scene };
  }
  return models;
}

export function createLighthouseBeacon(model, placement) {
  const group=new THREE.Group();group.name='lighthouse-beacon';
  group.position.set(placement.x,placement.y,placement.z);group.rotation.y=placement.rotation;group.scale.setScalar(placement.scale);
  const rotor=model.clone(true);group.add(rotor);group.updateMatrixWorld(true);
  const lens=rotor.getObjectByName('Beacon_Lens_PC');lens.material=lens.material.clone();lens.material.emissive.set('#fff0c2');
  const origin=rotor.getWorldPosition(new THREE.Vector3()),target=new THREE.Object3D();
  target.position.set(550/placement.scale,-(origin.y+.08)/placement.scale,0);rotor.add(target);
  const light=new THREE.SpotLight('#fff0cf',0,900,4*Math.PI/180,.9,2);light.name='lighthouse-spot';light.position.set(1.02,0,0);light.target=target;rotor.add(light);
  const length=850/placement.scale,geometry=new THREE.ConeGeometry(Math.tan(light.angle)*length,length,16,1,true);
  geometry.rotateZ(Math.PI/2);geometry.translate(length/2,0,0);
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,depthTest:true,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,
    uniforms:{strength:{value:0},color:{value:new THREE.Color('#fff0cf')}},
    vertexShader:`varying vec2 vUv;varying vec3 vNormal,vView;
      void main(){vUv=uv;vNormal=normalMatrix*normal;vec4 p=modelViewMatrix*vec4(position,1.0);vView=-p.xyz;gl_Position=projectionMatrix*p;}`,
    fragmentShader:`varying vec2 vUv;varying vec3 vNormal,vView;uniform float strength;uniform vec3 color;
      void main(){float along=1.0-vUv.y;float fade=(1.0-smoothstep(0.1,1.0,along))*smoothstep(0.0,0.025,along);
        float edge=pow(abs(dot(normalize(vNormal),normalize(vView))),0.7);gl_FragColor=vec4(color,strength*fade*edge);
        #include <colorspace_fragment>
      }`,
  });
  const beam=new THREE.Mesh(geometry,material);beam.name='lighthouse-beam';beam.position.copy(light.position);
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(1,0,0),target.position.clone().sub(light.position).normalize());rotor.add(beam);
  light.visible=beam.visible=false;lens.material.emissiveIntensity=0;
  return {group,update(sunAltitude,seconds){
    const strength=sunsetStrength(sunAltitude);
    light.visible=beam.visible=strength>0;light.intensity=80000*strength;material.uniforms.strength.value=.03*strength;lens.material.emissiveIntensity=1.5*strength;
    if(strength)rotor.rotation.y=seconds*Math.PI*2/24;
  }};
}

export function createClouds(models, count = 6) {
  const group = new THREE.Group(); group.name = 'coast-clouds';
  const material = models[`${CLOUD_MODELS[0]}_pc`].scene.getObjectByProperty('isMesh', true).material.clone();
  for (let i = 0; i < count; i++) {
    const id = CLOUD_MODELS[i % 3], lod = new THREE.LOD(); lod.autoUpdate = false;
    // A distant cloud bank stays visible above the horizon without entering the driving camera.
    const angle = -.35 + i * 2.39996, elevation = (10 + i % 5 * 2) * Math.PI / 180, distance = 600;
    lod.position.set(Math.sin(angle) * Math.cos(elevation) * distance, Math.sin(elevation) * distance,
      -Math.cos(angle) * Math.cos(elevation) * distance);
    lod.rotation.y = i * .8; lod.scale.setScalar((i === 1 ? 3.2 : 1.3 + i % 3 * .28) * 2);
    for (const [detail, distance] of [['pc', 0], ['mobile', 260]]) {
      const cloud = models[`${id}_${detail}`].scene.clone(true);
      cloud.traverse(mesh => { if (mesh.isMesh) { mesh.material = material; mesh.castShadow = mesh.receiveShadow = false; } });
      lod.addLevel(cloud, distance, .15);
    }
    lod.userData.height = new THREE.Box3().setFromObject(models[`${id}_pc`].scene).getSize(new THREE.Vector3()).y * lod.scale.y;
    group.add(lod);
  }
  return group;
}

export function updateClouds(clouds, camera, viewportHeight, now) {
  clouds.position.copy(camera.position); clouds.rotation.y = now * .0012;
  clouds.updateMatrixWorld(true); camera.updateMatrixWorld();
  for (const lod of clouds.children) {
    // Native LOD hysteresis, with its distance threshold derived from a 32px silhouette.
    lod.levels[1].distance = lod.userData.height * viewportHeight / (2 * Math.tan(camera.fov * Math.PI / 360) * 32);
    lod.update(camera);
  }
}

// Fixed seed keeps the authored pockets stable across reloads and all players.
export function beachLayout(track, bounds) {
  const gridTrack = track;
  // Scenery keeps its authored world positions when the start/finish line moves.
  track = { ...track, startDistance: 0 };
  // Retain the authored PC footprint budgets when mobile geometry has a tighter outline.
  bounds = { ...bounds };
  for (const [name, [min, max]] of Object.entries({
    cliff_columns: [[-5.131626605987549,-.06523019075393677,-2.909249782562256],[5.490055084228516,9.220000267028809,2.352858781814575]],
    cliff_terrace: [[-5.577950954437256,-.0691077932715416,-4.372693061828613],[5.509800434112549,7.820000171661377,4.026639461517334]],
    sea_stacks: [[-4.697290897369385,-.36792582273483276,-2.7839760780334473],[4.551028728485107,8.619999885559082,1.5354053974151611]],
    flower_rock_patch: [[-.8972125053405762,0,-.5725710391998291],[.7281376719474792,.8299999833106995,.5976987481117249]],
    coastal_island: [[-30.618262672424315,0,-12.018674325942994],[38.672540998458864,29.712737464904787,13.274590492248535]],
    coastal_headland: [[-19.713697004318238,0,-9.182655429840088],[16.686077117919922,14.856368732452394,8.455942869186401]],
    planted_headland: [[-22.713697004318238,0,-9.182655429840088],[18.15227509319012,20.14409445192498,15.650614976882935]],
    reference_headland: [[-22.713697004318238,-2.7755575615628914e-17,-9.182655429840088],[16.91962522297971,24.863826074247697,15.650614976882935]],
  })) if (bounds[name]) bounds[name] = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
  const items = [], half = track.width / 2;
  const occupied = [-1, 1].map(side => ({ ...sampleTrack(0, side * (half + 1.25), gridTrack), radius: .55 }));
  let seed = 2913;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  function place(name, distance, offset, rotation = 0, scale = 1, layer = 'mid', y = -.08, position, footprint) {
    if (track.id === 'mandalika') {
      if (/surf|lifeguard|beach_seats|parasol|sun_lounger|striped_towel|thatch_hut|changing_hut|picnic_table|beach_radio|icecream_cart|menu_sign|recycling_bin|outdoor_shower|volleyball_net|swim_ring|sandcastle|cooler|promenade|hedge_planter|rowboat|jetski|sailboat|beach_bunting|wooden_dock/.test(name) || name.startsWith('palm_')) return;
      if (LOW_GREENERY.test(name) && random() > .12) return;
      if (name === 'planted_headland') name = 'coastal_headland';
      if (name === 'lighthouse_islet') return;
      else if (layer === 'far' && ['coastal_island', 'coastal_headland', 'sea_stacks'].includes(name)) scale *= 2;
    }
    const b = bounds[name];
    let p = position || sampleTrack(distance, offset, track);
    const radius = footprint ?? Math.hypot(Math.max(Math.abs(b.min.x), Math.abs(b.max.x)),
      Math.max(Math.abs(b.min.z), Math.abs(b.max.z))) * scale;
    const wreck = track.id === 'mandalika' && items.find(item => item.authored === 'mandalika-wreck');
    if (wreck && /coastal_headland|cliff_columns|distant_arch|shore_rock_cluster|cliff_fragment/.test(name)) {
      const dx = p.x - wreck.x, dz = p.z - wreck.z, separation = wreck.radius + radius + 10;
      const across = dx * Math.cos(wreck.rotation) - dz * Math.sin(wreck.rotation);
      const toward = -dx * Math.sin(wreck.rotation) - dz * Math.cos(wreck.rotation);
      const blocksView = toward > 0 && Math.abs(across) < wreck.radius * .8 && Math.hypot(dx, dz) < wreck.radius + 90;
      if (Math.hypot(dx, dz) < separation || blocksView) {
        const angle = blocksView ? -wreck.rotation + (across < 0 ? Math.PI : 0) : Math.atan2(dz, dx);
        p = { x: wreck.x + Math.cos(angle) * separation, z: wreck.z + Math.sin(angle) * separation };
      }
    }
    const road = nearestTrack(p.x, p.z, track);
    // A full footprint, including palm crowns, stays outside the driving corridor.
    if (Math.abs(road.offset) - radius < half + 1.3) return;
    const water = y < -1 && layer !== 'inland' || layer === 'pier';
    const shoreLimit = layer === 'headland' ? -half - 1.3 : layer === 'shore' ? -28 : layer === 'pier' || layer === 'terrain' ? -23 : -32;
    if (water ? road.offset + radius > shoreLimit : road.offset - radius < -26.5) return;
    // ponytail: static circle scan at load time; use a spatial grid only for much larger courses.
    if (occupied.some(item => Math.hypot(item.x - p.x, item.z - p.z) < item.radius + radius + .16)) return;
    const item = { name, x: p.x, z: p.z, y, rotation, scale, radius, layer };
    if (footprint !== undefined) item.clearanceHeight = 3.5;
    items.push(item); occupied.push(item);
    return item;
  }
  // Reserve the start-camera composition before the repeated beach pockets fill it.
  const start = sampleTrack(0, 0, track);
  if (track.id === 'technical') place('landmark_assembly',0,0,0,2,'inland',-.08,{x:30,z:-230});
  if (track.id === 'beginner') place('finish_wreck',track.length-38,-48,.8,1,'submerged',-1.5);
  place('lighthouse_islet', 0, 0, .2, track.id === 'beginner' ? 1.2 : 2.1, 'far', -1.4, track.id === 'beginner' ? {x:23.35,z:-229.31} : {
    x: start.x + Math.sin(start.yaw) * 220 - Math.cos(start.yaw) * 45,
    z: start.z - Math.cos(start.yaw) * 220 - Math.sin(start.yaw) * 45,
  });
  if (track.id === 'beginner') {
    const first = items.length, face = .708;
    place('reference_headland', 0, 0, face, .85, 'headland', -1.4, {x:72,z:-205});
    // ponytail: authored pole/rope anchors allow elevated crowns/panels to overlap; test the full geometry below 3.5m against the road.
    place('reference_palm_hero', 186.3, -11.7, face, 1.65, 'mid', -.08, undefined, 1.3);
    place('reference_palm_middle', 188.6, -15.8, face+.2, 1.35, 'mid', -.08, undefined, 1.2);
    place('reference_palm_near', 203.8, -15, face-.4, 1.9, 'mid', -.08, undefined, 1.2);
    for(const d of [176,214]) place('wooden_dock',d,-33.5,-sampleTrack(d,0,track).yaw+Math.PI/2,1,'pier',-.78);
    for (const [name,d,offset,scale,yaw] of [
      ['reference_boards',194,-12.1,1.15,face], ['wooden_crate',196.5,-12.4,1.1,face+.2],
      ['beach_seats',197,-15.3,1.05,face+.5], ['beach_seats',198.6,-23,1.05,face-.4],
      ['parasol',201.5,-22,1.5,face+.1], ['picnic_table',181,-19,1.15,face],
      ['shore_rock_cluster',201,-13.8,1.1,1.2], ['shore_rock_cluster',184,-14.5,1.1,.4],
      ['shore_rock_cluster',216,-20,1.1,2], ['reference_sign_chevrons',202.8,-13.3,.8,face],
      ['reference_sign_chevrons',178,-12.8,1.1,face], ['reference_sign_arrow',167,-12.7,1,face],
    ]) {
      const item=place(name,d,offset,yaw,scale,'mid',-.08,undefined,name.startsWith('reference_sign_')?.55:name==='beach_seats'?1.3:name==='parasol'?.35:undefined);
      if(item && name.startsWith('reference_sign_')) item.mirror=true;
    }
    for (let d=170;d<=222;d+=5) place('rope_fence_4m',d,-12.7,-sampleTrack(d,0,track).yaw+Math.PI/2,1,'near',-.08,undefined,.4);
    for (let d=168;d<224;d+=2) for(const offset of [-14.3,-21.5,-25])
      place(d%6===0?'flower_rock_patch':'dune_grass_patch',d,offset,d*.61,1.25,'near');
    for (let d=174;d<221;d+=7) place('bollard',d,-10.8,0,1.1,'near');
    // Low foliage overlaps naturally; reserve its roots and verify its full geometry clears the asphalt.
    for (let d=168;d<224;d+=1.6) for(const offset of [-12,-16.5,-20])
      place('dune_grass_patch',d,offset,d*.61,1.7,'near',-.08,undefined,.65);
    for (const item of items.slice(first)) item.authored='coastline-reference';
  }
  if (track.id === 'mandalika') {
    const position = { x: 780, z: 80 }, b = bounds.reference_inland_wreck;
    const clearance = Math.abs(nearestTrack(position.x, position.z, track).offset) - half - 2;
    const scale = .8 * clearance / Math.hypot(Math.max(Math.abs(b.min.x), Math.abs(b.max.x)), Math.max(Math.abs(b.min.z), Math.abs(b.max.z)));
    const wreck = place('reference_inland_wreck', 0, 0, -1.42, scale, 'inland', -.08 - b.min.y * scale - 2.5, position);
    if (wreck) { wreck.authored = 'mandalika-wreck'; wreck.buriedDepth = 2.5; }
    for (let d = 20; d < track.length; d += 22) for (const side of [-1, 1]) {
      const distance = d + random() * 6 - 3, here = sampleTrack(distance, 0, track);
      if ([-20, 20].some(along => {
        const road = sampleTrack(distance + along, 0, track);
        return Math.abs(Math.atan2(Math.sin(road.yaw - here.yaw), Math.cos(road.yaw - here.yaw))) > .08;
      })) continue;
      const name = random() < .65 ? 'avenue_palm_single' : 'avenue_palm_crooked';
      const scale = name === 'avenue_palm_single' ? 2.5 + random() * .7 : 1.9 + random() * .5;
      // Crowns may overhang the verge; reserve the trunk footprint as on the technical avenue.
      const palm = place(name, distance, side * (14.5 + random() * 3), random() * Math.PI * 2, scale, 'mid', -.08, undefined, 1.1);
      if (palm) palm.authored = 'mandalika-avenue';
    }
  }
  if(track.id==='technical') {
    // Reserve authored pockets without shifting the filler pass's starting random seed.
    const first=items.length,retainedSeed=seed;
    for(const side of [-1,1]) for(let d=780+random()*7;d<=1020;d+=6+random()*4.5) {
      const name=random()<.65?'avenue_palm_single':'avenue_palm_crooked';
      const palm=place(name,d,side*(12.8+random()*3.2),random()*Math.PI*2,1.25+random()*.9,'mid',-.08,undefined,1.1);
      if(palm) palm.authored='technical-avenue';
    }
    for(let d=180;d<track.length;d+=520) {
      const face=Math.PI/2-sampleTrack(d,0,track).yaw;
      place('reference_boards',d-11,-13.8,face,1.05);
      place('wooden_crate',d-7.4,-14.4,face+.2,1.1);
      place('beach_seats',d+8,-21,face-.25,1.05,'mid',-.08,undefined,1.4);
      place('lifeguard_tower',d+30,-21.5,face+.15,1.1);
      const sign=place('reference_sign_chevrons',d-24,-12.6,-sampleTrack(d-24,0,track).yaw,1,'near',-.08,undefined,.55);
      if(sign) sign.mirror=true;
      for(const [name,along,offset] of [['reference_palm_hero',-20,-17],['reference_palm_middle',20,-24],['reference_palm_near',32,-14.8]])
        place(name,d+along,offset,random()*6.28,1.15+random()*.5,'mid',-.08,undefined,1.1);
      for(let along=-18;along<=18;along+=6)
        place('rope_fence_4m',d+along,-12.8,Math.PI/2-sampleTrack(d+along,0,track).yaw,1,'near',-.08,undefined,.4);
      for(let along=-28;along<=30;along+=3) for(const offset of [-16.2,-22,-25])
        place(random()<.05?'flower_rock_patch':'dune_grass_patch',d+along,offset+(random()-.5),random()*6.28,1.1+random()*.5,'near',-.08,undefined,.65);
    }
    for(const item of items.slice(first)) if(!item.authored) item.authored='technical-coast';
    seed=retainedSeed;
  }
  // Reuse the loaded tropical kit at palm scale, reserved before the generic inland cliffs.
  place('distant_arch', 115, 40, -start.yaw + .15, 2);
  place('planted_headland', 540, 80, -.4, 1, 'inland');
  place('palm_crooked', 95, 45, .6, 1.7);
  place('palm_single', 140, 40, 2.2, 2.1);
  for (const [name, d, offset, scale, turn] of [
    ['lifeguard_tower', 46, -19, 2.3, .1], ['thatch_hut', 32, 21, 1.2, -.15],
    ['beach_seats', 49, 21, 1.2, 0], ['beach_seats', 75, 21, 1.15, .2],
    ['beach_seats', 64, -20, 1.2, -.2], ['parasol', 17, 16, 1.3, .3],
    ['changing_hut', 57, 17, 1.2, .2], ['surf_rack', 38, -17, 1.3, .3],
    ['palm_single', 8, 22, 2.3, .4], ['palm_crooked', 21, 25, 1.8, 1.4],
    ['palm_single', 60, 27, 2, 2.2], ['palm_fan_short', 66, 18, 1.3, .8],
    ['palm_single', 42, 31, 2.1, 1.2], ['palm_crooked', 86, 30, 1.8, -.7],
    ['palm_crooked', 5, -20, 1.8, -.4],
    ['surfboard', 15, -17, 1.5, .1], ['surfboard', 18, -18, 1.6, -.1],
    ['surfboard', 21, -17, 1.4, .3], ['timber_fence_4m', 12, 13.5, 1.2, Math.PI / 2],
    ['timber_fence_4m', 18, 13.5, 1.2, Math.PI / 2], ['corner_chevrons', 83, 13.2, 1.4, 0],
  ]) place(name, d, offset, -sampleTrack(d, 0, track).yaw + turn, scale, name.includes('fence') || name.startsWith('corner_') ? 'near' : 'mid');
  for (let d = 24; d < 85; d += 6) for (const side of [-1, 1]) {
    place(side < 0 ? 'rope_fence_4m' : 'timber_fence_4m', d, side * 15.3,
      -sampleTrack(d, 0, track).yaw + Math.PI / 2, 1.2, 'near');
  }
  // Lower islands and arches give the other sectors distinct silhouettes.
  for (let d = 30; d < track.length; d += 180) {
    const i = Math.floor(d / 180);
    const island=place('coastal_island', d, -145 - i % 2 * 35, i * .9, 1.2+i%3*.15, 'far', -1.4);
    // Lower this occluder but retain its reserved footprint, so tall fillers cannot replace it.
    if(track.id==='technical' && d===210 && island) island.scale=.75;
  }
  // Fill outward sight lines through the S bends, still subject to water/road/overlap checks.
  for (let d = 60; d < track.length; d += 180) {
    const p = sampleTrack(d, 0, track);
    place('coastal_island', d, 0, -p.yaw + .4, 1.2, 'far', -1.4, {
      x: p.x + Math.sin(p.yaw) * 210 - Math.cos(p.yaw) * 80,
      z: p.z - Math.cos(p.yaw) * 210 - Math.sin(p.yaw) * 80,
    });
  }
  for (let d = 190; d < track.length; d += 240) place('coastal_headland', d, -76,
    -sampleTrack(d, 0, track).yaw, 1, 'far', -1.4);
  for (let stretch = 0; stretch < track.length; stretch += 720) for (const [name, distance, offset, rotation] of [
    ['distant_arch', 175, -47, .8], ['sea_stacks', 260, -61, 1.1],
    ['distant_arch', 440, -48, 2], ['sea_stacks', 620, -68, .5],
  ]) if (stretch + distance < track.length) place(name, stretch + distance, offset, rotation, 1, 'far', -1.4);
  for (let stretch = 0; stretch < track.length; stretch += 720) for (const [name, distance, offset, rotation] of [
    ['coastal_headland', 115, 58, .5], ['cliff_columns', 290, 51, 1.8],
    ['distant_arch', 485, 43, -.7], ['cliff_columns', 640, 46, 2.6],
  ]) if (stretch + distance < track.length) {
    const scale=name==='cliff_columns'?1.8:1;
    const planted=track.id==='technical' && name==='coastal_headland' && stretch!==1440;
    const cliff=place(planted?'planted_headland':name,stretch+distance,offset,rotation,scale,'inland',-.08-bounds[planted?'planted_headland':name].min.y*scale);
    if(planted && cliff) {cliff.authored='technical-coast';cliff.castShadow=false;}
    if(track.id==='technical' && name==='coastal_headland' && stretch===1440 && cliff) {
      cliff.scale=.4;cliff.y=-.08-bounds[name].min.y*.4;
    }
  }

  for (const [name, d, offset, turn, scale] of [
    ['surf_shop', 325, 23, -.2, 1.05], ['lifeguard_tower', 550, 22, -.15, 1.7],
    ['wooden_barrel', 64, 18, .2, 1], ['wooden_crate', 72, 18, .4, 1],
    ['wooden_barrel', 319, 18, .4, 1], ['wooden_crate', 330, 18, .1, 1],
  ]) place(name, d, offset, -sampleTrack(d, 0, track).yaw - Math.sign(offset) * Math.PI / 2 + turn, scale);
  for (const d of track.id==='beginner'?[24,176,214]:[24,275,558]) {
    const yaw = -sampleTrack(d, 0, track).yaw;
    // Authored deck Y=.72: joined modules meet the shore 2cm above the sand.
    place('wooden_dock', d, -33.5, yaw + Math.PI / 2, 1, 'pier', -.78);
    // Stretch uniformly from water (-1.4) to sand (-.08); its rear edge meets lateral -27.
    const shoreScale = 1.32 / bounds.shore_skirt.max.y;
    place('shore_skirt', d + 12, -26.8 - 2 * shoreScale,
      -sampleTrack(d + 12, 0, track).yaw - Math.PI / 2, shoreScale, 'terrain', -1.4);
  }
  for (let d = 1; d < 90; d += 2) for (const side of [-1, 1]) {
    for (const offset of [11.3, 18, 24]) place(d % 7 === 0 ? 'flower_rock_patch' : 'dune_grass_patch',
      d + offset % 3 * .3, side * (offset + Math.sin(d) * .25), d * .73, 1 + d % 5 * .05, 'near');
  }
  place('sailboat', 530, -76, .4, 1, 'far', -1.4);

  for (let d = 58; d < track.length; d += 220) {
    const side = Math.floor(d / 220) % 2 ? 1 : -1;
    place('beach_bunting', d, side * 19, Math.PI / 2 - sampleTrack(d, 0, track).yaw);
  }
  for (const [d, side] of [[35, -1], [53, 1]]) {
    place('red_flag_pole_3m', d, side * 12.8, -sampleTrack(d, 0, track).yaw, 1, 'near');
  }

  const palms = ['palm_single', 'palm_crooked', 'palm_fan_short', 'palm_twin'];
  for (let d = 135; d < track.length; d += 115) for (const [along, side, name, scale] of [
    [0, -1, 'palm_crooked', 1.8], [30, 1, 'palm_single', 2.1],
  ]) place(name, d + along, side * 18.8, d * .11, scale);
  // Beach clubs are loose, separated arrangements; no table props or stairs need guessed heights.
  const sectors = Math.ceil(track.length / 90);
  for (let sector = 0; sector < sectors; sector++) {
    const d = 28 + sector * track.length / sectors, side = sector % 3 === 1 ? 1 : -1;
    const yaw = -sampleTrack(d, 0, track).yaw;
    place('beach_seats', d + 8, side * 20, yaw + side * Math.PI / 2);
    for (const [name, along, outward, turn] of [
      ['changing_hut', 0, 22, 0],
      ['cooler', 12.8, 17.5, -.2],
      ['swim_ring', 14, 20, .3], ['sandcastle', 16, 17, 1.2],
      ['picnic_table', 21, 21, .3], ['beach_radio', 23.5, 19, .7],
      ['icecream_cart', 28, 20, 0], ['menu_sign', 30.5, 18, -.2],
      ['recycling_bin', 32, 21, 0], ['surf_rack', 37, 21, .3],
      ['surfboard', 40, 18, .5], ['outdoor_shower', 43, 22, 0],
      ['volleyball_net', 58, 22, Math.PI / 2],
      ['promenade_bench', 3, 15, Math.PI / 2], ['hedge_planter', 25, 15, Math.PI / 2],
      ['promenade_lantern', 35, 14.7, 0],
    ]) place(name, d + along, side * outward, yaw + turn);
    if (side < 0) {
      for (const [name, along, offset] of [['rowboat', 12, -38], ['jetski', 32, -42],
        ['channel_buoy', 22, -51]]) {
        place(name, d + along, offset, yaw + .2, 1, 'far', -1.4);
      }
    }
  }
  const groves = Math.ceil(track.length / 90);
  for (let grove = 0; grove < groves; grove++) {
    const count = [3, 5, 7, 5][grove % 4], side = grove % 3 === 1 ? 1 : -1;
    for (let i = 0; i < count; i++) {
      const name = palms[(grove + i) % palms.length], d = grove * track.length / groves + i * 7 + 8;
      place(name, d, side * (18 + (i % 2) * 3 + random()), random() * 6.28,
        name === 'palm_fan_short' ? .95 + random() * .25 : 1.35 + random() * .3);
    }
  }
  // Low green masses fill the sand without a uniform forest of tall palms.
  for (let d = 10; d < track.length; d += 26) {
    for (let i = 0; i < 3; i++) place(i % 2 ? 'canopy_cap' : 'shrub_strip', d + i * 4.1,
      32 + random() * 24, random() * 6.28, .85 + random() * .35, 'inland');
  }
  for (let d = 3; d < track.length; d += 7.5) for (const side of [-1, 1]) {
    const i = Math.floor(d / 7.5), pocket = i % 11;
    const name = pocket === 8 ? 'cliff_fragment' : pocket === 9 ? 'shore_rock_cluster' : pocket % 3 ? 'shrub_strip' : 'canopy_cap';
    const offset = side * (17 + random() * (side < 0 ? 4 : 10));
    place(name, d + random() * 2, offset, random() * Math.PI * 2, .86 + random() * .28);
    if (pocket < 4) place(pocket === 1 ? 'flower_rock_patch' : 'dune_grass_patch', d + 3.5,
      side * (side < 0 ? 23 : 30), random() * 6.28, .9);
  }
  // Tangential fences are short runs with open approaches to each beach pocket.
  for (let d = 15; d < track.length; d += 39) for (const side of [-1, 1]) {
    const yaw = -sampleTrack(d, 0, track).yaw + Math.PI / 2;
    place(side < 0 ? 'rope_fence_4m' : 'timber_fence_4m', d, side * 13.5, yaw, 1, 'near');
    const ahead = sampleTrack(d + 22, 0, track), here = sampleTrack(d, 0, track);
    const turn = Math.atan2(Math.sin(ahead.yaw - here.yaw), Math.cos(ahead.yaw - here.yaw));
    if (Math.abs(turn) > .18) {
      const sign = place(Math.abs(turn) > .4 ? 'corner_chevrons' : 'corner_arrow_single', d + 5,
        side * 12.5, yaw - Math.PI / 2, 1, 'near');
      if (sign) sign.mirror = turn < 0;
    }
  }
  for (let d = 12; d < track.length; d += 18) {
    const i = Math.floor(d / 18), side = i % 2 ? 1 : -1;
    const name = ['wooden_crate', 'wooden_barrel', 'red_flag_pole_3m'][i % 3];
    place(name, d, side * (11.9 + i % 3 * .3), -sampleTrack(d, 0, track).yaw, 1, 'near');
  }
  for (let d = 1; d < track.length; d += 2.8) for (const side of [-1, 1]) {
    const r = random(), name = r < .82 ? 'dune_grass_patch' : r < .91 ? 'flower_rock_patch' : 'bollard';
    if (!place(name, d + random() * .3, side * (10.8 + random() * 2.5), random() * 6.28, .8 + random() * .3, 'near')) {
      place('dune_grass_patch', d, side * 10.6, random() * 6.28, .8, 'near');
    }
  }
  for (let d = 0; d < track.length; d += 5.2) {
    const yaw = -sampleTrack(d, 0, track).yaw + Math.PI / 2;
    place('foam_strip_visual', d, -32.8, yaw, 1, 'shore', -1.375);
  }
  if(track.id==='beginner') {
    const d=track.length/2+12;
    // Dress this sector after fillers so its reservations cannot shift random choices elsewhere.
    function dress(...args) {
      const [name,distance,offset,,scale]=args,b=bounds[name],p=sampleTrack(distance,offset,track);
      const radius=args[8]??Math.hypot(Math.max(Math.abs(b.min.x),Math.abs(b.max.x)),Math.max(Math.abs(b.min.z),Math.abs(b.max.z)))*scale;
      const overlaps=items.filter(item=>Math.hypot(item.x-p.x,item.z-p.z)<item.radius+radius+.16);
      if(overlaps.some(item=>item.authored||['finish_wreck','lighthouse_islet','planted_headland','distant_arch','coastal_island','coastal_headland','cliff_columns'].includes(item.name))) return;
      const removed=overlaps.map(item=>[item,items.indexOf(item),occupied.indexOf(item)]);
      for(const item of overlaps) {items.splice(items.indexOf(item),1);occupied.splice(occupied.indexOf(item),1);}
      const item=place(...args);
      if(item) item.authored='coastline-sector7';
      else for(const [original,i,j] of removed) {items.splice(i,0,original);occupied.splice(j,0,original);}
      return item;
    }
    for(const side of [-1,1]) {
      const face=Math.PI/2-sampleTrack(d,0,track).yaw+(side>0?Math.PI:0);
      dress('reference_headland',d+(side<0?29:-2),side*(side<0?60:40),face,.7,side<0?'headland':'inland',side<0?-1.4:-.08);
      for(const [name,along,offset,scale,turn] of side<0?[
        ['reference_palm_hero',-6,12.5,1.85,.2],['reference_palm_middle',13,19.5,1.45,-.35],['reference_palm_near',-24,15.8,2,-.5],
      ]:[
        ['reference_palm_hero',-2,13.5,1.7,-.25],['reference_palm_middle',27,18.5,1.4,.4],['reference_palm_near',-17,16.3,1.9,-.5],
      ]) dress(name,d+along,side*offset,face+turn,scale,'mid',-.08,undefined,1.2);
      dress('reference_boards',d+7,side*13.6,face,1.15);
      dress('wooden_crate',d+10.5,side*14.4,face+.2,1.1);
      dress('beach_seats',d+22,side*22,face-.3,1.1,'mid',-.08,undefined,1.4);
      const sign=dress('reference_sign_chevrons',d+2,side*12.8,-sampleTrack(d+2,0,track).yaw,1,'near',-.08,undefined,.55);
      if(sign) sign.mirror=true;
      // Inside-bend post caps overlap; 6 mm between neighbours removes coplanar faces.
      for(let along=-27;along<=34;along+=5)
        dress('rope_fence_4m',d+along,side*12.5,Math.PI/2-sampleTrack(d+along,0,track).yaw,1,'near',-.08+((along+27)/5%2)*.006,undefined,.4);
      for(let along=-29;along<=37;along+=2.3) for(const offset of [14.8,18,24])
        dress(random()<.08?'flower_rock_patch':'dune_grass_patch',d+along,side*(offset+random()*.8),random()*6.28,1.2+random()*.5,'near',-.08,undefined,.65);
    }
  }
  if(track.id==='technical') {
    const wreck=place('reference_inland_wreck',0,0,.35,3,'inland',-.08-bounds.reference_inland_wreck.min.y*3-2.5,{x:160,z:-120});
    if(wreck) {
      wreck.buriedDepth=2.5;
      const worldBox=item=>bounds[item.name].clone().applyMatrix4(new THREE.Matrix4().makeRotationY(item.rotation).scale(new THREE.Vector3().setScalar(item.scale)).setPosition(item.x,item.y,item.z));
      const hull=worldBox(wreck).expandByVector(new THREE.Vector3(1.5,0,1.5)),eye=sampleTrack(track.length*.75,0,track);
      const dx=wreck.x-eye.x,dz=wreck.z-eye.z,lengthSquared=dx*dx+dz*dz;
      for(let i=items.length-2;i>=0;i--) {
        const item=items[i];if(['landmark_assembly','lighthouse_islet','coastal_island','coastal_headland','cliff_columns'].includes(item.name))continue;
        const along=((item.x-eye.x)*dx+(item.z-eye.z)*dz)/lengthSquared;
        const canopy=bounds[item.name].getSize(new THREE.Vector3()).length()*item.scale/2;
        const masksHull=item.name.includes('palm')&&along>0&&along<.9&&Math.hypot(item.x-eye.x-along*dx,item.z-eye.z-along*dz)<canopy;
        if(masksHull||Math.hypot(item.x-wreck.x,item.z-wreck.z)<wreck.radius+item.radius+3&&hull.intersectsBox(worldBox(item)))items.splice(i,1);
      }
    }
  }
  return items;
}

export function createBeachScenery(models, track, quality = 'high') {
  const bounds = {};
  for (const [name, model] of Object.entries(models)) {
    model.scene.updateMatrixWorld(true);
    bounds[name] = new THREE.Box3().setFromObject(model.scene,name.startsWith('reference_'));
  }
  const items=beachLayout(track,bounds),group=createPropInstances(models,items),landmark=items.find(item=>item.name==='landmark_assembly');
  setSceneryQuality(group, quality);
  group.userData.palmLighting=createPalmDownlights(group,track);
  if(landmark){const beacon=createLighthouseBeacon(models.lighthouse_rotor.scene,landmark);group.add(beacon.group);group.userData.lighthouse=beacon;}
  return group;
}

export function createCenterGuides(track, material) {
  const positions = [], indices = [];
  for (let d = 12; d < track.length; d += 12) {
    if (d >= BOOST_PAD.distance - 3 && d <= BOOST_PAD.distance + BOOST_PAD.length + 3) continue;
    const first = positions.length / 3;
    for (let i = 0; i <= 6; i++) {
      for (const offset of [-.055, .055]) {
        const p = sampleTrack(d - 1.5 + i * .5, offset, track); positions.push(p.x, .032, p.z);
      }
      if (i < 6) { const a = first + i * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material); mesh.name = 'center-guides'; mesh.receiveShadow = true;
  return mesh;
}

export function trackPropsLayout(track) {
  const items = [], barrierCenters = [];
  function add(name, distance, offset, y, scale = 1) {
    const p = sampleTrack(distance, offset, track);
    items.push({ name, x: p.x, z: p.z, y, rotation: -p.yaw, scale });
  }
  for (let d = 0; d < track.length; d += 5) if (Math.floor(d / 110) % 3 === 1) {
    for (const side of [-1, 1]) for (const along of [-2.15, .05]) {
      if(track.id==='beginner' && side<0 && d+track.startDistance>=155 && d+track.startDistance<=230) continue;
      const p = sampleTrack(d + along + 1, side * (track.width / 2 + .7), track);
      // 2m × .56m footprint fits inside a radius 1.04m circle, even at inside bends.
      if (barrierCenters.some(b => Math.hypot(b.x - p.x, b.z - p.z) < 2.12)) continue;
      barrierCenters.push(p);
      // Center the rigid 2m module on the sampled tangent at polyline corners.
      items.push({ name: 'barrier_bluewhite_2m', x: p.x - Math.sin(p.yaw), z: p.z + Math.cos(p.yaw),
        y: -.08, rotation: -p.yaw, scale: 1 });
    }
  }
  // White arrows fall between the existing 12m center dashes.
  for (let d = 30; d < track.length; d += 96) add('road_forward_arrow_visual', d, 0, .015);
  for (const [row, d] of [BOOST_PAD.distance, BOOST_PAD.distance + BOOST_PAD.length / 2].entries()) {
    // Rigid arrows overlap slightly where the pad bends; keep rows 6 mm apart.
    for (const offset of [-1.7, 0, 1.7]) add('boost_chevrons_visual_3m', d, offset, .018 + row * .006, 1.5);
  }
  return items;
}

const DETAIL_DENSITIES = {
  flower_rock_patch: { high: .25, medium: .125, low: 0 },
  dune_grass_patch: { high: 1, medium: .5, low: 0 },
  shore_rock_cluster: { high: 1, medium: .5, low: .25 },
};
const LOW_DECORATIONS = new Set(['beach_seats', 'parasol', 'sun_lounger', 'striped_towel',
  'wooden_crate', 'wooden_barrel', 'wood_crate_1m', 'wood_barrel_1m', 'foam_strip_visual']);
const LOW_DISTANT_ROCKS = new Set(['coastal_island', 'coastal_headland', 'cliff_columns',
  'cliff_terrace', 'sea_stacks', 'distant_arch']);
const LOW_GREENERY = /shrub|canopy_cap|dune_grass_patch|flower_rock_patch/i;

export function setSceneryQuality(group, quality = 'high') {
  if (!['high', 'medium', 'low'].includes(quality)) quality = 'high';
  group.traverse(mesh => {
    if (mesh.userData.sceneryCounts) mesh.count = mesh.userData.sceneryCounts[quality];
  });
}

export function createPropInstances(models, items) {
  const group = new THREE.Group(), matrix = new THREE.Matrix4();
  for (const name of new Set(items.map(item => item.name))) models[name].scene.updateMatrixWorld(true);
  // One draw per source mesh, shared geometry/materials; no hundreds of GLB object clones.
  for (const key of new Set(items.map(item => `${item.name}/${item.mirror ? 'left' : 'normal'}`))) {
    const [name, direction] = key.split('/');
    const placements = items.filter(item => item.name === name && !!item.mirror === (direction === 'left'));
    const detail = DETAIL_DENSITIES[name] && { name, total: placements.length, protected: placements.filter(item => item.authored).length };
    if (detail) {
      // One stable spatial rank keeps lower densities spread across the whole course.
      const rank = item => (Math.imul(Math.round(item.x * 100), 73856093) ^ Math.imul(Math.round(item.z * 100), 19349663)) >>> 0;
      placements.sort((a, b) => Number(!!b.authored) - Number(!!a.authored) || rank(a) - rank(b));
    }
    models[name].scene.traverse(source => {
      if (!source.isMesh) return;
      let palm = /palm/i.test(name) ? models[name].scene : null, green = LOW_GREENERY.test(name);
      for (let node = source; node; node = node.parent) {
        if (!palm && /palm/i.test(node.name)) palm = node;
        green ||= LOW_GREENERY.test(node.name);
        if (node === models[name].scene) break;
      }
      const palmHeight = palm ? new THREE.Box3().setFromObject(palm).getSize(new THREE.Vector3()).y : 0;
      const keep = placements.map((item, index) => {
        const high = !detail || index < detail.protected + Math.ceil((detail.total - detail.protected) * DETAIL_DENSITIES[name].high);
        const medium = high && (!palm || palmHeight * item.scale >= 7) &&
          (!detail || index < detail.protected + Math.ceil((detail.total - detail.protected) * DETAIL_DENSITIES[name].medium));
        const low = medium && !green && !LOW_DECORATIONS.has(name) &&
          !(item.layer === 'far' && LOW_DISTANT_ROCKS.has(name)) &&
          (!detail || index < detail.protected + Math.ceil((detail.total - detail.protected) * DETAIL_DENSITIES[name].low));
        return { item, tier: low ? 3 : medium ? 2 : high ? 1 : 0 };
      }).sort((a, b) => b.tier - a.tier);
      const geometry = direction === 'left' ? source.geometry.clone().scale(-1, 1, 1) : source.geometry;
      if (direction === 'left') {
        // Reflection reverses face winding; retain the authored outward normals and flat shading.
        const index = geometry.index;
        for (let i = 0; i < index.count; i += 3) {
          const b = index.getX(i + 1); index.setX(i + 1, index.getX(i + 2)); index.setX(i + 2, b);
        }
      }
      const mesh = new THREE.InstancedMesh(geometry, source.material, placements.length);
      mesh.name = `beach/${name}`;
      mesh.userData.sceneryTotal = placements.length;
      mesh.userData.sceneryCounts = Object.fromEntries(['high', 'medium', 'low'].map((quality, i) =>
        [quality, keep.filter(row => row.tier >= i + 1).length]));
      if (detail) mesh.userData.sceneryDetail = detail;
      mesh.userData.palm = /palm/i.test(source.name);
      mesh.castShadow = !source.userData.noShadow && placements.some(item => item.layer !== 'far' && item.castShadow !== false) &&
        !['foam_strip_visual', 'flower_rock_patch', 'dune_grass_patch', 'canopy_cap', 'shrub_strip'].includes(name);
      mesh.receiveShadow = true;
      keep.forEach(({ item }, i) => {
        matrix.makeRotationY(item.rotation).scale(new THREE.Vector3(item.scale, item.scale, item.scale));
        matrix.setPosition(item.x, item.y, item.z).multiply(source.matrixWorld);
        mesh.setMatrixAt(i, matrix);
      });
      mesh.computeBoundingBox(); mesh.computeBoundingSphere(); group.add(mesh);
    });
  }
  return group;
}
