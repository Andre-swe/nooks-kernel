// Finishing, the way a set designer would: before a model is cut into
// bricks, its top-surface staircases get real 45° slopes. Pure: no DOM.
//
// A slope goes where a course steps down: two cells in a row, A and B, with
// open air in front of B and nothing on B, and the surface rising behind (the
// course above sits on A, or on the cell inward of A). A 2 × 1 slope (3040b)
// covers A and B: its stud row on A, which carries the course above as a
// brick would, its slope over B, facing out. Two such pairs side by side in
// the same colour become one 2 × 2 slope (3039). A slope sits on parts below
// both its cells and is only used in a colour it is made in, so the model
// holds together as before. Flat tops keep their edges square.
//
// Where nothing stands on A either (the very edge of a top), the step is rounded instead, as
// sculptors finish heads, paws and backs: a plate of the pair's size with a curved slope on it
// (Plate 1 × 2 and Slope Curved 2 × 1, 11477; Plate 2 × 2 and Slope Curved 2 × 2, 15068), the
// curve held by the plate's studs. `curved: false` keeps 45° slopes everywhere; `diagonal: false` slopes every step.
import { EMPTY, WILD, VoxelGrid } from './voxels.mjs';
import { slopeRotation } from './streetscape.mjs';
import { isMade } from './availability.mjs';
const EYE_SENTINEL = 32000;   // (cells marked as eyes by the retired bust templates: never sloped)

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
// Colours both curved slopes and their plates are made in (LDraw codes; test/real-parts.test.mjs checks).
const CURVE_MADE = new Set([0, 1, 2, 3, 4, 5, 10, 14, 15, 19, 25, 26, 27, 28, 29, 30, 31, 70, 71, 72, 78, 84, 85, 191, 212, 226, 272, 288, 297, 308, 315, 320, 321, 322, 323, 326, 330, 353, 371, 378, 379, 402, 484]);

