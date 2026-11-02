// Triangle mesh → voxel grid. This is where a real 3D reconstruction enters:
// a .glb from any image-to-3D or world model is voxelised here, then goes
// through the same decomposer and validator as a photo relief.
//
// Fill uses parity ray casting along Z (assumes a closed mesh). Colour comes
// from rays along all three axes: each hit paints the cell it lands in, then
// remaining visible cells take the nearest painted colour. Hidden cells
// become WILD.

import { VoxelGrid, EMPTY, WILD } from './voxels.mjs';
import { nearestColor, choosePalette } from './palette.mjs';
// A brick is 1.2 times as tall as it is wide (24 LDU on a 20 LDU stud).
const BRICK_ASPECT = 1.2;

// mesh: { positions: Float32Array (xyz per vertex), indices: Uint32Array|null,
//         colorAt(tri, u, v) -> [r, g, b] }  (u, v barycentric weights of v1, v2)
export function voxelizeMesh(mesh, { width = 32, maxColors = 8 } = {}) {
  const P = mesh.positions;
  const I = mesh.indices || Uint32Array.from({ length: P.length / 3 }, (_, i) => i);
  const nTri = I.length / 3;
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], P[i + a]); max[a] = Math.max(max[a], P[i + a]); }
  const span = Math.max(max[0] - min[0], max[2] - min[2]) || 1;
  const cell = span / width;                         // stud pitch in mesh units
  const sizes = [cell, cell * BRICK_ASPECT, cell];   // x, y (layers), z
  const dims = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a] - min[a]) / sizes[a])));
  const vox = new VoxelGrid(dims[0], dims[1], dims[2]);
  const paint = new Map();

  const V = (k, a) => P[I[k] * 3 + a];
  // Cast rays along `axis` through every cell centre of the other two axes.
  const cast = (axis, fill) => {
    const [u, v] = [0, 1, 2].filter((a) => a !== axis);
    const nu = dims[u], nv = dims[v];
    const bins = Array.from({ length: nu * nv }, () => []);
    for (let t = 0; t < nTri; t++) {
      let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (let k = 0; k < 3; k++) {
        const cu = (V(t * 3 + k, u) - min[u]) / sizes[u] - 0.5;
        const cv = (V(t * 3 + k, v) - min[v]) / sizes[v] - 0.5;
        lo = [Math.min(lo[0], cu), Math.min(lo[1], cv)];
        hi = [Math.max(hi[0], cu), Math.max(hi[1], cv)];
      }
      for (let a = Math.max(0, Math.ceil(lo[0])); a <= Math.min(nu - 1, Math.floor(hi[0])); a++)
        for (let b = Math.max(0, Math.ceil(lo[1])); b <= Math.min(nv - 1, Math.floor(hi[1])); b++) bins[b * nu + a].push(t);
    }
    for (let b = 0; b < nv; b++)
      for (let a = 0; a < nu; a++) {
        const pu = min[u] + (a + 0.5) * sizes[u], pv = min[v] + (b + 0.5) * sizes[v];
        const hits = [];
        for (const t of bins[b * nu + a]) {
          const x0 = V(t * 3, u), y0 = V(t * 3, v);
          const x1 = V(t * 3 + 1, u), y1 = V(t * 3 + 1, v);
          const x2 = V(t * 3 + 2, u), y2 = V(t * 3 + 2, v);
          const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
          if (Math.abs(det) < 1e-12) continue;
          const l0 = ((y1 - y2) * (pu - x2) + (x2 - x1) * (pv - y2)) / det;
          const l1 = ((y2 - y0) * (pu - x2) + (x0 - x2) * (pv - y2)) / det;
          const l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          const depth = l0 * V(t * 3, axis) + l1 * V(t * 3 + 1, axis) + l2 * V(t * 3 + 2, axis);
          hits.push({ depth, t, l1, l2 });
        }
        hits.sort((p, q) => p.depth - q.depth);
        const cellOf = (depth) => Math.min(dims[axis] - 1, Math.max(0, Math.floor((depth - min[axis]) / sizes[axis])));
        const coord = (w) => { const c = [0, 0, 0]; c[u] = a; c[v] = b; c[axis] = w; return c; };
        if (fill)
          for (let h = 0; h + 1 < hits.length; h += 2) {
            const s = Math.round((hits[h].depth - min[axis]) / sizes[axis]);
            const e = Math.round((hits[h + 1].depth - min[axis]) / sizes[axis]);
            for (let w = s; w < Math.max(s + 1, e); w++) {
              const [x, y, z] = coord(Math.min(dims[axis] - 1, w));
              vox.set(x, y, z, WILD);
            }
          }
        for (const hit of hits) {
          const [x, y, z] = coord(cellOf(hit.depth));
          const k = vox.index(x, y, z);
          if (!paint.has(k)) paint.set(k, mesh.colorAt(hit.t, hit.l1, hit.l2));
        }
      }
  };
  cast(2, true);
  cast(0, false);
  cast(1, false);

  // Quantise painted colours, then flood them across the visible shell.
  const allowed = choosePalette([...paint.values()], maxColors);
  const code = new Map();
  for (const [k, rgb] of paint) if (vox.cells[k] !== EMPTY) code.set(k, nearestColor(rgb, allowed));
  const fallback = code.size ? [...code.values()][0] : 71;
  const queue = [...code.keys()];
  for (const k of queue) vox.cells[k] = code.get(k);
  const xyz = (k) => { const x = k % vox.nx, r = (k / vox.nx) | 0; return [x, (r / vox.nz) | 0, r % vox.nz]; };
  for (let q = 0; q < queue.length; q++) {
    const [x, y, z] = xyz(queue[q]);
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (!vox.inside(x + dx, y + dy, z + dz)) continue;
      const n = vox.index(x + dx, y + dy, z + dz);
      if (vox.cells[n] === WILD && vox.visible(x + dx, y + dy, z + dz)) {
        vox.cells[n] = vox.cells[queue[q]];
        queue.push(n);
      }
    }
  }
  for (let y = 0; y < vox.ny; y++)
    for (let z = 0; z < vox.nz; z++)
      for (let x = 0; x < vox.nx; x++)
        if (vox.get(x, y, z) === WILD && vox.visible(x, y, z)) vox.set(x, y, z, fallback);
  vox.hideInterior();
  return vox.trim();
}
