import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TRACKS, BOOST_PAD, sampleTrack, nearestTrack } from '../shared/game.js';
import { COAST_MODELS } from '../public/models.js';
import { BEACH_MODELS, TROPICAL_MODELS, INLAND_MODELS, CLOUD_MODELS, TRACK_PROP_MODELS, prepareBeachModels, beachLayout, createBeachScenery,
  createPropInstances, trackPropsLayout, createCenterGuides, createClouds, updateClouds, separateCoplanarDetails } from '../public/beach.js';

test('overlapping coloured details move only millimetres and leave source geometry intact', () => {
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,0,-1,0,0,1,1,0,-1,-.8,0,-1,.2,0,1,1.2,0,-1],3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute([...Array(9).fill(.1),...Array(9).fill(.9)],3));
  const original=Array.from(geometry.attributes.position.array),repaired=separateCoplanarDetails(geometry);
  assert.notEqual(repaired,geometry);
  assert.deepEqual(Array.from(geometry.attributes.position.array),original,'source vertices stay unchanged');
  const p=repaired.attributes.position;
  assert.equal(p.getY(0),0);
  assert.ok(Math.abs(p.getY(3)-p.getY(0))>=.00099 && Math.abs(p.getY(3))<=.00101);
  geometry.attributes.color.array.fill(.1);
  assert.equal(separateCoplanarDetails(geometry),geometry,'identical shading needs no gap');
  geometry.attributes.color.array.fill(.9,9);
  for(let i=3;i<6;i++)geometry.attributes.position.setX(i,geometry.attributes.position.getX(i)+5);
  assert.equal(separateCoplanarDetails(geometry),geometry,'separate details need no gap');
});

