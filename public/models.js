import * as THREE from 'three';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

export const VEHICLE_MODELS = {
  PULSE: '/assets/vehicles/v4/pulse/pulse_lod0.glb', APEX: '/assets/vehicles/v4/apex/apex_lod0.glb',
  BOLT: '/assets/vehicles/v4/bolt/bolt_lod0.glb', COMET: '/assets/vehicles/v4/comet/comet_lod0.glb',
  BULWARK: '/assets/vehicles/v4/bulwark/bulwark_lod0.glb', SLIDE: '/assets/vehicles/v4/slide/slide_lod0.glb',
  IGNIS: '/assets/vehicles/v4/ignis/ignis_lod0.glb', RALLY: '/assets/vehicles/v4/rally/rally_lod0.glb',
};
export const VEHICLE_LIGHT_MODELS = Object.fromEntries(Object.entries(VEHICLE_MODELS).map(([id,url])=>[id,url.replace('_lod0.glb','_lod1.glb')]));
export const COAST_MODELS = ['cliff_columns', 'cliff_terrace', 'thatch_hut', 'lighthouse_islet', 'sea_stacks', 'water_surface'];

// Keep the first face where same-facing coplanar triangles cover the same area.
// Cutting interpolates vertex data, so painted colors, UVs and material seams survive.
export function removeCoplanarOverlaps(geometry) {
  const attributes = Object.entries(geometry.attributes), offsets = new Map();
  let stride = 0;
  for (const [name, attribute] of attributes) { offsets.set(name, stride); stride += attribute.itemSize; }
  const position = offsets.get('position'), index = geometry.index, count = index?.count ?? geometry.attributes.position.count;
  const point = vertex => new THREE.Vector3(...vertex.slice(position, position + 3));
  const triangles = [];
  for (let i = 0; i < count; i += 3) {
    const vertices = [0, 1, 2].map(k => {
      const id = index ? index.getX(i + k) : i + k, vertex = [];
      for (const [, attribute] of attributes) for (let c = 0; c < attribute.itemSize; c++) vertex.push(attribute.getComponent(id, c));
      return vertex;
    });
    const p = vertices.map(point), normal = new THREE.Vector3().crossVectors(p[1].clone().sub(p[0]), p[2].clone().sub(p[0]));
    if (normal.lengthSq() < 1e-18) continue;
    normal.normalize();
    const axis = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
    const drop = axis.indexOf(Math.max(...axis)), axes = [0, 1, 2].filter(n => n !== drop);
    triangles.push({ vertices, normal, constant: normal.dot(p[0]), axes,
      min: [0, 1, 2].map(a => Math.min(...p.map(v => v.getComponent(a)))),
      max: [0, 1, 2].map(a => Math.max(...p.map(v => v.getComponent(a)))),
      material: geometry.groups.find(g => i >= g.start && i < g.start + g.count)?.materialIndex ?? 0 });
  }
  const values = attributes.map(() => []), groups = [], buckets = new Map();
  const size = new THREE.Box3().setFromBufferAttribute(geometry.attributes.position).getSize(new THREE.Vector3());
  const cellSize = Math.max(.001, size.length() * 2 / Math.sqrt(Math.max(1, triangles.length)));
  function cells(triangle, axes = triangle.axes) {
    const [a, b] = axes, drop = 3 - a - b, keys = [];
    for (let x = Math.floor((triangle.min[a] - 1e-6) / cellSize); x <= Math.floor((triangle.max[a] + 1e-6) / cellSize); x++) {
      for (let y = Math.floor((triangle.min[b] - 1e-6) / cellSize); y <= Math.floor((triangle.max[b] + 1e-6) / cellSize); y++) keys.push(`${drop}/${Math.sign(triangle.normal.getComponent(drop))}/${x}/${y}`);
    }
    return keys;
  }
  let vertexCount = 0;
  for (let i = 0; i < triangles.length; i++) {
    const triangle = triangles[i], [u, v] = triangle.axes.map(a => position + a);
    const cross = (a, b, p) => (b[u] - a[u]) * (p[v] - a[v]) - (b[v] - a[v]) * (p[u] - a[u]);
    const area = polygon => Math.abs(polygon.reduce((sum, a, k) => {
      const b = polygon[(k + 1) % polygon.length]; return sum + a[u] * b[v] - a[v] * b[u];
    }, 0)) / 2;
    let pieces = [triangle.vertices], changed = false;
    // Query all projections so rounding at equally dominant normal axes cannot split a plane.
    const nearby = new Set([[0, 1], [0, 2], [1, 2]].flatMap(axes => cells(triangle, axes)).flatMap(key => buckets.get(key) ?? []));
    for (const blocker of nearby) {
      if (!pieces.length) break;
      if (triangle.min.some((n, a) => n > blocker.max[a] + 1e-6 || blocker.min[a] > triangle.max[a] + 1e-6) ||
          triangle.normal.dot(blocker.normal) < 1 - 1e-8 ||
          blocker.vertices.some(p => Math.abs(triangle.normal.dot(point(p)) - triangle.constant) > 1e-6)) continue;
      const clip = blocker.vertices, sign = Math.sign(cross(...clip)), remaining = [];
      for (const piece of pieces) {
        function subtract(padding) {
          let inside = piece; const outside = [];
          for (let edge = 0; edge < 3 && inside.length; edge++) {
            const a = clip[edge], b = clip[(edge + 1) % 3], kept = [], cut = [];
            const margin = padding * Math.hypot(b[u] - a[u], b[v] - a[v]);
            for (let k = 0; k < inside.length; k++) {
              const p = inside[k], q = inside[(k + 1) % inside.length], dp = sign * cross(a, b, p) + margin, dq = sign * cross(a, b, q) + margin;
              if (dp >= 0) kept.push(p);
              if (dp <= 0) cut.push(p);
              if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
                const t = dp / (dp - dq), intersection = p.map((value, c) => value + (q[c] - value) * t);
                kept.push(intersection); cut.push(intersection);
              }
            }
            if (cut.length >= 3 && area(cut) > 1e-9) outside.push(cut);
            inside = kept;
          }
          return { inside, outside };
        }
        const { inside } = subtract(0);
        // A few Float32 ULPs at cut edges prevent rounding from restoring thin overlaps.
        const padding = Math.max(1, ...blocker.min.map(Math.abs), ...blocker.max.map(Math.abs)) * 2 ** -22;
        if (inside.length >= 3 && area(inside) > 1e-9) { remaining.push(...subtract(padding).outside); changed = true; }
        else remaining.push(piece);
      }
      pieces = remaining;
    }
    const first = vertexCount;
    for (let piece of pieces) {
      if (changed) {
        // Separate neighboring cut fragments by a few Float32 ULPs as well.
        const center = piece[0].map((_, c) => piece.reduce((sum, p) => sum + p[c], 0) / piece.length);
        const clearance = Math.min(...piece.map((a, k) => {
          const b = piece[(k + 1) % piece.length], length = Math.hypot(b[u] - a[u], b[v] - a[v]);
          return length ? Math.abs(cross(a, b, center)) / length : Infinity;
        }));
        const padding = Math.max(1, ...triangle.min.map(Math.abs), ...triangle.max.map(Math.abs)) * 2 ** -22;
        if (clearance <= padding) continue;
        piece = piece.map(p => p.map((value, c) => center[c] + (value - center[c]) * (1 - padding / clearance)));
      }
      for (let k = 1; k + 1 < piece.length; k++) {
        const face = [piece[0], piece[k], piece[k + 1]].map(vertex => vertex.map(Math.fround));
        if (cross(...face) * Math.sign(cross(...triangle.vertices)) < 2e-9) continue;
        for (const vertex of face) attributes.forEach(([name, attribute], a) => values[a].push(...vertex.slice(offsets.get(name), offsets.get(name) + attribute.itemSize)));
        const accepted = { ...triangle, vertices: face,
          min: [0, 1, 2].map(a => Math.min(...face.map(p => p[position + a]))),
          max: [0, 1, 2].map(a => Math.max(...face.map(p => p[position + a]))) };
        for (const key of cells(accepted)) {
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(accepted);
        }
        vertexCount += 3;
      }
    }
    if (geometry.groups.length && vertexCount > first) {
      const previous = groups.at(-1);
      if (previous?.materialIndex === triangle.material) previous.count += vertexCount - first;
      else groups.push({ start: first, count: vertexCount - first, materialIndex: triangle.material });
    }
  }
  const result = new THREE.BufferGeometry();
  attributes.forEach(([name, attribute], i) => result.setAttribute(name, new THREE.Float32BufferAttribute(values[i], attribute.itemSize)));
  for (const group of groups) result.addGroup(group.start, group.count, group.materialIndex);
  result.computeBoundingBox(); result.computeBoundingSphere();
  return result;
}

