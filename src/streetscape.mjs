// Buildings from OpenStreetMap, the way a set designer reads a street.
//
// Arnis turns OSM into Minecraft with its own house style (floor-to-ceiling
// glass, randomised wall blocks, stair pyramids for roofs), so at street scale
// the blocks describe Arnis more than the place. The tags describe the place:
// footprint, storeys, height, wall and roof colour, material, roof shape. This
// module turns them into per-stud building masses with a facade rhythm and a
// roof, for `interpretAtScale` to merge with the ground, trees and street
// furniture that still come from the blocks.
//
// Interpretation, stated:
//   - height: `height`, else storeys × 3.5 m (plus `roof:levels`), else the
//     height Arnis built; the same for `min_height` / `building:min_level`;
//   - a building split into `building:part`s is built from its parts;
//   - colours: `building:colour` and `roof:colour` (names read as real
//     building materials, so "red" brick is brick red, not toy red), else a
//     colour for the `building:material`, else a neutral concrete grey. The
//     generated 3D world's own wall colours are never used: for untagged
//     buildings they are its house style, not the place;
//   - each storey shows a row of punched windows on every second stud, solid
//     piers at the corners; curtain-wall (glass) buildings get continuous bands;
//   - gabled, hipped and pyramidal roofs are stepped cheese slopes (one stud in,
//     two plates up: about 39°, a real roof pitch), capped by `roof:height` or
//     at a roof no taller than 60 % of the walls; flat roofs are tiled.
//
// Pure: no DOM, no network.

import { BY_CODE, hexToRgb, rgbToLab } from './palette.mjs';

export const STOREY_M = 3.5;

// ---------------------------------------------------------------- OSM
// Building and building-part outlines as rings of [lat, lon], and the tall
// slender things mapped as points (chimneys, towers, masts).
// Flagpoles are left out: a designer would not build them.
const COLUMN = /^(chimney|tower|mast|communications_tower|lighthouse|water_tower)$/;
export function indexOSM(osm) {
  const nodes = new Map(), ways = new Map();
  for (const e of osm.elements) {
    if (e.type === 'node') nodes.set(e.id, [e.lat, e.lon]);
    else if (e.type === 'way') ways.set(e.id, e);
  }
  const ring = (ids) => ids.map((id) => nodes.get(id)).filter(Boolean);
  const out = [], columns = [];
  for (const e of osm.elements) {
    const t = e.tags;
    if (e.type === 'node' && t && COLUMN.test(t.man_made ?? '')) columns.push({ id: `n${e.id}`, tags: t, at: [e.lat, e.lon] });
    if (!t || !(t.building || t['building:part'])) continue;
    if (t.building === 'no' || t['building:part'] === 'no') continue;
    const part = !t.building && !!t['building:part'];
    if (e.type === 'way' && e.nodes?.length >= 4 && e.nodes[0] === e.nodes.at(-1)) out.push({ id: `w${e.id}`, tags: t, part, rings: [ring(e.nodes)] });
    if (e.type === 'relation' && t.type === 'multipolygon') {
      const outers = e.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => ways.get(m.ref)?.nodes).filter(Boolean);
      const holes = e.members.filter((m) => m.type === 'way' && m.role === 'inner').map((m) => ways.get(m.ref)?.nodes).filter(Boolean);
      const rings = joinRings(outers).map(ring);
      if (rings.length) out.push({ id: `r${e.id}`, tags: t, part, rings, holes: joinRings(holes).map(ring) });
    }
  }
  return { buildings: out, columns };
}

// Ways joined end to end into closed rings.
function joinRings(ways) {
  const rings = [], open = ways.map((w) => w.slice());
  while (open.length) {
    let cur = open.shift();
    let grown = true;
    while (cur[0] !== cur.at(-1) && grown) {
      grown = false;
      for (let i = 0; i < open.length; i++) {
        const w = open[i];
        if (w[0] === cur.at(-1)) cur = cur.concat(w.slice(1));
        else if (w.at(-1) === cur.at(-1)) cur = cur.concat(w.slice(0, -1).reverse());
        else continue;
        open.splice(i, 1); grown = true; break;
      }
    }
    if (cur[0] === cur.at(-1) && cur.length >= 4) rings.push(cur);
  }
  return rings;
}