test('beach layers stay grounded, clear the whole road and keep separate prop footprints', async t => {
  globalThis.self = globalThis;
  const loader = new GLTFLoader();
  loader.register(parser => {
    parser.textureLoader = { load(_url, loaded) { loaded(new THREE.Texture()); } };
    return { name: 'NODE_TEXTURE_ADAPTER' };
  });
  let models = {}; const bounds = {};
  for (const [folder, names] of [['coast', COAST_MODELS], ['beach', BEACH_MODELS], ['tropical', TROPICAL_MODELS],
    ['track-props', TRACK_PROP_MODELS], ['inland', INLAND_MODELS]]) for (const name of names) {
    const bytes = await readFile(new URL(`../public/assets/${folder}/${name}.glb`, import.meta.url));
    models[name] = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    bounds[name] = new THREE.Box3().setFromObject(models[name].scene);
  }
  const sources = models, geometrySources = new Map(), usedSources = new Set();
  models = prepareBeachModels(models);
  for (const [name, source] of Object.entries(sources)) source.scene.traverse(mesh => {
    if (mesh.isMesh) geometrySources.set(mesh.geometry, name);
  });
  const planted = models.planted_headland?.scene;
  assert.ok(planted, 'raised rock terraces support a planted palm grove');
  const rocks = planted.getObjectByName('rock-terraces'), ray = new THREE.Raycaster();
  rocks.updateMatrixWorld(true);
  const terracePalms = planted.children.filter(child => child.name === 'terrace-palm');
  assert.ok(terracePalms.length >= 3, 'multiple palms occupy the raised terraces');
  for (const palm of terracePalms) {
    ray.set(new THREE.Vector3(palm.position.x, 100, palm.position.z), new THREE.Vector3(0, -1, 0));
    const surface = ray.intersectObject(rocks, true)[0];
    assert.ok(surface && Math.abs(palm.position.y - surface.point.y + .03) < .001, 'palm roots touch the actual rock surface');
  }
  const referenceHeadland=models.reference_headland.scene, referenceRocks=referenceHeadland.getObjectByName('rock-terraces');
  referenceHeadland.updateMatrixWorld(true);
  const towerGeometry=models.lifeguard_tower.scene.getObjectByProperty('isMesh',true).geometry;
  const facilities=referenceHeadland.children.filter(child=>child.getObjectByProperty('geometry',towerGeometry));
  assert.equal(facilities.length,2);
  for(const tower of facilities) for(const palm of referenceHeadland.children.filter(child=>child.name==='terrace-palm')) {
    const p=palm.position,trunk=new THREE.Box3(new THREE.Vector3(p.x-.2,p.y,p.z-.2),new THREE.Vector3(p.x+.2,p.y+4,p.z+.2));
    assert.ok(!new THREE.Box3().setFromObject(tower,true).intersectsBox(trunk),'terrace palm trunks do not pass through tower decks or roofs');
  }
  const waterfalls=referenceHeadland.children.filter(child=>child.name==='waterfall');assert.equal(waterfalls.length,2);
  for(const water of waterfalls) {
    const box=new THREE.Box3().setFromObject(water,true);
    assert.ok(Math.abs(box.min.y)<.001,'waterfall ends at the sea-level anchor');
    ray.set(new THREE.Vector3(water.position.x,box.max.y,100),new THREE.Vector3(0,0,-1));
    const face=ray.intersectObject(referenceRocks,true)[0];
    assert.ok(face && Math.abs(water.position.z-face.point.z)<.06,'waterfall top touches the actual cliff face');
  }
  for (const [name, model] of Object.entries(models)) bounds[name] = new THREE.Box3().setFromObject(model.scene,name.startsWith('reference_'));
  for (const course of Object.values(TRACKS)) {
    // Authored scenery is measured from its original origin, independently of the racing grid.
    const track = { ...course, startDistance: 0 };
    const items = beachLayout(course, bounds), counts = {};
    if (track.id === 'mandalika') {
      const landmark = items.find(item => item.name === 'reference_inland_wreck');
      assert.ok(landmark, 'the giant wreck belongs in the marked infield clearing');
      assert.ok(Math.hypot(landmark.x - 780, landmark.z - 80) < 5, 'the wreck occupies the centre of the northeast clearing');
      const size = bounds.reference_inland_wreck.getSize(new THREE.Vector3()).multiplyScalar(landmark.scale);
      assert.ok(size.x > 110 && size.y > 50, 'the wreck dominates the clearing at landmark scale');
      assert.equal(landmark.layer, 'inland');
      assert.ok(!items.some(item => item.name === 'wreck_islet'), 'the mistaken offshore wreck is removed');
      const perimeter = items.filter(item => /coastal_headland|cliff_columns|distant_arch|shore_rock_cluster|cliff_fragment/.test(item.name) &&
        Math.hypot(item.x - landmark.x, item.z - landmark.z) < landmark.radius + 60);
      assert.ok(perimeter.length >= 3, 'rocks frame the outside of the clearing');
      assert.ok(perimeter.every(item => Math.hypot(item.x - landmark.x, item.z - landmark.z) >= landmark.radius + item.radius + 9.9),
        'rocks are pushed beyond the wreck footprint with a clear surrounding gap');
      const approach = sampleTrack(1140, 0, track), vx = approach.x - landmark.x, vz = approach.z - landmark.z, viewLength = Math.hypot(vx, vz);
      assert.ok(perimeter.every(item => {
        const dx = item.x - landmark.x, dz = item.z - landmark.z;
        return dx * vx + dz * vz <= 0 || Math.abs(dx * vz - dz * vx) / viewLength > item.radius + 12;
      }), 'rocks and arches must leave the photographed approach to the giant hull open');
      assert.ok(items.filter(item => item.name === 'coastal_island').every(item => item.scale >= 2.4), 'offshore rock islands double in size');
      assert.ok(!items.some(item => /lighthouse|lifeguard|surf|beach_seats|parasol|thatch_hut|volleyball|icecream/.test(item.name)), 'the rocky coast has no resort facilities');
      assert.ok(items.filter(item => /grass|flower|shrub|canopy/.test(item.name)).length < track.length * .2, 'most undergrowth is removed');
      const palms = items.filter(item => item.authored === 'mandalika-avenue');
      assert.ok(palms.length >= 24, 'straight sectors retain substantial tall palm rows');
      for (const side of [-1, 1]) assert.ok(palms.filter(item => Math.sign(nearestTrack(item.x, item.z, track).offset) === side).length >= 10);
      for (const palm of palms) {
        assert.ok(bounds[palm.name].getSize(new THREE.Vector3()).y * palm.scale >= 9, 'all avenue palms are tall enough for existing night lighting');
        const d = nearestTrack(palm.x, palm.z, track).distance;
        const a = sampleTrack(d - 15, 0, track), b = sampleTrack(d + 15, 0, track);
        assert.ok(Math.abs(Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw))) < .16, 'palm rows follow straight road sections');
      }
      assert.ok(new Set(palms.map(item => Math.round(item.scale * 100))).size >= 5, 'palm heights vary naturally');
      const avenue = createPropInstances(models, palms), matrix = new THREE.Matrix4();
      for (const mesh of avenue.children) for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        for (let j = 0; j < mesh.geometry.attributes.position.count; j++) {
          const p = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, j).applyMatrix4(matrix);
          if (p.y <= 3.5) assert.ok(Math.abs(nearestTrack(p.x, p.z, track).offset) >= track.width / 2 + .3, 'tall palm trunks clear the driving corridor');
        }
      }
    }
    for (const side of [-1, 1]) {
      const post = sampleTrack(0, side * (course.width / 2 + 1.25), course);
      assert.ok(items.every(item => Math.hypot(item.x - post.x, item.z - post.z) >= item.radius + .55 + .1599),
        'scenery must clear the relocated start gate');
    }
    if(track.id==='technical') {
      const avenue=items.filter(p=>p.authored==='technical-avenue');
      assert.ok(avenue.length>=50,'a long avenue keeps palms on both sides of the straight');
      for(const side of [-1,1]) {
        const row=avenue.filter(p=>Math.sign(nearestTrack(p.x,p.z,track).offset)===side);
        assert.ok(row.length>=25,'both verges retain a continuous palm row');
        const distances=row.map(p=>nearestTrack(p.x,p.z,track).distance);
        assert.ok(Math.max(...distances)-Math.min(...distances)>=225,'rows span the full straight');
        distances.sort((a,b)=>a-b);const gaps=distances.slice(1).map((d,i)=>d-distances[i]);
        const offsets=row.map(p=>Math.abs(nearestTrack(p.x,p.z,track).offset));
        assert.ok(Math.max(...gaps)-Math.min(...gaps)>2,'tree spacing varies instead of forming a repeated grid');
        assert.ok(Math.max(...offsets)-Math.min(...offsets)>1.5,'roadside offsets form a loose natural edge');
      }
      const heights=avenue.map(p=>bounds[p.name].getSize(new THREE.Vector3()).y*p.scale);
      assert.ok(Math.max(...heights)-Math.min(...heights)>3,'random palm sizes create distinct heights');
      const pockets=items.filter(p=>p.authored==='technical-coast');
      for(let quarter=0;quarter<4;quarter++) {
        assert.ok(pockets.some(p=>p.name==='reference_boards' && Math.floor(nearestTrack(p.x,p.z,track).distance/track.length*4)===quarter),'three-board clusters reach every quarter');
      }
      assert.ok(pockets.filter(p=>p.name==='planted_headland').length>=2,'existing cliff sites gain planted terraces without duplicate terrain');
      const close=createPropInstances(models,[...avenue,...pockets].filter(p=>p.clearanceHeight));
      for(const mesh of close.children) for(let i=0;i<mesh.count;i++) {
        const matrix=new THREE.Matrix4();mesh.getMatrixAt(i,matrix);const vertices=mesh.geometry.attributes.position;
        for(let j=0;j<vertices.count;j++) {
          const p=new THREE.Vector3().fromBufferAttribute(vertices,j).applyMatrix4(matrix);
          if(p.y<=3.5) assert.ok(Math.abs(nearestTrack(p.x,p.z,track).offset)>=track.width/2+.3,'new trunks, furniture and low foliage clear the road');
        }
      }
    }
    const finishWrecks=items.filter(item=>item.name==='finish_wreck');
    assert.equal(finishWrecks.length,track.id==='beginner'?1:0,'only beginner has the submerged last-corner wreck');
    if(finishWrecks.length) {
      const wreck=finishWrecks[0],road=nearestTrack(wreck.x,wreck.z,track),b=bounds.finish_wreck;
      assert.ok(track.length-road.distance>=20 && track.length-road.distance<=75,'wreck marks the final approach before the line');
      assert.ok(road.offset+wreck.radius<=-32,'the full wreck sits offshore');
      assert.ok(wreck.y+b.max.y*wreck.scale>0,'wreck silhouette remains above the sea');
      const mesh=createPropInstances(models,[wreck]).children[0],matrix=new THREE.Matrix4(),vertices=[];mesh.getMatrixAt(0,matrix);
      const positions=mesh.geometry.attributes.position;
      for(let j=0;j<positions.count;j++) vertices.push(new THREE.Vector3().fromBufferAttribute(positions,j).applyMatrix4(matrix));
      const dry=vertices.filter(p=>p.y>=-1.4);
      assert.ok(dry.length/vertices.length>.7,'most wreck geometry stays above the water surface');
      const lowest=Math.min(...vertices.map(p=>p.y));
      assert.ok(lowest<-1.45 && lowest>-2.9,'only the tilted underside dips a little below the sea');
      for(const remaining of [120,100,80]) {
        const p=sampleTrack(track.length-remaining,0,track),camera=new THREE.PerspectiveCamera(55,16/9,.1,950);
        camera.position.set(p.x-Math.sin(p.yaw)*8.8,4.2,p.z+Math.cos(p.yaw)*8.8);
        camera.lookAt(p.x+Math.sin(p.yaw)*8,1,p.z-Math.cos(p.yaw)*8);camera.updateMatrixWorld(true);
        const visible=dry.map(v=>v.clone().project(camera)).filter(v=>Math.abs(v.x)<1&&Math.abs(v.y)<1&&v.z<1);
        assert.ok(visible.length>=30,`wreck emerges in the normal driving view ${remaining}m before the line`);
      }
    }
    const dryWrecks=items.filter(item=>item.name==='reference_inland_wreck');
    assert.equal(dryWrecks.length,track.id==='beginner'?0:1,'advanced circuits retain their dry-land wreck landmark');
    assert.equal(items.filter(item=>models[item.name].scene.getObjectByName('Wreck_PC')).length,
      track.id==='technical'?2:1,'each circuit retains its intended wreck landmarks');
    if(dryWrecks.length && track.id==='technical') {
      const wreck=dryWrecks[0],box=bounds.reference_inland_wreck,size=box.getSize(new THREE.Vector3()).multiplyScalar(wreck.scale);
      assert.equal(wreck.scale,3,'the standalone wreck is three times the original asset size');
      assert.equal(wreck.layer,'inland');
      assert.ok(nearestTrack(wreck.x,wreck.z,track).offset-wreck.radius>45,'the whole wreck occupies the open inland field clear of the road');
      assert.equal(wreck.buriedDepth,2.5,'only the unfinished bottom is buried');
      assert.ok(Math.abs(wreck.y+box.min.y*3+.08+wreck.buriedDepth)<.001,'the hull is shallowly embedded in sand');
      assert.ok(size.x>65&&size.y>30,'the hull and mast have landmark scale');
      const mesh=createPropInstances(models,[wreck]).children[0],matrix=new THREE.Matrix4();mesh.getMatrixAt(0,matrix);
      let bottom=Infinity;
      const view=sampleTrack(track.length*.75,0,track),camera=new THREE.PerspectiveCamera(55,1.5,.1,950);
      camera.position.set(view.x-Math.sin(view.yaw)*8.8,4.2,view.z+Math.cos(view.yaw)*8.8);
      camera.lookAt(view.x+Math.sin(view.yaw)*8,1,view.z-Math.cos(view.yaw)*8);camera.updateMatrixWorld(true);
      let visible=0;
      for(let i=0;i<mesh.geometry.attributes.position.count;i++) bottom=Math.min(bottom,new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position,i).applyMatrix4(matrix).y);
      for(let i=0;i<mesh.geometry.attributes.position.count;i++) {const p=new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position,i).applyMatrix4(matrix).project(camera);if(Math.abs(p.x)<1&&Math.abs(p.y)<1&&p.z>0&&p.z<1)visible++;}
      assert.ok(Math.abs(bottom+.08+wreck.buriedDepth)<.001,'actual hull vertices extend only the intended depth below sand');
      let buried=0;for(let i=0;i<mesh.geometry.attributes.position.count;i++)if(new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position,i).applyMatrix4(matrix).y<-.08)buried++;
      assert.ok(buried/mesh.geometry.attributes.position.count>.1&&buried/mesh.geometry.attributes.position.count<.22,'the majority of the hull and mast remain exposed');
      assert.ok(visible>100,'the additional wreck appears from the unchanged 10/12 forward driving camera');
    }
    const inland = items.filter(item => item.name === 'landmark_assembly');
    assert.equal(inland.length, track.id === 'technical' ? 1 : 0, 'the complete inland landmark belongs only to the technical map');
    if (inland.length) {
      const item=inland[0], top=item.y+bounds.landmark_assembly.max.y*item.scale;
      assert.ok(top>=65 && top<=80,'the central lighthouse rises above surrounding palms and cliffs');
      assert.ok(item.x>=-50 && item.x<=50 && item.z>=-310 && item.z<=-220,'landmark occupies the circuit centre');
      for(let d=0;d<track.length;d+=10) {
        const p=sampleTrack(d,0,track), distance=Math.hypot(p.x-item.x,p.z-item.z);
        assert.ok(distance+item.radius<850,'every course position lies within the landmark visibility range');
        assert.ok(Math.atan2(top-4.2,distance)>6*Math.PI/180,'the top clears the horizon by at least six degrees around the course');
      }
      const surrounding=createPropInstances(models,items.filter(p=>p!==item));surrounding.updateMatrixWorld(true);
      const target=new THREE.Vector3(item.x+4*item.scale,top,item.z-4*item.scale),sightline=new THREE.Raycaster();
      for(let index=0;index<48;index++) {
        const p=sampleTrack(index/48*track.length,0,track),yaw=Math.atan2(target.x-p.x,-(target.z-p.z));
        const origin=new THREE.Vector3(p.x-Math.sin(yaw)*8.8,4.2,p.z+Math.cos(yaw)*8.8),direction=target.clone().sub(origin);
        sightline.set(origin,direction.clone().normalize());sightline.far=direction.length()-.1;
        assert.equal(sightline.intersectObject(surrounding,true).length,0,`surrounding scenery clears the central lighthouse top from chase-camera sample ${index}/48`);
      }
    }
    if (track.id === 'beginner') {
      const pocket = items.filter(item => item.authored === 'coastline-reference');
      assert.ok(pocket.length >= 100, 'reference pocket keeps dense foliage and facilities before generic fillers');
      assert.equal(pocket.filter(item => item.name.startsWith('reference_palm_')).length, 3, 'three large framing palms');
      assert.ok(pocket.some(item=>item.name==='reference_boards'), 'the three-board cluster survives placement');
      assert.equal(models.reference_boards.scene.children.length,3,'three separated surfboards');
      assert.ok(pocket.some(item => item.name === 'reference_headland'), 'tiered island anchors the right background');
      assert.ok(pocket.filter(item => item.name === 'rope_fence_4m').length >= 6, 'continuous foreground rope fence');
      assert.equal(pocket.filter(item=>item.name.startsWith('reference_sign_')).length,3,'all three reference racing signs survive placement');
      const sector7=items.filter(item=>item.authored==='coastline-sector7');
      for(const side of [-1,1]) {
        const verge=sector7.filter(item=>Math.sign(nearestTrack(item.x,item.z,track).offset)===side);
        assert.equal(verge.filter(item=>item.name.startsWith('reference_palm_')).length,3,'7/12 frames both road edges with three differently leaning palms');
        for(const name of ['reference_boards','reference_headland','flower_rock_patch'])
          assert.ok(verge.some(item=>item.name===name),`7/12 ${side}: ${name} survives reservation`);
        assert.ok(verge.filter(item=>item.name==='rope_fence_4m').length>=7,'both sides retain a substantial rope fence run');
        assert.ok(verge.filter(item=>item.name==='dune_grass_patch').length>=45,'both sides have a dense low green layer');
        assert.ok(verge.some(item=>item.name.startsWith('reference_sign_')),'both sides have readable racing signs');
        const palms=verge.filter(item=>item.name.startsWith('reference_palm_'));
        assert.ok(Math.max(...palms.map(p=>p.scale))-Math.min(...palms.map(p=>p.scale))>.4,'framing palm sizes vary');
      }
      assert.ok(sector7.every(item=>Math.abs(nearestTrack(item.x,item.z,track).distance-track.length/2)<75),'new dressing stays around beginner 7/12');
      const lowProps=createPropInstances(models,[...pocket,...sector7].filter(item=>item.clearanceHeight));
      for(const mesh of lowProps.children) for(let i=0;i<mesh.count;i++) {
        const matrix=new THREE.Matrix4();mesh.getMatrixAt(i,matrix);
        const positions=mesh.geometry.attributes.position;
        for(let j=0;j<positions.count;j++) {
          const p=new THREE.Vector3().fromBufferAttribute(positions,j).applyMatrix4(matrix);
          if(p.y<=3.5) assert.ok(Math.abs(nearestTrack(p.x,p.z,track).offset)>=track.width/2+.3,
            'leaning trunks and the full narrow fence geometry stay beyond the asphalt');
        }
      }
    }
    if (['beginner', 'technical'].includes(track.id)) {
      const arch = items.find(item => item.name === 'distant_arch' && item.layer === 'mid');
      assert.ok(arch, `${track.id}: a tropical arch landmark beside the first coastal corner`);
      const archRoad = nearestTrack(arch.x, arch.z, track);
      assert.ok(archRoad.offset > 0 && archRoad.distance < 160, 'landmark occupies the inland side of the first corner');
      const archHeight = bounds.distant_arch.max.y * arch.scale;
      assert.ok(archHeight >= 15 && archHeight < 17, 'hero arch has the requested 15m landscape scale');
      const flankingPalms = items.filter(item => item.name.startsWith('palm_') && Math.hypot(item.x - arch.x, item.z - arch.z) < 40);
      assert.ok(flankingPalms.length >= 2 && flankingPalms.some(item => {
        const palmHeight = bounds[item.name].max.y * item.scale;
        return archHeight / palmHeight >= 1.1 && archHeight / palmHeight <= 1.8;
      }), 'arch and surrounding palms retain a comparable, full-size landscape scale');
      assert.ok(items.some(item => ['planted_headland','landmark_assembly'].includes(item.name) && item.layer === 'inland'), `${track.id}: raised planted terrain fills the circuit interior`);
      // Start-sector facilities take priority over generic fillers; gate occlusion does not reduce density.
      for (const [name, side] of [['wooden_dock', -1], ['lifeguard_tower', -1], ['surfboard', -1],
        ['thatch_hut', 1], ['beach_seats', 1], ['palm_single', 1], ['timber_fence_4m', 1]]) {
        assert.ok(items.some(item => {
          const p = nearestTrack(item.x, item.z, track);
          return item.name === name && p.distance < 70 && Math.sign(p.offset) === side;
        }), `${track.id}: ${name} frames the ${side < 0 ? 'left' : 'right'} of the start camera`);
      }
      const startItems = items.filter(item => nearestTrack(item.x, item.z, track).distance < 90);
      assert.ok(startItems.some(item => item.name.startsWith('corner_')), `${track.id}: a racing sign survives the start placement checks`);
      t.diagnostic(`${track.id} start: ${startItems.filter(item => ['dune_grass_patch', 'flower_rock_patch'].includes(item.name)).length} vegetation patches`);
      assert.ok(startItems.filter(item => item.name.startsWith('palm_') && nearestTrack(item.x, item.z, track).offset > 0).length >= 5,
        `${track.id}: a right-side palm grove, rather than isolated trees`);
      assert.ok(startItems.filter(item => ['beach_seats', 'parasol'].includes(item.name)).length >= 4,
        `${track.id}: multiple beach seating pockets at the start`);
      assert.ok(startItems.filter(item => ['dune_grass_patch', 'flower_rock_patch'].includes(item.name)).length >= 70,
        `${track.id}: dense low beach vegetation along the start`);
      }
    assert.deepEqual(beachLayout(course, bounds), items, 'stable placement for every player');
    for (const item of items) {
      counts[item.layer] = (counts[item.layer] || 0) + 1;
      const distance = Math.abs(nearestTrack(item.x, item.z, track).offset);
      assert.ok(distance - item.radius >= track.width / 2 + 1.3 - 1e-6, `${item.name}: road footprint`);
      if (['near', 'mid', 'inland'].includes(item.layer)) {
        const foundation = ['thatch_hut', 'surf_shop', 'landmark_assembly'].includes(item.name) ? 0 : bounds[item.name].min.y * item.scale;
        const clearance=item.name==='rope_fence_4m' && item.authored==='coastline-sector7' ? .0061 : .001;
        assert.ok(Math.abs(item.y + foundation + .08 + (item.buriedDepth||0)) < clearance, `${item.name}: sand contact`);
      } else if (item.layer === 'far') assert.equal(item.y, -1.4, `${item.name}: waterline`);
      else if (item.layer === 'pier') assert.ok(Math.abs(item.y + .72 + .06) < .001, 'pier deck meets shore above the sand plane');
      else if (item.layer === 'terrain') {
        assert.equal(item.y, -1.4, 'shore foot meets water');
        assert.ok(Math.abs(item.y + bounds[item.name].max.y * item.scale + .08) < .001, 'shore ramp reaches sand');
      }
    }
    for (let i = 0; i < items.length; i++) for (const b of items.slice(i + 1)) {
      const a = items[i];
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= a.radius + b.radius + .1599, `${a.name}/${b.name}: overlap`);
    }
    assert.ok(counts.near > track.length * (track.id === 'mandalika' ? .04 : .5), `${track.id}: roadside detail: ${counts.near}`);
    assert.ok(counts.mid > (track.id === 'mandalika' ? 30 : track.length * .16), `${track.id}: landscape density: ${counts.mid}`);
    assert.ok(counts.far >= 8, `${track.id}: coastal silhouettes and boats: ${counts.far}`);
    assert.ok(counts.shore > track.length * .08, `${track.id}: shoreline: ${counts.shore}`);
    if (track.id === 'technical') for (let quarter = 0; quarter < 4; quarter++) {
      const landmarks = items.filter(item => ['lighthouse_islet', 'distant_arch', 'sea_stacks'].includes(item.name) &&
        Math.floor(nearestTrack(item.x, item.z, track).distance / track.length * 4) === quarter);
      assert.ok(landmarks.length >= 2, `landmarks must reach quarter ${quarter + 1}, not just the old 719 m`);
    }
    if (track.id === 'beginner') {
      const islands = items.filter(item => item.name === 'coastal_island');
      assert.ok(islands.length >= 3, 'broad distant islands surround the coastline');
      assert.ok(islands.every(item => bounds[item.name].getSize(new THREE.Vector3()).y * item.scale >= 20),
        'background terrain has a visible silhouette, not small isolated props');
      for (const d of [60, 120, 300, 420, 540, 660]) {
        const p = sampleTrack(d, 0, track), camera = new THREE.PerspectiveCamera(55, 16 / 9, .1, 950);
        camera.position.set(p.x - Math.sin(p.yaw) * 8.8, 4.2, p.z + Math.cos(p.yaw) * 8.8);
        camera.lookAt(p.x + Math.sin(p.yaw) * 8, 1, p.z - Math.cos(p.yaw) * 8); camera.updateMatrixWorld(true);
        const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        assert.ok(islands.some(item => {
          const matrix = new THREE.Matrix4().makeRotationY(item.rotation).scale(new THREE.Vector3().setScalar(item.scale));
          matrix.setPosition(item.x, item.y, item.z);
          return frustum.intersectsBox(bounds[item.name].clone().applyMatrix4(matrix));
        }), `distant island silhouette reaches the driving camera at ${d}m`);
      }
      assert.ok(items.filter(item => item.name.startsWith('palm_') && bounds[item.name].max.y * item.scale >= 7).length >= 8,
        'large palms frame the driving camera');
      assert.ok(items.filter(item => item.layer === 'near' && ['wooden_crate', 'wooden_barrel', 'red_flag_pole_3m'].includes(item.name)).length >= 15,
        'track-side props provide passing speed cues');
      for (const [name, count] of [['lighthouse_islet', 1], ['wooden_dock', 3], ['thatch_hut', 1], ['surf_shop', 1], ['sailboat', 1]]) {
        assert.equal(items.filter(item => item.name === name).length, count, name);
      }
      assert.ok(items.filter(item => item.name === 'shrub_strip').length >= 15, 'new low shrub layer');
      assert.ok(items.filter(item => item.name === 'distant_arch').length >= 2, 'new tropical silhouettes');
      for (const name of ['wooden_barrel', 'wooden_crate', 'beach_bunting', 'red_flag_pole_3m']) {
        assert.ok(items.some(item => item.name === name), `dedicated prop visible: ${name}`);
      }
    }
    const scenery = createBeachScenery(models, course);
    if(track.id==='technical') assert.ok(scenery.children.filter(m=>m.name==='beach/planted_headland').every(m=>!m.castShadow),'distant planted terrain adds no shadow pass');
    assert.ok(scenery.children.length < 180, 'shared instance batches bound draw calls');
    assert.ok(scenery.children.every(mesh => mesh.name==='lighthouse-beacon' || mesh.isInstancedMesh && !mesh.boundingSphere.isEmpty()));
    assert.equal(scenery.children.filter(mesh=>mesh.name==='lighthouse-beacon').length,track.id==='technical'?1:0);
    for (const mesh of scenery.children.filter(mesh => mesh.name.startsWith('beach/corner_'))) {
      const { index, attributes: { position, normal } } = mesh.geometry;
      for (let i = 0; i < index.count; i += 3) {
        const [a, b, c] = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(position, index.getX(i + k)));
        const face = b.sub(a).cross(c.sub(a)).normalize();
        assert.ok(face.dot(new THREE.Vector3().fromBufferAttribute(normal, index.getX(i))) > .99,
          'left and right sign faces retain outward lighting normals');
      }
    }
    t.diagnostic(`${track.id}: ${items.length} placements, ${scenery.children.length} instance batches; ${JSON.stringify(counts)}`);
    const trackProps = trackPropsLayout(track), roadProps = createPropInstances(models, trackProps);
    for (const group of [scenery, roadProps]) group.traverse(mesh => {
      if (mesh.isMesh && mesh.count !== 0 && geometrySources.has(mesh.geometry)) usedSources.add(geometrySources.get(mesh.geometry));
    });
    if(track.id==='beginner') assert.ok(!trackProps.some(item=>{
      const p=nearestTrack(item.x,item.z,track);
      return item.name==='barrier_bluewhite_2m' && p.distance>160 && p.distance<225 && p.offset<0;
    }), 'the reference beach edge uses the authored rope fence');
    const barriers = trackProps.filter(item => item.name === 'barrier_bluewhite_2m').map(item =>
      ({ x: item.x - Math.sin(item.rotation), z: item.z - Math.cos(item.rotation) }));
    for (let i = 0; i < barriers.length; i++) for (const b of barriers.slice(i + 1)) {
      const a = barriers[i];
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 2.119, 'rigid barrier footprints never overlap on inside bends');
    }
    assert.equal(trackProps.filter(item => item.name === 'boost_chevrons_visual_3m').length, 6);
    for (const mesh of roadProps.children) for (let i = 0; i < mesh.count; i++) {
      const matrix = new THREE.Matrix4(); mesh.getMatrixAt(i, matrix);
      const vertices = mesh.geometry.attributes.position;
      for (let j = 0; j < vertices.count; j++) {
        const p = new THREE.Vector3().fromBufferAttribute(vertices, j).applyMatrix4(matrix);
        const road = nearestTrack(p.x, p.z, track);
        if (mesh.name.endsWith('barrier_bluewhite_2m')) {
          assert.ok(Math.abs(road.offset) >= track.width / 2 + .05, 'whole barrier stays beyond asphalt');
          assert.ok(Math.abs(road.offset) < track.width / 2 + 1.3, 'barrier stays inside scenery clearance');
          assert.ok(p.y >= -.0801 && p.y <= .621, 'barrier anchored to sand');
        } else {
          assert.ok(p.y >= .0149, 'surface marks clear asphalt');
          if (mesh.name.endsWith('boost_chevrons_visual_3m')) {
            assert.ok(Math.abs(road.offset) <= BOOST_PAD.width / 2 + .08, 'boost art stays inside functional width');
            assert.ok(road.distance >= BOOST_PAD.distance - .08 && road.distance <= BOOST_PAD.distance + BOOST_PAD.length + .08,
              'boost art matches functional interval');
          }
        }
      }
    }
  }
  assert.deepEqual(Object.keys(sources).filter(name => !usedSources.has(name)), [], 'every loaded scenery asset contributes geometry to a current circuit');
});

