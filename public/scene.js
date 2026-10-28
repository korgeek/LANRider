import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGroups } from 'three/addons/utils/BufferGeometryUtils.js';
import { TRACK as DEFAULT_TRACK, TRACKS, BOOST_PAD, collisionBox, sampleTrack as sample, nearestTrack as nearest } from '/shared/game.js';
import { VEHICLE_MODELS, VEHICLE_LIGHT_MODELS, COAST_MODELS, createVehicleModel, createVehiclePortrait, removeCoplanarOverlaps } from './models.js';
import { createDriverInertia } from './driver-motion.js';
import { BEACH_MODELS, TROPICAL_MODELS, INLAND_MODELS, CLOUD_MODELS, TRACK_PROP_MODELS, prepareBeachModels, createBeachScenery,
  createPropInstances, trackPropsLayout, createCenterGuides, createClouds, updateClouds, setSceneryQuality } from './beach.js';
import { t } from './i18n.js';
import { createSky } from './sky.js';
import { browserEnvironment } from './environment.js';
import { sunsetStrength, createVehicleLights, createHeadlights } from './night-lights.js';

export const COLORS = ['#68f6d7', '#ffb86b', '#a9a0ff', '#ff86a7'];
export const graphicsQualityForFrameMs = frameMs => frameMs <= 12 ? 'high' : frameMs <= 22 ? 'medium' : 'low';
export function graphicsSettings(quality, width, height, pixelRatio = 1) {
  const profile = quality === 'low' ? [.75, 1280 * 720, 0] : quality === 'medium' ? [1.25, 1920 * 1080, 1024] : [1.75, Infinity, 2048];
  return { pixelRatio: Math.min(Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1,
    profile[0], Math.sqrt(profile[1] / Math.max(1, width * height))), shadowSize: profile[2] };
}
const angle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