// Arnis' local projection: a linear map of the world's lat/lon bounds.
export function projector(world) {
  const sx = (world.maxMcX - world.minMcX) / (world.maxGeoLon - world.minGeoLon);
  const sz = (world.maxMcZ - world.minMcZ) / (world.maxGeoLat - world.minGeoLat);
  return ([lat, lon]) => [(lon - world.minGeoLon) * sx, (world.maxGeoLat - lat) * sz];
}

// The buildings touching a box, in metres from the box corner.
export function buildingsInBox(index, world, box) {
  const proj = projector(world);
  const out = [];
  for (const b of index.buildings) {
    const rings = b.rings.map((r) => r.map((p) => { const [x, z] = proj(p); return [x - box.x0, z - box.z0]; }));
    const holes = (b.holes ?? []).map((r) => r.map((p) => { const [x, z] = proj(p); return [x - box.x0, z - box.z0]; }));
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const r of rings) for (const [x, z] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    if (x1 < 0 || z1 < 0 || x0 > box.w || z0 > box.d) continue;
    out.push({ ...b, rings, holes, bbox: [x0, z0, x1, z1] });
  }
  return out;
}

// Chimneys, towers and masts in a box: { tags, x, z, height, colour }.
export function columnsInBox(index, world, box) {
  const proj = projector(world);
  const out = [];
  for (const c of index.columns ?? []) {
    const [x, z] = proj(c.at);
    if (x < box.x0 || z < box.z0 || x >= box.x0 + box.w || z >= box.z0 + box.d) continue;
    const t = c.tags;
    const rgb = parseColour(t.colour ?? t['building:colour']) ?? (MATERIAL[String(t.material ?? '').toLowerCase()] ? hexToRgb(MATERIAL[String(t.material).toLowerCase()]) : null);
    out.push({ id: c.id, tags: t, x: x - box.x0, z: z - box.z0, height: num(t.height) ?? 15, colour: rgb ? nearestIn(rgb, WALLS) : 71 });
  }
  return out;
}

export function inside(rings, holes, x, z) {
  let inn = false;
  for (const r of rings) if (pip(r, x, z)) inn = !inn;
  if (!inn) return false;
  for (const r of holes ?? []) if (pip(r, x, z)) return false;
  return true;
}
function pip(r, x, z) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

// ---------------------------------------------------------------- tags
const num = (v) => { const m = /-?\d+(\.\d+)?/.exec(String(v ?? '')); return m ? Number(m[0]) : null; };

// Heights in metres above the ground: { base, wallTop, roofHeight, levels }.
// `roofHeight` is null when nothing says (the roof then takes its natural
// pitch); a pitched roof on a tagged `height` is taken out of that height.
export function heightsOf(t, measured, pitched) {
  const L = num(t['building:levels']), mL = num(t['building:min_level']) ?? 0;
  const H = num(t.height), rL = num(t['roof:levels']), rH = num(t['roof:height']);
  const base = num(t.min_height) ?? mL * STOREY_M;
  let roof = rH ?? (rL ? rL * STOREY_M : null);
  let wallTop;
  if (H != null) {
    if (roof == null && pitched) roof = Math.min(0.25 * (H - base), 6);
    wallTop = H - (roof ?? 0);
  } else if (L != null) wallTop = L * STOREY_M;
  else wallTop = measured ?? 2 * STOREY_M;
  wallTop = Math.max(base + 1, wallTop);
  // A roof without walls (a canopy, a platform shelter): a slab at its height.
  const canopy = t.building === 'roof' || t['building:part'] === 'roof';
  const slabBase = canopy ? Math.max(base, wallTop - 1) : base;
  const levels = L != null ? Math.max(1, L - mL) : Math.max(1, Math.round((wallTop - base) / STOREY_M));
  return { base: slabBase, wallTop, roofHeight: roof, levels: canopy ? 1 : levels };
}