test('center dashes follow the actual road center through every bend on both circuits', () => {
  for (const track of Object.values(TRACKS)) {
    const mesh = createCenterGuides(track, new THREE.MeshBasicMaterial());
    const p = mesh.geometry.attributes.position;
    for (let i = 0; i < p.count; i += 2) {
      const center = new THREE.Vector3().fromBufferAttribute(p, i).add(new THREE.Vector3().fromBufferAttribute(p, i + 1)).multiplyScalar(.5);
      const road = nearestTrack(center.x, center.z, track);
      assert.ok(Math.abs(road.offset) < .001, `${track.id}: line stays in the middle of the asphalt`);
      assert.ok(Math.abs(center.y - .032) < 1e-6, 'no coplanar road faces');
      if (i % 14 === 12) continue;
      const next = new THREE.Vector3().fromBufferAttribute(p, i + 2).add(new THREE.Vector3().fromBufferAttribute(p, i + 3)).multiplyScalar(.5);
      const direction = next.sub(center).normalize(), tangent = nearestTrack(center.x + direction.x * .25, center.z + direction.z * .25, track);
      assert.ok(direction.dot(new THREE.Vector3(Math.sin(tangent.yaw), 0, -Math.cos(tangent.yaw))) > .99,
        `${track.id}: dash points along the road, not across it`);
    }
  }
});