export async function createScene(canvas, status) {
  let TRACK = DEFAULT_TRACK;
  let graphicsQuality = 'high';
  let vehicleQuality = 'high';
  let benchmark = null, graphicsInfo = null;
  const sampleTrack = (distance, lateral = 0) => sample(distance, lateral, TRACK);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, .1, 950);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = new RoomEnvironment();
  scene.environment = pmrem.fromScene(environment, .04).texture;
  scene.environmentIntensity = .32;
  environment.dispose(); pmrem.dispose();
  const loader = new GLTFLoader();
  status(t('차량 8종 NORMAL/LIGHT, 현재 드라이버, 바닷가 풍경을 불러옵니다.'));
  const [bodyEntries, driver, coastEntries, asphalt, beachEntries, tropicalEntries, cloudEntries, trackPropEntries, catalogue, inlandEntries] = await Promise.all([
    Promise.all(Object.entries(VEHICLE_MODELS).map(async ([id, url]) => {
      const [normal,light] = await Promise.all([loader.loadAsync(url),loader.loadAsync(VEHICLE_LIGHT_MODELS[id])]);
      return [id,{normal,light}];
    })),
    loader.loadAsync('/assets/drivers/vnext/driver_lod0.glb'),
    Promise.all(COAST_MODELS.map(async name => [name, await loader.loadAsync(`/assets/coast/${name}.glb`)])),
    new THREE.TextureLoader().loadAsync('/assets/asphalt.png'),
    Promise.all(BEACH_MODELS.map(async name => [name, await loader.loadAsync(`/assets/beach/${name}.glb`)])),
    Promise.all(TROPICAL_MODELS.map(async name => [name, await loader.loadAsync(`/assets/tropical/${name}.glb`)])),
    Promise.all(CLOUD_MODELS.flatMap(id => ['pc', 'mobile'].map(async lod => {
      const name = `${id}_${lod}`; return [name, await loader.loadAsync(`/assets/clouds/${name}.glb`)];
    }))),
    Promise.all(TRACK_PROP_MODELS.map(async name => [name, await loader.loadAsync(`/assets/track-props/${name}.glb`)])),
    fetch('/assets/sky-stars.json').then(response => { if (!response.ok) throw new Error('Star catalogue unavailable'); return response.json(); }),
    Promise.all(INLAND_MODELS.map(async name => [name, await loader.loadAsync(`/assets/inland/${name}.glb`)])),
  ]);
  const bodies = Object.fromEntries(bodyEntries), coast = Object.fromEntries(coastEntries);
  const sceneryModels = prepareBeachModels({ ...coast, ...Object.fromEntries(beachEntries),
    ...Object.fromEntries(tropicalEntries), ...Object.fromEntries(trackPropEntries), ...Object.fromEntries(inlandEntries) });
  const clouds = createClouds(Object.fromEntries(cloudEntries), 30); scene.add(clouds);
  const sky = createSky(scene, renderer, clouds, catalogue);
  let currentEnvironment = browserEnvironment(), environmentAt = performance.now();
  sky.setEnvironment(currentEnvironment);
  // Recolor only the reserved atlas swatch; cream and shared source materials stay intact.
  const driverMaterials = COLORS.map(color => {
    const materials = new Map();
    driver.scene.traverse(child => {
      if (!child.isMesh || materials.has(child.material)) return;
      const material = child.material.clone(), texture = material.map.clone();
      const image = texture.image, palette = document.createElement('canvas');
      palette.width = image.width; palette.height = image.height;
      const ctx = palette.getContext('2d'); ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, palette.width, palette.height);
      const rgb = color.slice(1).match(/../g).map(hex => parseInt(hex, 16));
      for (let i = 0; i < pixels.data.length; i += 4) {
        if (pixels.data[i] === 230 && pixels.data[i + 1] === 240 && pixels.data[i + 2] === 230) pixels.data.set(rgb, i);
      }
      ctx.putImageData(pixels, 0, 0); texture.source = new THREE.Source(palette); texture.needsUpdate = true;
      material.map = texture; materials.set(child.material, material);
    });
    return materials;
  });
  asphalt.colorSpace = THREE.SRGBColorSpace;
  asphalt.wrapS = asphalt.wrapT = THREE.RepeatWrapping;
  asphalt.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const roadMaterial = new THREE.MeshStandardMaterial({ map: asphalt, roughness: .95, color: '#c0c8c8' });
  const white = new THREE.MeshStandardMaterial({ color: '#f5f5e9', roughness: .8 });
  const mint = new THREE.MeshStandardMaterial({ color: '#28aa9f', roughness: .7 });
  const red = new THREE.MeshStandardMaterial({ color: '#e84f4f', roughness: .9 });
  const dark = new THREE.MeshStandardMaterial({ color: '#173a49', roughness: .7 });
  const waterCanvas = document.createElement('canvas'); waterCanvas.width = waterCanvas.height = 128;
  const waterContext = waterCanvas.getContext('2d'); waterContext.fillStyle = '#ffffff'; waterContext.fillRect(0, 0, 128, 128);
  waterContext.strokeStyle = '#e3f5fa'; waterContext.lineWidth = 2;
  for (let i = 0; i < 9; i++) {
    waterContext.beginPath(); waterContext.moveTo(i * 19 % 128, i * 17); waterContext.lineTo(i * 19 % 128 + 17, i * 17); waterContext.stroke();
  }
  const waterTexture = new THREE.CanvasTexture(waterCanvas); waterTexture.colorSpace = THREE.SRGBColorSpace;
  waterTexture.wrapS = waterTexture.wrapT = THREE.RepeatWrapping; waterTexture.repeat.set(100, 100);
  function textTexture(text, color = '#b8ffeb', background = '#0a2b40', width = 512, height = 128) {
    const c = document.createElement('canvas'); c.width = width; c.height = height;
    const ctx = c.getContext('2d'); ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = color; ctx.font = `800 ${Math.round(height * .44)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, width / 2, height / 2, width - 22);
    const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace; return texture;
  }
  const shopSign = new THREE.Mesh(new THREE.PlaneGeometry(2.7, .55), new THREE.MeshBasicMaterial({
    map: textTexture('SURF CLUB', '#fff4d8', '#16454c'), side: THREE.DoubleSide }));
  shopSign.position.set(0, 2.9, 2.46); sceneryModels.surf_shop.scene.add(shopSign);
  function buildCourse() {
    const scene = new THREE.Group();
    // Match the shared sampled centerline and its right-hand lateral coordinate exactly.
    function ribbon(left, right, y, materials, striped = false, start = 0, end = TRACK.length) {
      const vertices = [], uv = [], indices = [];
      const span = end - start, segments = Math.max(span === TRACK.length ? 576 : 8, Math.ceil(span / 2)), geometry = new THREE.BufferGeometry();
      for (let i = 0; i <= segments; i++) {
        const distance = start + i / segments * span;
        for (const offset of [left, right]) {
          const p = sampleTrack(distance, offset);
          vertices.push(p.x, y, p.z); uv.push(offset / 5, distance / 5);
        }
        if (i < segments) {
          const a = i * 2;
          indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          if (striped) geometry.addGroup(i * 6, 6, Math.floor(distance / 4) % 2);
        }
      }
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geometry.setIndex(indices); geometry.computeVertexNormals();
      if (striped) mergeGroups(geometry);
      const trimmed = removeCoplanarOverlaps(geometry); geometry.dispose();
      const mesh = new THREE.Mesh(trimmed, materials); mesh.receiveShadow = true; scene.add(mesh);
    }
    const halfWidth = TRACK.width / 2;
    ribbon(-halfWidth, halfWidth, 0, roadMaterial);
    for (const side of [-1, 1]) {
      const offsets = side < 0 ? [-halfWidth, -halfWidth + .65] : [halfWidth - .65, halfWidth];
      ribbon(...offsets, .015, [white, red], true);
      ribbon(side * (halfWidth - .8) - .055, side * (halfWidth - .8) + .055, .025, white);
    }
    const blue = new THREE.MeshBasicMaterial({ color: '#147997' }), amber = new THREE.MeshBasicMaterial({ color: '#f6cf60' });
    ribbon(-BOOST_PAD.width / 2, BOOST_PAD.width / 2, .012, blue, false, BOOST_PAD.distance, BOOST_PAD.distance + BOOST_PAD.length);
    scene.add(createCenterGuides(TRACK, white));
    const marker = new THREE.Object3D();
    for (let d = 0; d < TRACK.length; d += 38) {
      const p = sampleTrack(d), ahead = sampleTrack(d + 20);
      const turn = Math.atan2(Math.sin(ahead.yaw - p.yaw), Math.cos(ahead.yaw - p.yaw));
      if (Math.abs(turn) < .24) continue;
      const offset = Math.sign(turn) * (halfWidth - 1.7);
      ribbon(offset - .075, offset + .075, .04, amber, false, d, d + 12);
    }
    const island = new THREE.Shape();
    for (let i = 0; i <= 300; i++) {
      const p = sampleTrack(i / 300 * TRACK.length, -27);
      if (!i) island.moveTo(p.x, -p.z); else island.lineTo(p.x, -p.z);
    }
    const sand = new THREE.Mesh(new THREE.ShapeGeometry(island), new THREE.MeshStandardMaterial({ color: '#eacb8c', roughness: 1 }));
    sand.rotation.x = -Math.PI / 2; sand.position.y = -.08; sand.receiveShadow = true; scene.add(sand);
    // One water surface: depth colors on its vertices cannot intersect the foam with a second plane.
    const seaGeometry = new THREE.PlaneGeometry(3500, 3500, 128, 128), waterColors = [];
    const seaPositions = seaGeometry.attributes.position, shallow = new THREE.Color('#58d5d5'), deep = new THREE.Color('#188abb');
    for (let i = 0; i < seaPositions.count; i++) {
      const distance = Math.abs(nearest(seaPositions.getX(i), -seaPositions.getY(i), TRACK).offset);
      const color = shallow.clone().lerp(deep, THREE.MathUtils.clamp((distance - 25) / 95, 0, 1));
      waterColors.push(color.r, color.g, color.b);
    }
    seaGeometry.setAttribute('color', new THREE.Float32BufferAttribute(waterColors, 3));
    const sea = new THREE.Mesh(seaGeometry, new THREE.MeshStandardMaterial({ vertexColors: true, map: waterTexture, metalness: .12, roughness: .42 }));
    sea.rotation.x = -Math.PI / 2; sea.position.y = -1.4; scene.add(sea);
    const guardMaterial = white.clone(); guardMaterial.color.set('#ffffff');
    const guards = new THREE.InstancedMesh(new THREE.BoxGeometry(.22, .42, 4.65), guardMaterial, Math.ceil(TRACK.length / 5) * 2);
    let guardIndex = 0; guards.receiveShadow = true;
    const guardPositions = [];
    for (let distance = 0; distance < TRACK.length; distance += 5) for (const side of [-1, 1]) {
      if(TRACK.id==='beginner' && side<0 && distance+TRACK.startDistance>=155 && distance+TRACK.startDistance<=230) continue;
      if (Math.floor(distance / 110) % 3 === 1) continue;
      const p = sampleTrack(distance, side * (halfWidth + .11));
      guardPositions.push({ ...p, distance });
    }
    for (const p of guardPositions) {
      let length = 4.65;
      for (const other of guardPositions) if (other !== p) length = Math.min(length, Math.hypot(p.x - other.x, p.z - other.z) - .24);
      // A circle around the shortened .22m-wide box clears every neighboring box.
      marker.position.set(p.x, .13, p.z); marker.rotation.set(0, -p.yaw, 0); marker.scale.set(1, 1, Math.max(.05, length) / 4.65);
      marker.updateMatrix(); guards.setMatrixAt(guardIndex, marker.matrix);
      guards.setColorAt(guardIndex++, (Math.floor(p.distance / 20) % 2 ? white : mint).color);
    }
    marker.scale.set(1, 1, 1);
    guards.count = guardIndex;
    guards.computeBoundingSphere(); scene.add(guards);
    scene.add(createPropInstances(sceneryModels, trackPropsLayout(TRACK)));
    const start = sampleTrack(0);
    const gate = new THREE.Group(); gate.position.set(start.x, -.08, start.z); gate.rotation.y = -start.yaw;
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(.5, 5.6, .6), dark); post.position.set(side * (halfWidth + 1.25), 2.8, 0); gate.add(post);
    }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(TRACK.width + 3, 2, .45), dark); banner.position.y = 5.7; gate.add(banner);
    for (const [i, text] of ['IT WORKS ON MY MACHINE', 'CACHE ME IF YOU CAN', 'MERGE AFTER FINISH'].entries()) {
      const product = new THREE.Mesh(new THREE.PlaneGeometry((TRACK.width + 1) / 3 - .18, .7),
        new THREE.MeshBasicMaterial({ map: textTexture(text, '#e6fff7', '#0a2b40', 1024, 160), side: THREE.DoubleSide }));
      product.position.set((i - 1) * (TRACK.width + 1) / 3, 5.15, .3); gate.add(product);
    }
    for (const [i, text] of ['127.0.0.1 GARAGE', 'LANRider', 'PORT 3000 PIT STOP'].entries()) {
      const sponsor = new THREE.Mesh(new THREE.PlaneGeometry((TRACK.width + 1) / 3 - .18, .85),
        new THREE.MeshBasicMaterial({ map: textTexture(text, i === 1 ? '#ffd27a' : '#75f3da', '#0a2b40', 1024, 128), side: THREE.DoubleSide }));
      sponsor.position.set((i - 1) * (TRACK.width + 1) / 3, 6.15, .3); gate.add(sponsor);
    }
    scene.add(gate);
    const lapSign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, .65), new THREE.MeshBasicMaterial({ map: textTexture('3 LAPS', '#ffd466'), side: THREE.DoubleSide }));
    lapSign.position.set(halfWidth + 1.3, 3.25, .35); gate.add(lapSign);
    scene.userData.lapSign = lapSign; scene.userData.laps = 3;
    const startColumns = Math.round(TRACK.width / .75);
    for (let row = 0; row < 2; row++) for (let col = 0; col < startColumns; col++) {
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(.75, .75).rotateX(-Math.PI / 2), (row + col) % 2 ? white : dark);
      const p = sampleTrack(row * .75, -halfWidth + .375 + col * .75); tile.position.set(p.x, .03, p.z); tile.rotation.y = -start.yaw; scene.add(tile);
    }
    const beach=createBeachScenery(sceneryModels, TRACK, graphicsQuality);scene.add(beach);scene.userData.lighthouse=beach.userData.lighthouse;
    scene.userData.palmLighting=beach.userData.palmLighting;
    setSceneryQuality(scene, graphicsQuality);
    return scene;
  }

  const courses = new Map([[TRACK.id, buildCourse()]]);
  scene.add(courses.get(TRACK.id));

  const cars = new Map(), dummy = new THREE.Object3D();
  const headlights = createHeadlights();
  // One bounded mesh covers the entire course; every driver's camera sees the same celebration.
  const confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(.24, .42),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), 864);
  confetti.instanceMatrix.setUsage(THREE.DynamicDrawUsage); confetti.frustumCulled = false;
  confetti.visible = false; scene.add(confetti);
  const confettiColors = ['#65ffe0', '#ffd269', '#ff75a1', '#a28aff', '#ffffff'];
  const confettiPieces = Array.from({ length: 864 }, (_, i) => {
    const p = sampleTrack((i % 48) / 48 * TRACK.length, (((i * 17) % 100) / 100 - .5) * (TRACK.width - 1));
    confetti.setColorAt(i, new THREE.Color(confettiColors[i % confettiColors.length]));
    return { x: p.x, z: p.z, y: 5 + i % 9 * .7, phase: i * 2.399, fall: .8 + i % 5 * .15 };
  });
  let celebrationAge = 100;
  const smoke = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 5, 4), new THREE.MeshBasicMaterial({ color: '#e7eee9', transparent: true, opacity: .22, depthWrite: false }), 96);
  smoke.instanceMatrix.setUsage(THREE.DynamicDrawUsage); smoke.frustumCulled = false; scene.add(smoke);
  const skids = new THREE.InstancedMesh(new THREE.PlaneGeometry(.15, .7).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#112b32', transparent: true, opacity: .3, depthWrite: false }), 128);
  skids.instanceMatrix.setUsage(THREE.DynamicDrawUsage); skids.frustumCulled = false; scene.add(skids);
  const particles = Array.from({ length: 96 }, () => ({ life: 0 }));
  const trails = Array.from({ length: 128 }, () => ({ life: 0 }));
  let particleIndex = 0, trailIndex = 0, effectClock = 0, collisionDebug = false;
  function createVisual(id, slot, name, vehicle) {
    const model = createVehicleModel(bodies, driver, vehicle, vehicleQuality), { root, person, exhausts } = model;
    root.userData.playerId = id;
    person.traverse(child => { if (child.isMesh) child.material = driverMaterials[slot].get(child.material); });
    root.traverse(child => { if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; } });
    const lights = createVehicleLights(model.body);
    const mixer = new THREE.AnimationMixer(person);
    const idle = mixer.clipAction(driver.animations.find(clip => clip.name === 'drive_idle')); idle.play();
    const victory = mixer.clipAction(driver.animations.find(clip => clip.name === 'victory'));
    victory.setLoop(THREE.LoopOnce, 1); victory.clampWhenFinished = true;
    const marker = new THREE.Mesh(new THREE.RingGeometry(.92, 1.05, 32), new THREE.MeshBasicMaterial({ color: COLORS[slot], transparent: true, opacity: .6, depthWrite: false }));
    marker.rotation.x = -Math.PI / 2; marker.position.y = .015; root.add(marker);
    const labelTexture = textTexture(`${slot + 1}  ${name}`, COLORS[slot], '#082736dd', 512, 96);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthTest: false }));
    label.position.set(0, 2.15, 0); label.scale.set(3.2, .6, 1); root.add(label);
    const box = collisionBox(vehicle);
    const collider = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(-box.width / 2, 0, -box.length / 2 - box.offset),
      new THREE.Vector3(box.width / 2, box.height, box.length / 2 - box.offset)), COLORS[slot]);
    collider.material.depthTest = false; collider.material.transparent = true; collider.material.opacity = .75;
    collider.visible = collisionDebug; root.add(collider);
    const flame = new THREE.Group(), glow = new THREE.Group();
    for (const position of exhausts) {
      const outer = new THREE.Mesh(new THREE.ConeGeometry(.2, 1.8, 8), new THREE.MeshBasicMaterial({ color: '#77f6ff', transparent: true, opacity: .8, depthWrite: false }));
      const inner = new THREE.Mesh(new THREE.ConeGeometry(.11, 1.1, 8), new THREE.MeshBasicMaterial({ color: '#eaffff' }));
      for (const [mesh, length] of [[outer, 1.8], [inner, 1.1]]) {
        mesh.rotation.x = Math.PI / 2; mesh.position.copy(position); mesh.position.z += length / 2;
      }
      flame.add(outer); glow.add(inner);
    }
    flame.visible = glow.visible = false; root.add(flame, glow);
    scene.add(root);
    const visual = { root, model, mixer, idle, victory, won: false, flame, glow, lights, labelTexture, label, marker, collider, vehicle,
      inertia: createDriverInertia(person), lastYaw: null };
    cars.set(id, visual); return visual;
  }
  const preview = { id: 'preview', slot: 0, name: 'PULSE', vehicle: 'PULSE', ...sampleTrack(-8), speed: 0 };
  const portraits = new Map();
  const camPosition = new THREE.Vector3(), camLook = new THREE.Vector3();
  const wantedPosition = new THREE.Vector3(), wantedLook = new THREE.Vector3();
  let cameraYaw = preview.yaw, cameraReady = false, wasRacing = false;
  function resize() {
    const settings = graphicsSettings(graphicsQuality, innerWidth, innerHeight, devicePixelRatio);
    renderer.setPixelRatio(settings.pixelRatio); renderer.shadowMap.enabled = settings.shadowSize > 0;
    const shadow = scene.getObjectByName('sky-key').shadow, size = settings.shadowSize || 1;
    if (shadow.mapSize.x !== size) {
      shadow.map?.dispose(); shadow.map = null; shadow.mapSize.set(size, size); shadow.needsUpdate = true;
    }
    renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize); resize();
  const world = {
    setCollisionDebug(enabled) { collisionDebug = Boolean(enabled); for (const visual of cars.values()) visual.collider.visible = collisionDebug; },
    stats() {
      if (!graphicsInfo) {
        const gl = renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
        graphicsInfo = { gpu: String(gl.getParameter(info?.UNMASKED_RENDERER_WEBGL || gl.RENDERER) || 'Unavailable'),
          antialias: Boolean(gl.getContextAttributes()?.antialias) };
      }
      return { ...renderer.info.render, ...renderer.info.memory, ...graphicsInfo, cameraLag: camPosition.distanceTo(wantedPosition),
        drawingWidth: canvas.width, drawingHeight: canvas.height, pixelRatio: renderer.getPixelRatio(),
        shadows: renderer.shadowMap.enabled, shadowSize: scene.getObjectByName('sky-key').shadow.mapSize.x };
    },
    async benchmarkGraphicsQuality() {
      if (benchmark) throw new Error('Graphics measurement already running');
      const saved = { quality: graphicsQuality, vehicleQuality, position: camera.position.clone(), quaternion: camera.quaternion.clone(), fov: camera.fov,
        camPosition: camPosition.clone(), camLook: camLook.clone(), wantedPosition: wantedPosition.clone(), wantedLook: wantedLook.clone(),
        cameraYaw, cameraReady, wasRacing };
      let abort;
      const aborted = new Promise((_, reject) => { abort = (reason = 'interrupted') => reject(new Error(`Graphics measurement ${reason}`)); });
      const job = benchmark = { abort, rendering: false, restoreTrack: TRACK };
      const hidden = () => { if (document.hidden) abort('interrupted: hidden tab'); };
      document.addEventListener('visibilitychange', hidden);
      const costs = [], gl = renderer.getContext();
      const timeout = setTimeout(() => abort(`interrupted: timeout (${costs.length} samples)`), 12000);
      try {
        if (document.hidden || gl.isContextLost()) throw new Error('Graphics measurement unavailable');
        graphicsQuality = 'high';
        resize();
        world.setVehicleQuality('high');
        for (const course of courses.values()) setSceneryQuality(course, 'high');
        for (const track of Object.values(TRACKS)) for (const hour of [12, 0]) {
          job.rendering = true; world.setTrack(track); job.rendering = false;
          sky.setEnvironment({ timestamp: Date.UTC(2026, 2, 20, hour), latitude: 0, longitude: 0, cloudCover: 35 });
          // Sample the heavier sectors found by the four-car course sweep.
          for (const sector of track.id === 'beginner' ? [38 / 48, 47 / 48] : [9 / 48, 33 / 48]) {
            cameraReady = false;
            for (let frame = 0; frame < 12; frame++) {
              await Promise.race([new Promise(resolve => setTimeout(resolve, 0)), aborted]);
              const distance = track.length * sector + frame * .4;
              const states = ['PULSE', 'BOLT', 'COMET', 'BULWARK'].map((vehicle, slot) => ({ id: `benchmark-${slot}`, slot, vehicle,
                speed: 24, steer: 0, ...sample(distance + slot * 7, [0, -2.5, 2.5, 0][slot], track) }));
              const before = performance.now();
              job.rendering = true;
              try {
                world.render(states, [], states[0].id, true, 1 / 60, frame / 60, 2);
                // Only the explicit first-launch probe waits for GPU completion; normal rendering stays asynchronous.
                gl.finish();
              } finally { job.rendering = false; }
              if (document.hidden || gl.isContextLost()) throw new Error('Graphics measurement unavailable');
              if (frame >= 4) costs.push(performance.now() - before);
            }
          }
        }
        costs.sort((a, b) => a - b);
        const frameMs = costs[Math.ceil(costs.length * .9) - 1];
        return { quality: graphicsQualityForFrameMs(frameMs), frameMs };
      } finally {
        clearTimeout(timeout); document.removeEventListener('visibilitychange', hidden);
        benchmark = null;
        graphicsQuality = job.manualQuality ?? saved.quality;
        resize();
        world.setVehicleQuality(job.manualQuality ?? saved.vehicleQuality);
        for (const course of courses.values()) setSceneryQuality(course, graphicsQuality);
        world.setTrack(job.restoreTrack);
        sky.setEnvironment({ ...currentEnvironment, timestamp: currentEnvironment.timestamp + performance.now() - environmentAt });
        camPosition.copy(saved.camPosition); camLook.copy(saved.camLook); wantedPosition.copy(saved.wantedPosition); wantedLook.copy(saved.wantedLook);
        camera.position.copy(saved.position); camera.quaternion.copy(saved.quaternion); camera.fov = saved.fov; camera.updateProjectionMatrix();
        cameraYaw = saved.cameraYaw; cameraReady = saved.cameraReady; wasRacing = saved.wasRacing;
      }
    },
    setGraphicsQuality(quality) {
      quality = ['high', 'medium', 'low'].includes(quality) ? quality : 'high';
      if (benchmark) { benchmark.manualQuality = quality; benchmark.abort(); }
      if (quality === graphicsQuality) return;
      graphicsQuality = quality;
      resize();
      world.setVehicleQuality(quality);
      for (const course of courses.values()) setSceneryQuality(course, quality);
    },
    setVehicleQuality(quality) {
      const next = quality === 'low' ? 'low' : 'high';
      if (next === vehicleQuality) return;
      vehicleQuality = next;
      for (const visual of cars.values()) if (visual.model.setQuality(next)) visual.lights.bind(visual.model.body);
    },
    setEnvironment(environment) {
      currentEnvironment = { ...environment }; environmentAt = performance.now();
      if (!benchmark) sky.setEnvironment(currentEnvironment);
    },
    setLaps(laps) {
      const course = courses.get(TRACK.id);
      if (course.userData.laps === laps) return;
      const material = course.userData.lapSign.material;
      material.map.dispose(); material.map = textTexture(`${laps} ${laps === 1 ? 'LAP' : 'LAPS'}`, '#ffd466');
      course.userData.laps = laps;
    },
    setTrack(track) {
      if (benchmark && !benchmark.rendering) { benchmark.restoreTrack = track; return; }
      if (track === TRACK) return;
      courses.get(TRACK.id).visible = false;
      TRACK = track;
      if (!courses.has(track.id)) { const course = buildCourse(); courses.set(track.id, course); scene.add(course); }
      courses.get(track.id).visible = true;
      Object.assign(preview, sampleTrack(-8)); cameraYaw = preview.yaw; cameraReady = false;
      for (let i = 0; i < confettiPieces.length; i++) {
        Object.assign(confettiPieces[i], sampleTrack((i % 48) / 48 * TRACK.length, (((i * 17) % 100) / 100 - .5) * (TRACK.width - 1)));
      }
      celebrationAge = 100; confetti.visible = false;
      for (const p of [...particles, ...trails]) p.life = 0;
    },
    previewVehicle(vehicle) { preview.vehicle = preview.name = vehicle; },
    vehiclePortrait(vehicle) {
      const key = `${vehicle}/${vehicleQuality}`;
      if (portraits.has(key)) return portraits.get(key);
      const { root, camera, dispose } = createVehiclePortrait(bodies, driver, vehicle, vehicleQuality);
      const portrait = new THREE.Scene(); portrait.background = new THREE.Color('#0b2638'); portrait.environment = scene.environment;
      portrait.add(new THREE.HemisphereLight('#e9f9ff', '#547584', 3), root);
      const light = new THREE.DirectionalLight('#ffffff', 3); light.position.set(3, 5, -4); portrait.add(light);
      const target = new THREE.WebGLRenderTarget(384, 240); target.texture.colorSpace = THREE.SRGBColorSpace;
      const previous = renderer.getRenderTarget();
      const pixels = new Uint8Array(384 * 240 * 4);
      try {
        renderer.setRenderTarget(target); renderer.render(portrait, camera);
        renderer.readRenderTargetPixels(target, 0, 0, 384, 240, pixels);
        const image = document.createElement('canvas'); image.width = 384; image.height = 240;
        const context = image.getContext('2d'), data = context.createImageData(384, 240);
        for (let row = 0; row < 240; row++) data.data.set(pixels.subarray((239 - row) * 384 * 4, (240 - row) * 384 * 4), row * 384 * 4);
        context.putImageData(data, 0, 0);
        const url = image.toDataURL('image/png'); portraits.set(key, url); return url;
      } finally {
        renderer.setRenderTarget(previous); target.dispose();
        dispose();
      }
    },
    celebrate() { celebrationAge = 0; confetti.visible = true; },
    clearCelebration() { celebrationAge = 100; confetti.visible = false; },
    render(states, players, localId, racing, dt, now, cameraDt = dt, cameraTurn = 0) {
      if (benchmark && !benchmark.rendering) return;
      // Animation catch-up is capped by the caller; camera following uses real frame time.
      cameraDt = Math.max(0, cameraDt);
      if (confetti.visible) {
        celebrationAge += dt;
        if (celebrationAge >= 8.5) confetti.visible = false;
        for (let i = 0; i < confettiPieces.length; i++) {
          const p = confettiPieces[i], age = celebrationAge;
          const y = p.y + Math.sin(Math.min(age, 1) * Math.PI / 2) * 2 - age * p.fall;
          dummy.position.set(p.x + Math.sin(age * 1.5 + p.phase) * 1.3, Math.max(.1, y), p.z + Math.cos(age + p.phase) * 1.3);
          dummy.rotation.set(age * 3 + p.phase, age * 2 + p.phase, age + p.phase);
          dummy.scale.setScalar(y > 0 ? Math.min(1, (8.5 - age) * 2) : 0);
          dummy.updateMatrix(); confetti.setMatrixAt(i, dummy.matrix);
        }
        confetti.instanceMatrix.needsUpdate = true;
      }
      const shown = states.length ? states : [preview], alive = new Set(shown.map(car => car.id));
      for (const [id, visual] of cars) if (!alive.has(id) || visual.vehicle !== shown.find(car => car.id === id)?.vehicle) {
        scene.remove(visual.root); visual.mixer.stopAllAction(); visual.mixer.uncacheRoot(visual.mixer.getRoot());
        visual.lights.dispose(); visual.model.dispose();
        visual.labelTexture.dispose(); visual.label.material.dispose(); visual.marker.geometry.dispose(); visual.marker.material.dispose();
        visual.collider.geometry.dispose(); visual.collider.material.dispose();
        for (const group of [visual.flame, visual.glow]) for (const mesh of group.children) { mesh.geometry.dispose(); mesh.material.dispose(); }
        cars.delete(id);
      }
      effectClock += dt;
      const emit = effectClock >= .045; if (emit) effectClock = 0;
      for (const car of shown) {
        const player = players.find(p => p.id === car.id);
        const visual = cars.get(car.id) || createVisual(car.id, car.slot, player?.name || car.vehicle, car.vehicle);
        visual.root.position.set(car.x, .035, car.z); visual.root.rotation.y = -car.yaw;
        visual.model.steer.forEach(wheel => { wheel.rotation.y = -(car.steer || 0) * .35; });
        visual.model.spin.forEach((wheel,i) => { wheel.rotation.x -= (car.speed || 0) * dt / visual.model.wheelRadii[i]; });
        visual.braking = Boolean(car.braking);
        if (car.finished && !visual.won) { visual.idle.fadeOut(.25); visual.victory.reset().fadeIn(.25).play(); visual.won = true; }
        if (!car.finished && visual.won) { visual.victory.stop(); visual.idle.reset().play(); visual.won = false; }
        const yawRate = visual.lastYaw === null ? 0 : Math.atan2(Math.sin(car.yaw - visual.lastYaw), Math.cos(car.yaw - visual.lastYaw)) / Math.max(dt, .001);
        visual.lastYaw = car.yaw;
        visual.inertia.beforeAnimation(); visual.mixer.update(dt);
        visual.inertia.afterAnimation({ ...car, steer: car.steer ?? yawRate / 1.5 }, dt);
        const boosting = (car.boostTime || 0) > 0;
        visual.flame.visible = visual.glow.visible = boosting;
        visual.flame.children.forEach(mesh => { mesh.scale.y = 1 + Math.sin(now * 40) * .13; });
        visual.label.visible = racing && car.id !== localId;
        if (car.drifting && emit && racing) for (const side of [-1, 1]) {
          const x = car.x - Math.sin(car.yaw) * .85 + Math.cos(car.yaw) * side * .65;
          const z = car.z + Math.cos(car.yaw) * .85 + Math.sin(car.yaw) * side * .65;
          Object.assign(particles[particleIndex++ % particles.length], { x, z, life: .85, age: 0 });
          Object.assign(trails[trailIndex++ % trails.length], { x, z, yaw: car.yaw, life: 3 });
        }
      }
      particles.forEach((p, i) => {
        p.life = Math.max(0, p.life - dt); p.age = (p.age || 0) + dt;
        dummy.position.set(p.x || 0, .15 + p.age * .5, p.z || 0);
        dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(p.life ? (.15 + p.age * .6) * Math.min(1, p.life * 5) : 0);
        dummy.updateMatrix(); smoke.setMatrixAt(i, dummy.matrix);
      });
      trails.forEach((p, i) => {
        p.life = Math.max(0, p.life - dt); dummy.position.set(p.x || 0, .034, p.z || 0);
        dummy.rotation.set(0, -(p.yaw || 0), 0); dummy.scale.setScalar(Math.min(1, p.life));
        dummy.updateMatrix(); skids.setMatrixAt(i, dummy.matrix);
      });
      smoke.instanceMatrix.needsUpdate = skids.instanceMatrix.needsUpdate = true;
      const focus = shown.find(car => car.id === localId) || shown[0];
      if (wasRacing !== racing) { cameraYaw = focus.yaw; cameraReady = false; wasRacing = racing; }
      cameraYaw = racing ? angle(cameraYaw, focus.yaw, 1 - Math.exp(-cameraDt * 5))
        : (cameraYaw + cameraTurn * dt * 1.2) % (Math.PI * 2);
      const fx = Math.sin(cameraYaw), fz = -Math.cos(cameraYaw), rx = Math.cos(cameraYaw), rz = Math.sin(cameraYaw);
      if (racing) {
        const back = focus.boostTime > 0 ? 10.5 : 8.8;
        wantedPosition.set(focus.x - fx * back, 4.2, focus.z - fz * back);
        wantedLook.set(focus.x + fx * 8, 1.0, focus.z + fz * 8);
      } else {
        wantedPosition.set(focus.x - fx * 6.5 + rx * 5, 3.0, focus.z - fz * 6.5 + rz * 5);
        wantedLook.set(focus.x - rx * 2.1, .8, focus.z - rz * 2.1);
      }
      if (!cameraReady) { camPosition.copy(wantedPosition); camLook.copy(wantedLook); cameraReady = true; }
      camPosition.lerp(wantedPosition, 1 - Math.exp(-cameraDt * 7)); camLook.lerp(wantedLook, 1 - Math.exp(-cameraDt * 8));
      camera.position.copy(camPosition); camera.lookAt(camLook);
      camera.fov = THREE.MathUtils.lerp(camera.fov, focus.boostTime > 0 ? 66 : 55, 1 - Math.exp(-cameraDt * 4)); camera.updateProjectionMatrix();
      sky.update(camera, focus);
      const night = sunsetStrength(sky.sunAltitude()), focusedRoot = cars.get(focus.id).root;
      if (headlights.group.parent !== focusedRoot) focusedRoot.add(headlights.group);
      headlights.update(night,focusedRoot);
      for (const visual of cars.values()) visual.lights.update(night,visual.braking);
      courses.get(TRACK.id).userData.palmLighting.update(sky.sunAltitude());
      courses.get(TRACK.id).userData.lighthouse?.update(sky.sunAltitude(),now);
      waterTexture.offset.set(now * .004, now * .0015);
      updateClouds(clouds, camera, innerHeight, now);
      renderer.render(scene, camera);
    },
  };
  return world;
}