// Colour names as building materials, not paint swatches.
const NAMED = {
  red: '#8e3b2c', brown: '#6b4733', maroon: '#5e2a22', darkred: '#6a2420', orange: '#c4703b',
  grey: '#8b8e8f', gray: '#8b8e8f', darkgrey: '#545758', darkgray: '#545758', lightgrey: '#b9bcbc', lightgray: '#b9bcbc', silver: '#b9bcbc',
  white: '#ecebe4', black: '#2b2c2e', beige: '#d6c7a1', tan: '#c8b28a', cream: '#e8dfc4', ivory: '#ece6cf', sand: '#c9b48c',
  yellow: '#d8b74b', gold: '#c49a3a', green: '#4d7a4d', darkgreen: '#2e4d34', olive: '#7b7a45', blue: '#4a6c9b', navy: '#2c3e5c',
  lightblue: '#9db6cc', teal: '#3f7f80', pink: '#d8a3a8', purple: '#6c5480', copper: '#4f9a87',
};
const MATERIAL = {
  brick: '#8e3b2c', stone: '#b6ad98', sandstone: '#c9b48c', limestone: '#d3ccb7', granite: '#8f8b86', marble: '#e6e3dc',
  concrete: '#a7a8a5', plaster: '#e2dccb', stucco: '#e2dccb', render: '#e2dccb', wood: '#7b5a3c', timber_framing: '#e2dccb',
  metal: '#8b8e8f', steel: '#8b8e8f', glass: '#5a6b78', mirror: '#5a6b78', cement_block: '#a7a8a5', tiles: '#a85c3f',
};
const ROOF_MATERIAL = { roof_tiles: '#8d4a35', slate: '#3c4144', metal: '#7c8285', copper: '#4f9a87', concrete: '#a7a8a5', tar_paper: '#3a3b3d', gravel: '#9a9993', glass: '#5a6b78', grass: '#4d7a4d', asphalt: '#3a3b3d', thatch: '#9a8355', wood: '#7b5a3c' };