test('six centered cloud modules follow the camera and switch a single LOD by projected size', async () => {
  const models = {}, loader = new GLTFLoader();
  for (const id of CLOUD_MODELS) for (const lod of ['pc', 'mobile']) {
    const name = `${id}_${lod}`, bytes = await readFile(new URL(`../public/assets/clouds/${name}.glb`, import.meta.url));
    models[name] = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  }
  const clouds = createClouds(models), camera = new THREE.PerspectiveCamera(55, 1, .1, 650);
  assert.equal(clouds.children.length, 6);
  const materials = new Set();
  clouds.traverse(mesh => { if (mesh.isMesh) {
    materials.add(mesh.material); assert.equal(mesh.castShadow, false); assert.equal(mesh.receiveShadow, false);
    assert.ok(mesh.material.isMeshStandardMaterial && mesh.material.emissive.getHex() === 0);
  } });
  assert.equal(materials.size, 1, 'share the authored PBR material across all modules and LODs');
  for (const [height, expected] of [[100, 1], [4000, 0]]) {
    camera.position.set(1500, 4.2, -800); updateClouds(clouds, camera, height, 60);
    for (const cloud of clouds.children) {
      const bounds = new THREE.Box3().setFromObject(cloud);
      assert.ok(bounds.min.y > camera.position.y + 65, 'clouds remain well above the driving camera');
      const center = cloud.getWorldPosition(new THREE.Vector3()).sub(camera.position);
      assert.ok(center.length() >= 500 && center.length() < 700, 'clouds form a distant background inside the camera far plane');
      const elevation = Math.asin(center.y / center.length()) * 180 / Math.PI;
      assert.ok(elevation >= 8 && elevation <= 19, 'clouds stay in the upper horizon rather than disappearing overhead');
      assert.equal(cloud.getCurrentLevel(), expected);
      assert.equal(cloud.levels.filter(level => level.object.visible).length, 1);
    }
  }
});
