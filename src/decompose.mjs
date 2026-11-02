// Voxel grid → real parts, layer by layer.
//
// Greedy tiling in raster order. The first uncovered cell in raster order can
// only be covered by a part whose corner sits exactly on it, so only those
// placements need to be tried. Among them the scorer prefers:
//   - larger parts (fewer pieces, stronger model);
//   - parts that bridge several different parts in the reference layer
//     (running bond), which is what actually holds a brick model together;
// and it penalises a part stacked exactly on an identical footprint, which
// would make a weak column.
//
// A greedy scan cannot see that starting one row or column with 1-wide parts
// would shift every seam in the layer off the seams of its neighbour. So each
// layer is tiled four times, with its seam grid shifted by 0 or 1 stud in x
// and z, and the variant that leaves the fewest separate groups (then the
// fewest parts) wins.

import { isMade } from './availability.mjs';
import { BY_CODE } from './palette.mjs';
import { BRICKS, PLATES, orientations } from './parts.mjs';
import { EMPTY, WILD } from './voxels.mjs';

const SHIFTS = [[0, 0], [1, 0], [0, 1], [1, 1]];
const DIRS = [[1, 1], [-1, 1], [1, -1], [-1, -1]];

// `dir` flips the scan direction per axis (the anchor becomes the far
// corner), so a part can reach back across a boundary that a forward scan
// would always claim first. `bridge` (repair only) rewards a footprint that
// covers both a cell next to a floating part and a cell next to a grounded one.
export function tileLayer(vox, y, options, refs, refParts, shift, dir = [1, 1], bridge = null) {
  const { nx, nz } = vox;
  const X = (u) => (dir[0] > 0 ? u : nx - 1 - u);
  const Z = (v) => (dir[1] > 0 ? v : nz - 1 - v);
  const owner = new Int32Array(nx * nz).fill(-1);
  const placed = [];
  for (let v = 0; v < nz; v++)
    for (let u = 0; u < nx; u++) {
      const ax = X(u), az = Z(v);
      if (vox.get(ax, y, az) === EMPTY || owner[az * nx + ax] >= 0) continue;
      // `options.available(partId, colour)`: only parts made in that colour,
      // unless nothing fits (then any, and the caller recolours).
      let best = null, bestScore = -Infinity;
      const avail = options.available;
      for (const strict of avail ? [true, false] : [false]) {
      if (best) break;
      for (const o of options) {
        if (u + o.fx > nx || v + o.fz > nz) continue;
        // Inside the shifted margin only parts that stop at the shift line.
        if (u < shift[0] && u + o.fx > shift[0]) continue;
        if (v < shift[1] && v + o.fz > shift[1]) continue;
        let color = WILD, ok = true, fl = false, gr = false;
        const under = new Set();
        for (let dz = 0; dz < o.fz && ok; dz++)
          for (let dx = 0; dx < o.fx; dx++) {
            const cx = X(u + dx), cz = Z(v + dz);
            const c = vox.get(cx, y, cz);
            if (c === EMPTY || owner[cz * nx + cx] >= 0) { ok = false; break; }
            if (c !== WILD) {
              if (color === WILD) color = c;
              else if (color !== c) { ok = false; break; }
            }
            for (const ref of refs) if (ref[cz * nx + cx] >= 0) under.add(ref[cz * nx + cx]);
            if (bridge) { fl ||= bridge.float[cz * nx + cx] === 1; gr ||= bridge.ground[cz * nx + cx] === 1; }
          }
        if (!ok) continue;
        if (strict && color !== WILD && !avail(o.part.id, color)) continue;
        const x0 = dir[0] > 0 ? ax : ax - o.fx + 1, z0 = dir[1] > 0 ? az : az - o.fz + 1;
        let score = o.fx * o.fz * 4 + under.size * 6 + (fl && gr ? 200 : 0);
        if (under.size === 1 && refParts) {
          const p = refParts[[...under][0]];
          if (p.x0 === x0 && p.z0 === z0 && p.fx === o.fx && p.fz === o.fz) score -= 40;
        }
        if (score > bestScore) { bestScore = score; best = { o, color, x: x0, z: z0 }; }
      }
      }
      const i = placed.length;
      placed.push(best);
      for (let dz = 0; dz < best.o.fz; dz++)
        for (let dx = 0; dx < best.o.fx; dx++) owner[(best.z + dz) * nx + best.x + dx] = i;
    }
  return { placed, owner };
}