// `brick(y)`: true for layers cut as bricks (slopes are a brick tall).
// Returns { vox: a copy with the slope cells emptied, slopes: [{ id, color,
// x0, z0, fx, fz, rotation, layer }] }.
export function planSlopes(vox, { brick = () => true, made = isMade, minLayer = 1, curved = true, diagonal = true } = {}) {
  const { nx, ny, nz } = vox;
  const out = new VoxelGrid(nx, ny, nz);
  out.cells.set(vox.cells);
  const used = new Uint8Array(nx * ny * nz);
  const free = (x, y, z) => vox.get(x, y, z) !== EMPTY && !used[vox.index(x, y, z)];
  const isEye = (v) => v >= EYE_SENTINEL && v <= EYE_SENTINEL + 1;
  const nearEye = ([cx, cz], cy) => {
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (isEye(vox.get(cx + dx, cy + dy, cz + dz))) return true;
    return false;
  };
  const pairs = [];
  for (let y = minLayer; y < ny; y++) {
    if (!brick(y)) continue;
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++)
        for (const [dx, dz] of DIRS) {
          const a = [x, z], b = [x + dx, z + dz], c = [x + 2 * dx, z + 2 * dz], p = [x - dx, z - dz];
          if (!free(a[0], y, a[1]) || !free(b[0], y, b[1])) continue;
          if (vox.get(c[0], y, c[1]) !== EMPTY || vox.get(p[0], y, p[1]) === EMPTY) continue;
          // A step: the surface rises behind B; nothing on B.
          if (vox.get(b[0], y + 1, b[1]) !== EMPTY) continue;
          if (vox.get(a[0], y + 1, a[1]) === EMPTY && vox.get(p[0], y + 1, p[1]) === EMPTY) continue;
          // Not beside an eye (lib/eyes.mjs): its round tile is two studs across and overhangs the cells round it.
          if (nearEye(a, y) || nearEye(b, y)) continue;
          // Held from below at both cells.
          if (vox.get(a[0], y - 1, a[1]) === EMPTY || vox.get(b[0], y - 1, b[1]) === EMPTY) continue;
          // Only on a real diagonal, as a designer would: the step is one of a run, the edge moving in a cell a
          // course above it or out a cell the course below. A lone step on an upright side stays square (a
          // slope on every one of them reads as scales).
          if (diagonal) {
            const fill = (q, yy) => vox.get(q[0], yy, q[1]) !== EMPTY;
            const above = fill(a, y + 1) && !fill(a, y + 2) && fill(p, y + 2);
            const below = fill(c, y - 1) && !fill([x + 3 * dx, z + 3 * dz], y - 1);
            if (!above && !below) continue;
          }
          const ca = vox.get(a[0], y, a[1]), cb = vox.get(b[0], y, b[1]);
          const color = ca === WILD ? cb : cb === WILD || cb === ca ? ca : null;
          if (color === null || color === WILD || !made('3040b', color)) continue;
          used[vox.index(a[0], y, a[1])] = used[vox.index(b[0], y, b[1])] = 1;
          // Rounded when nothing will stand on A, and the curve is made in this colour.
          const round = curved && vox.get(a[0], y + 1, a[1]) === EMPTY && CURVE_MADE.has(color);
          pairs.push({ y, a, b, d: [dx, dz], color, round });
          break;
        }
  }
  // Pairs side by side, facing the same way in the same colour: one 2 × 2.
  const key = (q) => `${q.y}|${q.a[0]}|${q.a[1]}|${q.d}`;
  const byKey = new Map(pairs.map((q) => [key(q), q]));
  const taken = new Set(), slopes = [];
  for (const q of pairs) {
    if (taken.has(q)) continue;
    taken.add(q);
    const [dx, dz] = q.d, side = [dz === 0 ? 0 : 1, dx === 0 ? 0 : 1];   // across the slope
    const r = byKey.get(`${q.y}|${q.a[0] + side[0]}|${q.a[1] + side[1]}|${q.d}`);
    const two = r && !taken.has(r) && r.color === q.color && r.round === q.round && made('3039', q.color);
    if (two) taken.add(r);
    const cells = [q.a, q.b, ...(two ? [r.a, r.b] : [])];
    const x0 = Math.min(...cells.map((c) => c[0])), z0 = Math.min(...cells.map((c) => c[1]));
    const fx = Math.max(...cells.map((c) => c[0])) - x0 + 1, fz = Math.max(...cells.map((c) => c[1])) - z0 + 1;
    if (q.round) slopes.push({ id: two ? '15068' : '11477', base: two ? '3022' : '3023', color: q.color, x0, z0, fx, fz, rotation: slopeRotation(q.d), layer: q.y, w: two ? 2 : 1, d: 2 });
    else slopes.push({ id: two ? '3039' : '3040b', color: q.color, x0, z0, fx, fz, rotation: slopeRotation(q.d), layer: q.y, w: two ? 2 : 1, d: 2 });
    for (const [cx, cz] of cells) out.set(cx, q.y, cz, EMPTY);
  }
  return { vox: out, slopes };
}

// The slopes as parts of a decomposed result (lib/decompose.mjs): appended,
// and written into the owner grid of their layer.
export function addSlopes(result, slopes, { height = 3, bottomOf = (y) => y } = {}) {
  for (const s of slopes) {
    const key = result.parts.length;
    if (s.base) {
      // A rounded edge: the plate takes the cells (it is what holds and is held), the curve sits on it.
      result.parts.push({ key, id: s.base, color: s.color, x0: s.x0, z0: s.z0, fx: s.fx, fz: s.fz, rotation: s.fx === 1 ? 90 : 0, w: 2, d: s.w, h: 1, layer: s.layer, bottom: bottomOf(s.layer), studs: true });
      result.parts.push({ key: key + 1, id: s.id, color: s.color, x0: s.x0, z0: s.z0, fx: s.fx, fz: s.fz, rotation: s.rotation, w: s.w, d: s.d, h: height - 1, layer: s.layer, bottom: bottomOf(s.layer) + 1, studs: false, shape: 'slope', heldBy: key });
      const own = result.owners[s.layer];
      for (let dz = 0; dz < s.fz; dz++) for (let dx = 0; dx < s.fx; dx++) own[(s.z0 + dz) * result.nx + s.x0 + dx] = key;
      continue;
    }
    result.parts.push({ key, id: s.id, color: s.color, x0: s.x0, z0: s.z0, fx: s.fx, fz: s.fz, rotation: s.rotation, w: s.w, d: s.d, h: height, layer: s.layer, bottom: bottomOf(s.layer), studs: true, shape: 'slope' });
    const own = result.owners[s.layer];
    for (let dz = 0; dz < s.fz; dz++) for (let dx = 0; dx < s.fx; dx++) own[(s.z0 + dz) * result.nx + s.x0 + dx] = key;
  }
  return result;
}
