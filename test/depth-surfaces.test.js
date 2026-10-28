import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { mergeGroups } from 'three/addons/utils/BufferGeometryUtils.js';
import * as models from '../public/models.js';
import { TRACKS, sampleTrack as sample } from '../shared/game.js';

const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function overlapArea(a, b) {
  let out = a;
  if (cross(...b) < 0) b = [...b].reverse();
  for (let i = 0; i < 3 && out.length; i++) {
    const u = b[i], v = b[(i + 1) % 3], input = out; out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length], dp = cross(u, v, p), dq = cross(u, v, q);
      if (dp >= 0) out.push(p);
      if ((dp >= 0) !== (dq >= 0)) {
        const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return Math.abs(out.reduce((sum, p, i) => { const q = out[(i + 1) % out.length]; return sum + p[0] * q[1] - p[1] * q[0]; }, 0)) / 2;
}
function triangles(geometry, matrix = new THREE.Matrix4()) {
  const p = geometry.attributes.position, index = geometry.index, out = [];
  for (let i = 0; i < (index?.count ?? p.count); i += 3) {
    const v = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(p, index ? index.getX(i + k) : i + k).applyMatrix4(matrix));
    if (Math.max(...v.map(p => p.y)) - Math.min(...v.map(p => p.y)) > 1e-6) continue;
    const q = v.map(p => [p.x, p.z]); if (cross(...q) >= 0) continue;
    out.push({ q, minx: Math.min(...q.map(p => p[0])), maxx: Math.max(...q.map(p => p[0])), minz: Math.min(...q.map(p => p[1])), maxz: Math.max(...q.map(p => p[1])) });
  }
  return out;
}
function assertNoOverlap(tris, label) {
  for (let i = 0; i < tris.length; i++) for (let j = i + 1; j < tris.length; j++) {
    const a = tris[i], b = tris[j];
    if (a.minx >= b.maxx || b.minx >= a.maxx || a.minz >= b.maxz || b.minz >= a.maxz) continue;
    const area = overlapArea(a.q, b.q);
    assert.ok(area < 1e-7, `${label}: triangles ${i}/${j} overlap ${area}: ${JSON.stringify([a.q,b.q])}`);
  }
}

test('coplanar trimming preserves attributes, material groups, orientation and its input', () => {
  assert.equal(typeof models.removeCoplanarOverlaps, 'function');
  const geometry = new THREE.BufferGeometry();
  // Two upward triangles overlap; UV and color are linear functions of position.
  const positions = [0, 0, 0, 0, 0, 2, 2, 0, 0, 1, 0, 0, 1, 0, 2, 3, 0, 0];
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(positions.flatMap((_, i) => i % 3 ? [] : [positions[i], positions[i + 2]]), 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([0, 1, 2, 3, 4, 5]);
  geometry.computeVertexNormals(); geometry.addGroup(0, 3, 2); geometry.addGroup(3, 3, 5);
  const output = models.removeCoplanarOverlaps(geometry);
  assert.deepEqual(Array.from(geometry.attributes.position.array), positions);
  assert.equal(geometry.attributes.position.count, 6);
  assert.deepEqual(Array.from(geometry.index.array), [0, 1, 2, 3, 4, 5]);
  assert.equal(geometry.boundingSphere, null);
  assert.equal(geometry.boundingBox, null);
  assert.notEqual(output, geometry);
  assertNoOverlap(triangles(output), 'partial overlap');
  assert.ok(output.groups.some(g => g.materialIndex === 2) && output.groups.some(g => g.materialIndex === 5));
  const p = output.attributes.position, uv = output.attributes.uv, color = output.attributes.color;
  for (let i = 0; i < p.count; i++) {
    assert.ok(Math.abs(uv.getX(i) - p.getX(i)) < 1e-6 && Math.abs(uv.getY(i) - p.getZ(i)) < 1e-6);
    assert.ok(Math.abs(color.getX(i) - p.getX(i)) < 1e-6 && Math.abs(color.getZ(i) - p.getZ(i)) < 1e-6);
    assert.ok(output.attributes.normal.getY(i) > .999);
  }
  const area = triangles(output).reduce((sum, t) => sum + Math.abs(cross(...t.q)) / 2, 0);
  assert.ok(Math.abs(area - 3.5) < 1e-5, 'retain the union footprint within Float32 cut clearance');
  // Identical triangles trim on any plane; opposite-facing and offset faces remain.
  for (const rotation of [new THREE.Matrix4(), new THREE.Matrix4().makeRotationX(.73), new THREE.Matrix4().makeRotationZ(Math.PI / 2)]) {
    const duplicate = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([...positions.slice(0, 9), ...positions.slice(0, 9)], 3));
    duplicate.applyMatrix4(rotation);
    assert.equal(models.removeCoplanarOverlaps(duplicate).attributes.position.count, 3);
  }
  const opposite = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([...positions.slice(0, 9), ...positions.slice(0, 9).slice(0, 3), ...positions.slice(0, 9).slice(6, 9), ...positions.slice(0, 9).slice(3, 6)], 3));
  assert.equal(models.removeCoplanarOverlaps(opposite).attributes.position.count, 6);
  const offset = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([...positions.slice(0, 9), ...positions.slice(0, 9)], 3));
  for (let i = 3; i < 6; i++) offset.attributes.position.setY(i, .01);
  assert.equal(models.removeCoplanarOverlaps(offset).attributes.position.count, 6);
  const rotation = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 1, 1).normalize()));
  const tilted = models.removeCoplanarOverlaps(geometry.clone().applyMatrix4(rotation)).applyMatrix4(rotation.clone().invert());
  assertNoOverlap(triangles(tilted), 'tilted coplanar partial overlap');
});