// Separate groups formed by this layer together with its reference layer.
export function groups(layer, ref, n) {
  if (!ref) return layer.placed.length;
  const parent = new Map();
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const add = (k) => { if (!parent.has(k)) parent.set(k, k); };
  for (let i = 0; i < n; i++) {
    const a = layer.owner[i], b = ref[i];
    if (a >= 0) add(`a${a}`);
    if (b >= 0) add(`b${b}`);
    if (a >= 0 && b >= 0) {
      const ra = find(`a${a}`), rb = find(`b${b}`);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  let roots = 0;
  for (const k of parent.keys()) if (find(k) === k) roots++;
  return roots;
}

// `topDown` tiles from the top layer down, staggering each layer against the
// one above. A mosaic needs this: the picture is fixed by the image, so the
// hidden backing must be laid to bridge the picture's seams, not vice versa.
export function decompose(vox, { kind = 'brick', fillColor = 71, layerKinds = null, topDown = false } = {}) {
  const { nx, ny, nz } = vox;
  const parts = [];
  const owners = new Array(ny);
  const kindOf = (y) => (layerKinds ? layerKinds[y] : kind);
  const heightOf = (y) => (kindOf(y) === 'plate' ? 1 : 3);
  const bottoms = [];
  for (let y = 0, b = 0; y < ny; y++) { bottoms.push(b); b += heightOf(y); }
  const order = Array.from({ length: ny }, (_, i) => (topDown ? ny - 1 - i : i));
  for (const y of order) {
    const options = orientations(kindOf(y) === 'plate' ? PLATES : BRICKS)
      .sort((a, b) => b.fx * b.fz - a.fx * a.fz);
    // Only parts made in the cell's colour (a 2 × 2 brick is never trans-yellow, a 2 × 8 never dark tan), so
    // a lit window or a tan coat keeps its colour instead of the reviewer swapping in the nearest colour the
    // part is made in afterwards (a grey brick in a tan coat). When nothing made fits, any part, recoloured.
    options.available = (id, colour) => isMade(id, colour);
    const h = heightOf(y);
    const r = topDown ? y + 1 : y - 1;
    const ref = r >= 0 && r < ny ? owners[r] : null;
    let best = null, bestKey = null;
    for (const shift of ref ? SHIFTS : [[0, 0]]) {
      const layer = tileLayer(vox, y, options, ref ? [ref] : [], parts, shift);
      const key = [groups(layer, ref, nx * nz), layer.placed.length];
      if (!best || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
        best = layer; bestKey = key;
      }
    }
    const base = parts.length;
    for (const { o, color, x, z } of best.placed) {
      parts.push({
        key: parts.length, id: o.part.id, color: color === WILD ? fillColor : color,
        x0: x, z0: z, fx: o.fx, fz: o.fz, rotation: o.rotation,
        w: o.part.w, d: o.part.d, h, layer: y, bottom: bottoms[y], fillColor,
      });
    }
    owners[y] = best.owner.map((i) => (i >= 0 ? base + i : -1));
  }
  return { parts, owners, nx, ny, nz };
}

// Repair pass. The forward pass only looks at the layer below, so a part can
// end up held by nothing that reaches the ground (a fin beside a body, an arm
// beside a torso). Re-tile the layers around each floating part against both
// neighbours, and keep a re-tiling only when the whole model improves.
export function repair(vox, result, validateFn, { rounds = 4, single = false } = {}) {
  // `single`: the model must be one piece (a mosaic or a place on a backing),
  // so separate groups count as defects too, not only floating parts.
  const cost = (v) => v.floating.length * 1000 + (single ? v.components - 1 : 0);
  const stray = (r, v) => {
    if (!single) return v.floating;
    // Parts outside the largest connected group.
    const n = r.parts.length, par = Int32Array.from({ length: n }, (_, i) => i);
    const f = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let y = 1; y < r.owners.length; y++)
      for (let i = 0; i < r.nx * r.nz; i++) {
        const a = r.owners[y][i], b = r.owners[y - 1][i];
        if (a >= 0 && b >= 0) par[f(a)] = f(b);
      }
    const size = new Map();
    for (let i = 0; i < n; i++) size.set(f(i), (size.get(f(i)) || 0) + 1);
    let big = -1, bigN = -1;
    for (const [k, c] of size) if (c > bigN) { big = k; bigN = c; }
    return [...Array(n).keys()].filter((i) => f(i) !== big);
  };
  let best = result, score = cost(validateFn(result));
  for (let round = 0; round < rounds && score > 0; round++) {
    const layers = new Set();
    const v = validateFn(best);
    const bad = stray(best, v);
    for (const k of bad) {
      const y = best.parts[k].layer;
      for (const l of [y - 1, y, y + 1]) if (l >= 0 && l < vox.ny) layers.add(l);
    }
    let improved = false;
    for (const y of layers) {
      const sample = best.parts.find((p) => p.layer === y);
      if (!sample) continue;
      const options = orientations(sample.h === 1 ? PLATES : BRICKS).sort((a, b) => b.fx * b.fz - a.fx * a.fz);
      const refs = [best.owners[y - 1], best.owners[y + 1]].filter(Boolean);
      const floating = new Set(stray(best, validateFn(best)));
      const n = vox.nx * vox.nz;
      const bridge = { float: new Uint8Array(n), ground: new Uint8Array(n) };
      for (const own of [best.owners[y - 1], best.owners[y], best.owners[y + 1]].filter(Boolean))
        for (let i = 0; i < n; i++) {
          if (own[i] < 0) continue;
          if (floating.has(own[i])) bridge.float[i] = 1; else bridge.ground[i] = 1;
        }
      for (const dir of DIRS)
        for (const shift of SHIFTS) {
          const layer = tileLayer(vox, y, options, refs, null, shift, dir, bridge);
          const cand = replaceLayer(best, y, layer, sample);
          const f = cost(validateFn(cand));
          if (f < score) { best = cand; score = f; improved = true; }
        }
    }
    if (!improved) break;
  }
  return best;
}

export function replaceLayer(result, y, layer, sample) {
  const kept = result.parts.filter((p) => p.layer !== y);
  const parts = [];
  const remap = new Map();
  for (const p of kept) { remap.set(p.key, parts.length); parts.push({ ...p, key: parts.length }); }
  const base = parts.length;
  for (const { o, color, x, z } of layer.placed) {
    parts.push({
      key: parts.length, id: o.part.id, color: color === WILD ? sample.fillColor ?? 71 : color,
      x0: x, z0: z, fx: o.fx, fz: o.fz, rotation: o.rotation,
      w: o.part.w, d: o.part.d, h: sample.h, layer: y, bottom: sample.bottom,
    });
  }
  const owners = result.owners.map((own, l) => (l === y
    ? layer.owner.map((i) => (i >= 0 ? base + i : -1))
    : own.map((i) => (i >= 0 ? remap.get(i) : -1))));
  return { ...result, parts, owners };
}

// Last resort for a floating group: plain bricks only lock together through
// shared studs, so a fin that touches a body only from the side, in another
// colour, can never be held. Recolour one stud on the grounded side to the
// floating part's colour, so a single part can span the seam, then repair
// again. Each recolour is one visible stud; the count is reported.
// Bounded by count, not by time, so the same model always comes out the same.
export function bridgeByRecolour(vox, result, validateFn, rebuild, { maxCells = 12 } = {}) {
  const snapshot = () => vox.cells.slice();
  let best = result, recoloured = 0;
  let keep = { result, cells: snapshot(), floating: validateFn(result).floating.length, recoloured: 0 };
  for (let i = 0; i < maxCells; i++) {
    const v = validateFn(best);
    if (!v.floating.length) break;
    const floating = new Set(v.floating);
    let done = false;
    // Prefer a seam where the grounded neighbour has studs above or below,
    // so the spanning part is actually held. A floating speck of one or two
    // studs simply takes its neighbour's colour instead.
    const candidates = [];
    for (const k of v.floating) {
      const p = best.parts[k];
      const own = best.owners[p.layer];
      for (let dz = 0; dz < p.fz; dz++)
        for (let dx = 0; dx < p.fx; dx++) {
          const x = p.x0 + dx, z = p.z0 + dz;
          for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + ax, nz = z + az;
            if (nx < 0 || nz < 0 || nx >= vox.nx || nz >= vox.nz) continue;
            const o = own[nz * vox.nx + nx];
            if (o < 0 || floating.has(o)) continue;
            const held = vox.filled(nx, p.layer - 1, nz) || vox.filled(nx, p.layer + 1, nz);
            candidates.push({ p, x, z, nx, nz, held, other: best.parts[o] });
          }
        }
    }
    candidates.sort((a, b) => Number(b.held) - Number(a.held));
    const c = candidates[0];
    if (c) {
      done = true;
      if (c.p.fx * c.p.fz <= 2 && c.other.color !== c.p.color) {
        for (let dz = 0; dz < c.p.fz; dz++)
          for (let dx = 0; dx < c.p.fx; dx++)
            if (vox.get(c.p.x0 + dx, c.p.layer, c.p.z0 + dz) !== WILD) vox.set(c.p.x0 + dx, c.p.layer, c.p.z0 + dz, c.other.color);
      } else if (vox.get(c.nx, c.p.layer, c.nz) !== WILD) {
        vox.set(c.nx, c.p.layer, c.nz, c.p.color);
      }
    }
    if (!done) break;
    recoloured++;
    best = repair(vox, rebuild(), validateFn, { rounds: 2 });
    const f = validateFn(best).floating.length;
    if (f < keep.floating) keep = { result: best, cells: snapshot(), floating: f, recoloured };
  }
  // Recolouring can make things worse; keep the best state seen.
  vox.cells.set(keep.cells);
  return { result: keep.result, recoloured: keep.recoloured };
}