export function createVehicleModel(bodies, driver, vehicle = 'PULSE', quality = 'high') {
  const sources = Object.hasOwn(bodies, vehicle) ? bodies[vehicle] : bodies.PULSE;
  const root = new THREE.Group(), person = clone(driver.scene), variants = new Map();
  root.name = `vehicle/${vehicle}`;
  let current;
  const model = {
    root, person,
    get body() { return current.body; },
    get steer() { return current.steer; },
    get spin() { return current.spin; },
    get wheelRadii() { return current.radii; },
    get radius() { return current.radii[2]; },
    get exhausts() { return current.exhausts; },
    setQuality(value) {
      const key = value === 'low' ? 'light' : 'normal';
      if (current?.key === key) return false;
      if (!variants.has(key)) {
        const body = sources[key].scene.clone(true);
        body.traverse(child => { if (child.isMesh) { child.castShadow = !child.name.startsWith('light_'); child.receiveShadow = true; } });
        body.updateMatrixWorld(true);
        const steer = ['steer_fl','steer_fr'].map(name=>body.getObjectByName(name));
        const spin = ['spin_fl','spin_fr','spin_rl','spin_rr'].map(name=>body.getObjectByName(name));
        const radii = ['wheel_fl','wheel_fr','wheel_rl','wheel_rr'].map(name=>new THREE.Box3().setFromObject(body.getObjectByName(name)).getSize(new THREE.Vector3()).y/2);
        const exhausts = [];
        for (const name of ['boost_l','boost_r']) {
          const position = body.worldToLocal(body.getObjectByName(name).getWorldPosition(new THREE.Vector3()));
          if (!exhausts.some(p=>p.distanceToSquared(position)<.000001)) exhausts.push(position);
        }
        variants.set(key,{key,body,steer,spin,radii,exhausts});
      }
      const next = variants.get(key);
      if (current) {
        next.steer.forEach((node,i)=>node.rotation.copy(current.steer[i].rotation));
        next.spin.forEach((node,i)=>node.rotation.copy(current.spin[i].rotation));
        root.remove(current.body);
      }
      current = next; root.add(current.body);
      current.body.getObjectByName('driver_mount').add(person);
      root.updateMatrixWorld(true);
      return true;
    },
    dispose() {
      const skeletons = new Set(); person.traverse(child=>{if(child.isSkinnedMesh)skeletons.add(child.skeleton);});
      for(const skeleton of skeletons)skeleton.dispose();
      person.removeFromParent(); root.clear(); variants.clear();
    },
  };
  model.setQuality(quality); return model;
}

export function createVehiclePortrait(bodies, driver, vehicle, quality = 'high') {
  const model = createVehicleModel(bodies, driver, vehicle, quality), { root, person } = model;
  const mixer = new THREE.AnimationMixer(person);
  mixer.clipAction(driver.animations.find(clip => clip.name === 'drive_idle')).play(); mixer.update(0);
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere());
  const camera = new THREE.PerspectiveCamera(35, 1.6, .05, 50);
  const distance = bounds.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.08;
  camera.position.copy(bounds.center).addScaledVector(new THREE.Vector3(1, .65, -1).normalize(), distance);
  camera.lookAt(bounds.center); camera.updateMatrixWorld(true);
  return { root, camera, dispose: () => { mixer.stopAllAction(); mixer.uncacheRoot(person); model.dispose(); } };
}