test('both actual course builders produce nonoverlapping road, curbs, lines and guard tops', async t => {
  const source = await readFile(new URL('../public/scene.js', import.meta.url), 'utf8');
  const ribbonCode = source.slice(source.indexOf('    function ribbon('), source.indexOf('    const halfWidth = TRACK.width / 2;'));
  const guardCode = source.slice(source.indexOf('    const guardMaterial = white.clone();'), source.indexOf('    scene.add(createPropInstances(sceneryModels, trackPropsLayout(TRACK)));'));
  for (const track of Object.values(TRACKS)) {
    let buildMilliseconds = 0;
    const group = new THREE.Group(), sampleTrack = (d, offset = 0) => sample(d, offset, track);
    const ribbon = new Function('THREE', 'TRACK', 'sampleTrack', 'scene', 'mergeGroups', 'removeCoplanarOverlaps', `${ribbonCode}; return ribbon;`)(THREE, track, sampleTrack, group, mergeGroups, models.removeCoplanarOverlaps);
    for (const [left, right] of [[-9, 9], [-9, -8.35], [8.35, 9], [-8.255, -8.145], [8.145, 8.255]]) {
      const started = performance.now();
      ribbon(left, right, 0, new THREE.MeshBasicMaterial());
      buildMilliseconds += performance.now() - started;
      assertNoOverlap(triangles(group.children.at(-1).geometry), `${track.id} ribbon ${left}/${right}`);
    }
    const white = new THREE.MeshStandardMaterial(), mint = new THREE.MeshStandardMaterial();
    const started = performance.now();
    new Function('THREE', 'TRACK', 'sampleTrack', 'scene', 'marker', 'white', 'mint', 'halfWidth', guardCode)(THREE, track, sampleTrack, group, new THREE.Object3D(), white, mint, track.width / 2);
    buildMilliseconds += performance.now() - started;
    const guards = group.children.at(-1), tops = [], matrix = new THREE.Matrix4();
    for (let i = 0; i < guards.count; i++) { guards.getMatrixAt(i, matrix); tops.push(...triangles(guards.geometry, matrix)); }
    assertNoOverlap(tops, `${track.id} guard tops`);
    t.diagnostic(`${track.id}: five course ribbons plus guards built in ${buildMilliseconds.toFixed(1)}ms`);
  }
});