// Parts outside the largest connected group (stud connections only), plus
// each part's group root.
export function strayInfo(r) {
  const n = r.parts.length, par = Int32Array.from({ length: n }, (_, i) => i);
  const f = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (let y = 1; y < r.owners.length; y++) {
    const up = r.owners[y], down = r.owners[y - 1];
    for (let i = 0; i < r.nx * r.nz; i++) {
      const a = up[i], b = down[i];
      if (a >= 0 && b >= 0 && a !== b && r.parts[b].studs !== false) par[f(a)] = f(b);
    }
  }
  const size = new Map();
  for (let i = 0; i < n; i++) size.set(f(i), (size.get(f(i)) || 0) + 1);
  let big = -1, bigN = -1;
  for (const [k, c] of size) if (c > bigN) { big = k; bigN = c; }
  const root = new Int32Array(n);
  const stray = new Set();
  for (let i = 0; i < n; i++) { root[i] = f(i); if (root[i] !== big) stray.add(i); }
  return { stray, root };
}
export const strayParts = (r) => strayInfo(r).stray;

// Stitch loose groups to the main model. For a stray part beside a part of
// the main group in the same layer, where the two touching cells can share a
// part (same colour, or a hidden WILD cell), re-cut the two so one 1 x 2
// spans the seam and the rest of their footprint is re-tiled. One stitch per
// loose group per pass, then one re-check, so big models stay fast.
export function stitch(vox, result, { maxStitches = 60, maxPasses = 30, eligible = () => true } = {}) {
  let r = { ...result, parts: result.parts.slice(), owners: result.owners.map((o) => o.slice()) };
  let stitched = 0;
  for (let pass = 0; pass < maxPasses && stitched < maxStitches; pass++) {
    const { stray, root } = strayInfo(r);
    if (!stray.size) break;
    const usedGroup = new Set(), touched = new Set();
    let did = 0;
    const candidates = [...stray].map((k) => r.parts[k]).filter(eligible).sort((a, b) => a.layer - b.layer);
    for (const p of candidates) {
      if (stitched >= maxStitches) break;
      if (usedGroup.has(root[p.key]) || touched.has(p.key)) continue;
      const own = r.owners[p.layer];
      let found = null;
      for (let dz = 0; dz < p.fz && !found; dz++)
        for (let dx = 0; dx < p.fx && !found; dx++) {
          const x = p.x0 + dx, z = p.z0 + dz, a = vox.get(x, p.layer, z);
          for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + ax, nz = z + az;
            if (nx < 0 || nz < 0 || nx >= r.nx || nz >= r.nz) continue;
            const qk = own[nz * r.nx + nx];
            if (qk < 0 || stray.has(qk) || touched.has(qk)) continue;
            const q = r.parts[qk];
            if (!eligible(q) || q.layer !== p.layer || q.h !== p.h) continue;
            const b = vox.get(nx, p.layer, nz);
            if (a !== WILD && b !== WILD && a !== b) continue;
            found = { q, c: [x, z], d: [nx, nz] };
            break;
          }
        }
      if (!found) continue;
      recutInPlace(vox, r, p, found.q, found.c, found.d);
      touched.add(p.key); touched.add(found.q.key); usedGroup.add(root[p.key]);
      did++; stitched++;
    }
    if (!did) break;
    r = compact(r);
  }
  return { result: r, stitched };
}

