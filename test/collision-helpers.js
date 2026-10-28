import { collisionBox } from '../shared/game.js';

// Independent corner/interval check for the production solver's output.
export function boxesOverlap(a, b, tolerance = .002) {
  const corners = car => {
    const box = collisionBox(car.vehicle), s = Math.sin(car.yaw), c = Math.cos(car.yaw);
    return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([side, end]) => ({
      x: car.x + c * side * box.width / 2 + s * (box.offset + end * box.length / 2),
      z: car.z + s * side * box.width / 2 - c * (box.offset + end * box.length / 2),
    }));
  };
  const first = corners(a), second = corners(b);
  for (const polygon of [first, second]) for (let i = 0; i < 2; i++) {
    const p = polygon[i], q = polygon[i + 1], length = Math.hypot(q.x-p.x, q.z-p.z);
    const nx = -(q.z-p.z) / length, nz = (q.x-p.x) / length;
    const project = points => points.map(point => point.x * nx + point.z * nz);
    const x = project(first), y = project(second);
    if (Math.min(Math.max(...x), Math.max(...y)) - Math.max(Math.min(...x), Math.min(...y)) <= tolerance) return false;
  }
  return true;
}