// The bricks a facade or roof can be: architectural colours only.
const WALLS = [15, 71, 72, 0, 19, 28, 78, 84, 92, 70, 320, 308, 4, 25, 14, 2, 288, 330, 1, 272, 73, 321];
const ROOFS = [0, 72, 71, 15, 19, 28, 70, 308, 320, 288, 2, 330];
const lab = new Map();
const labOf = (c) => { if (!lab.has(c)) lab.set(c, rgbToLab(hexToRgb(BY_CODE.get(c).hex))); return lab.get(c); };
function nearestIn(rgb, list) {
  const l = rgbToLab(rgb);
  let best = list[0], bd = Infinity;
  for (const c of list) { const m = labOf(c); const d = (l[0] - m[0]) ** 2 + (l[1] - m[1]) ** 2 + (l[2] - m[2]) ** 2; if (d < bd) { bd = d; best = c; } }
  return best;
}
const parseColour = (v) => {
  if (!v) return null;
  const s = String(v).trim().toLowerCase().replace(/[\s_-]/g, '');
  if (/^#[0-9a-f]{6}$/.test(s)) return hexToRgb(s);
  if (/^#[0-9a-f]{3}$/.test(s)) return hexToRgb('#' + [...s.slice(1)].map((c) => c + c).join(''));
  return NAMED[s] ? hexToRgb(NAMED[s]) : null;
};
export const lightness = (code) => labOf(code)[0];

// { wall, roof, window, glassy, source } as colour codes.
export function coloursOf(t) {
  const material = String(t['building:material'] ?? '').toLowerCase();
  const wallRgb = parseColour(t['building:colour']) ?? (MATERIAL[material] ? hexToRgb(MATERIAL[material]) : null);
  const wall = wallRgb ? nearestIn(wallRgb, WALLS) : 71;
  const roofRgb = parseColour(t['roof:colour']) ?? (ROOF_MATERIAL[String(t['roof:material'] ?? '').toLowerCase()] ? hexToRgb(ROOF_MATERIAL[String(t['roof:material']).toLowerCase()]) : null);
  const roof = roofRgb ? nearestIn(roofRgb, ROOFS) : 72;
  const glassy = material === 'glass' || material === 'mirror';
  // Windows read dark on light walls and light on dark ones (frames and sky).
  const window = glassy ? 40 : lightness(wall) > 45 ? 0 : 71;
  return { wall, roof, window, glassy, source: t['building:colour'] ? 'tag' : MATERIAL[material] ? 'material' : 'default' };
}

// Roof forms we build: gabled, hipped (also pyramids and anything else with a
// roof height, so no tagged height is ever dropped), dome, skillion (a ramp
// rising against `roof:direction`, the way the slope faces), flat.
export function roofShapeOf(t) {
  const s = String(t['roof:shape'] ?? 'flat').toLowerCase();
  if (s === 'skillion' || s === 'lean_to') return 'skillion';
  if (s === 'gabled' || s === 'gambrel' || s === 'saltbox' || s === 'round') return 'gabled';
  if (s === 'hipped' || s === 'half-hipped' || s === 'mansard' || s === 'pyramidal' || s === 'side_hipped') return 'hipped';
  if (s === 'dome' || s === 'onion') return 'dome';
  if (s !== 'flat' && num(t['roof:height']) > 0) return 'hipped';
  return 'flat';
}

// The long axis of a footprint: 'x' or 'z', or null when it runs diagonally.
export function ridgeAxis(rings, across = false) {
  let best = 0, angle = 0;
  for (const r of rings)
    for (let i = 1; i < r.length; i++) {
      const dx = r[i][0] - r[i - 1][0], dz = r[i][1] - r[i - 1][1], len = Math.hypot(dx, dz);
      if (len > best) { best = len; angle = Math.atan2(dz, dx); }
    }
  const a = ((angle % Math.PI) + Math.PI) % Math.PI;               // 0..π
  const offX = Math.min(a, Math.PI - a), offZ = Math.abs(a - Math.PI / 2);
  const deg = (Math.min(offX, offZ) * 180) / Math.PI;
  if (deg > 25) return null;
  const along = offX < offZ ? 'x' : 'z';
  return across ? (along === 'x' ? 'z' : 'x') : along;
}

// ---------------------------------------------------------------- per stud
// A building's stud cells: centre-weighted coverage of the footprint (4 × 4
// samples per stud), at least half; never none.
export function studCells(b, s, nx, nz) {
  const [bx0, bz0, bx1, bz1] = b.bbox;
  const cells = [];
  for (let cz = Math.max(0, Math.floor(bz0 / s)); cz <= Math.min(nz - 1, Math.floor(bz1 / s)); cz++)
    for (let cx = Math.max(0, Math.floor(bx0 / s)); cx <= Math.min(nx - 1, Math.floor(bx1 / s)); cx++) {
      let n = 0;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (inside(b.rings, b.holes, (cx + (i + 0.5) / 4) * s, (cz + (j + 0.5) / 4) * s)) n++;
      if (n >= 8) cells.push(cx, cz);
    }
  // Something slimmer than a stud (a tower's shaft, a chimney) keeps the stud
  // its centre falls in, instead of vanishing.
  if (!cells.length) {
    const cx = Math.floor((bx0 + bx1) / 2 / s), cz = Math.floor((bz0 + bz1) / 2 / s);
    if (cx >= 0 && cz >= 0 && cx < nx && cz < nz) cells.push(cx, cz);
  }
  return cells;
}

// Roof steps per cell, from the distance to the eaves. Returns, per cell,
// { d, dir } where dir is the side the slope faces (its low edge) as
// [dx, dz], or null on a ridge or a flat roof.
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
export function roofSteps(cellSet, nx, shape, axis) {
  const has = (cx, cz) => cellSet.has(cz * nx + cx);
  const run = (cx, cz, [dx, dz]) => { let n = 0; while (has(cx + dx * (n + 1), cz + dz * (n + 1))) n++; return n; };
  const out = new Map();
  for (const k of cellSet) {
    const cx = k % nx, cz = (k / nx) | 0;
    if (shape === 'flat') { out.set(k, { d: 0, dir: null }); continue; }
    const dirs = shape === 'gabled' && axis ? (axis === 'x' ? [DIRS[2], DIRS[3]] : [DIRS[0], DIRS[1]]) : DIRS;
    const ds = dirs.map((d) => run(cx, cz, d));
    const m = Math.min(...ds);
    const at = ds.map((v, i) => (v === m ? i : -1)).filter((i) => i >= 0);
    // Ties on opposite sides make a ridge; otherwise the slope faces the nearest eave.
    const opposite = at.some((i) => at.some((j) => dirs[i][0] === -dirs[j][0] && dirs[i][1] === -dirs[j][1] && i !== j));
    out.set(k, { d: m, dir: opposite ? null : dirs[at[0]] });
  }
  return out;
}

// Cheese-slope rotation whose low edge faces [dx, dz] (high side inward).
// Rotation 0 has its high side to −Z, 90 to −X, 180 to +Z, 270 to +X.
export function slopeRotation([dx, dz]) {
  if (dz > 0) return 0;
  if (dz < 0) return 180;
  if (dx > 0) return 90;
  return 270;
}