function spanOf(r, part) { return r.subLayers ? part.h : 1; }

function recutInPlace(vox, r, p, q, c, d) {
  const y = p.layer, h = p.h, span = spanOf(r, p);
  const key = (x, z) => x * 65536 + z;
  const cells = new Set();
  for (const part of [p, q])
    for (let dz = 0; dz < part.fz; dz++)
      for (let dx = 0; dx < part.fx; dx++) cells.add(key(part.x0 + dx, part.z0 + dz));
  const options = orientations(h === 1 ? PLATES : BRICKS).sort((a, b) => b.fx * b.fz - a.fx * a.fz);
  const colourOf = (list) => {
    let col = WILD;
    for (const [x, z] of list) { const v = vox.get(x, y, z); if (v !== WILD) { if (col !== WILD && col !== v) return null; col = v; } }
    return col;
  };
  const placed = [];
  const horizontal = c[1] === d[1];
  const bridge = options.find((o) => o.fx === (horizontal ? 2 : 1) && o.fz === (horizontal ? 1 : 2));
  placed.push({ o: bridge, x: Math.min(c[0], d[0]), z: Math.min(c[1], d[1]), color: colourOf([c, d]) });
  cells.delete(key(c[0], c[1])); cells.delete(key(d[0], d[1]));
  const sorted = [...cells].map((k) => [Math.floor(k / 65536), k % 65536]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  for (const [x, z] of sorted) {
    if (!cells.has(key(x, z))) continue;
    for (const o of options) {
      const list = [];
      for (let dz = 0; dz < o.fz; dz++) for (let dx = 0; dx < o.fx; dx++) list.push([x + dx, z + dz]);
      if (!list.every(([a, b]) => cells.has(key(a, b)))) continue;
      const color = colourOf(list);
      if (color === null) continue;
      placed.push({ o, x, z, color });
      for (const [a, b] of list) cells.delete(key(a, b));
      break;
    }
  }
  for (const old of [p, q]) {
    for (let s = 0; s < spanOf(r, old); s++)
      for (let dz = 0; dz < old.fz; dz++)
        for (let dx = 0; dx < old.fx; dx++) {
          const i = (old.z0 + dz) * r.nx + old.x0 + dx;
          if (r.owners[old.layer + s][i] === old.key) r.owners[old.layer + s][i] = -1;
        }
    r.parts[old.key] = null;
  }
  for (const { o, x, z, color } of placed) {
    const k = r.parts.length;
    const part = {
      key: k, id: o.part.id, color: color === WILD ? (p.fillColor ?? 71) : color,
      x0: x, z0: z, fx: o.fx, fz: o.fz, rotation: o.rotation,
      w: o.part.w, d: o.part.d, h, layer: y, bottom: p.bottom, fillColor: p.fillColor,
    };
    if (p.section) part.section = p.section;
    if (p.stepLayer !== undefined) part.stepLayer = p.stepLayer;
    if (p.shape && p.shape !== 'tile') part.shape = p.shape;          // re-cut tiles become plates
    r.parts.push(part);
    for (let s = 0; s < span; s++)
      for (let dz = 0; dz < o.fz; dz++)
        for (let dx = 0; dx < o.fx; dx++) r.owners[y + s][(z + dz) * r.nx + x + dx] = k;
  }
}

function compact(r) {
  const remap = new Int32Array(r.parts.length).fill(-1);
  const parts = [];
  r.parts.forEach((p, i) => { if (p) { remap[i] = parts.length; parts.push({ ...p, key: parts.length }); } });
  for (const own of r.owners)
    for (let i = 0; i < own.length; i++) if (own[i] >= 0) own[i] = remap[own[i]];
  return { ...r, parts };
}
