// Weight and balance (workbench Phase 0): each part's mass, the model's
// total, its centre of mass and whether it stands. ESTIMATES, NOT MEASURED:
// a part's mass is its volume × the density of ABS; the volume is its LDraw
// shape's where the caller has it (scaled to real weights, see MESH_SCALE), else a hollow box (the part's footprint ×
// height less the open underside, plus studs and tubes). The model is taken
// as one rigid body on a flat desk: it stands while its centre of mass is
// over its base, the convex hull of what touches the desk. Whether the
// clutch between parts can carry the load is Phase 2 (the static solver).
//
// Pure: no DOM, no three.js, no network. Millimetres and grams; this app's
// axes (y up), parts in studs and plates as everywhere in lib.

const STUD_MM = 8, PLATE_MM = 3.2, GAP = 0.1;   // a part is 0.2 mm short of its grid box (0.1 a side)
export const ABS_DENSITY = 1.05;                 // g/cm³, moulded ABS (about 1.03–1.06)
const WALL = 1.2, TOP = 1.0;                     // mm: side walls and the top under the studs
const STUD = { r: 2.4, h: 1.7 };                 // a stud: 4.8 mm across, 1.7 mm tall
const TUBE = { ro: 3.255, ri: 2.4 };             // the tube between four studs (2-wide parts)
const BAR = { r: 1.6 };                          // the bar between two studs (1-wide parts)
// Shapes that fill less of their box than a brick (a slope is about half).
const FILL = { slope: 0.6, round: 0.8, fence: 0.5, 'tree-round': 0.5, 'tree-pine': 0.45, leaves: 0.35, flower: 0.35, bush: 0.4 };
// A part known only by its bounds (a figure's piece, a hinge turned freely):
// what a brick fills of its box.
const BOUNDS_FILL = 0.43;

// A hollow brick-shaped part, w × d studs, h plates: its volume (mm³) and the
// height of its centre of mass above its underside (mm).
function hollow(w, d, h, studs) {
  const X = w * STUD_MM - 2 * GAP, Z = d * STUD_MM - 2 * GAP, H = h * PLATE_MM;
  const inner = Math.max(0, H - TOP);
  const pieces = [];                                                        // [volume, centre height]
  pieces.push([X * Z * Math.min(TOP, H), H - Math.min(TOP, H) / 2]);        // the top
  const walls = X * Z - Math.max(0, X - 2 * WALL) * Math.max(0, Z - 2 * WALL);
  pieces.push([walls * inner, inner / 2]);                                  // the four sides
  if (studs) pieces.push([w * d * Math.PI * STUD.r ** 2 * STUD.h, H + STUD.h / 2]);
  const tubes = w >= 2 && d >= 2 ? (w - 1) * (d - 1) : 0, bars = Math.min(w, d) === 1 ? Math.max(w, d) - 1 : 0;
  if (tubes) pieces.push([tubes * Math.PI * (TUBE.ro ** 2 - TUBE.ri ** 2) * inner, inner / 2]);
  if (bars) pieces.push([bars * Math.PI * BAR.r ** 2 * inner, inner / 2]);
  const v = pieces.reduce((s, [a]) => s + a, 0);
  return { v, cy: v ? pieces.reduce((s, [a, y]) => s + a * y, 0) / v : H / 2 };
}

// The volume of a closed triangle mesh (mm³), by the divergence theorem.
// `positions` flat [x, y, z, …]; `index` optional. An open or inconsistently
// wound mesh gives a wrong number: callers check it against the part's box.
export function meshVolume(positions, index = null) {
  const n = index ? index.length : positions.length / 3;
  let s = 0;
  for (let t = 0; t + 2 < n; t += 3) {
    const a = 3 * (index ? index[t] : t), b = 3 * (index ? index[t + 1] : t + 1), c = 3 * (index ? index[t + 2] : t + 2);
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2], bx = positions[b], by = positions[b + 1], bz = positions[b + 2], cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    s += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(s) / 6;
}

// A mesh's volume is trusted when it is a plausible share of the part's box
// (an open LDraw shape can come out near zero or larger than the box).
const plausible = (v, box) => v > 0.15 * box && v < 1.05 * box;
// LDraw draws walls and tops 4 LDU (1.6 mm) thick, more than moulded parts,
// so its shapes come out heavy: 3001 2.93 g, 3020 1.51 g, 3005 0.53 g, where
// the real parts weigh 2.32, 1.13 and 0.44 g. Scaled by their mean ratio.
const MESH_SCALE = 0.79;

// The box a part takes up (mm), written into `b`: [x0, y0, z0, x1, y1, z1].
function boxOf(p, b = new Array(6)) {
  if (p.origin && p.extent) { const e = p.extent; b[0] = (p.x + e[0]) * STUD_MM; b[1] = (p.y + e[1]) * PLATE_MM; b[2] = (p.z + e[2]) * STUD_MM; b[3] = (p.x + e[3]) * STUD_MM; b[4] = (p.y + e[4]) * PLATE_MM; b[5] = (p.z + e[5]) * STUD_MM; return b; }
  if (p.origin || !(p.w > 0 && p.d > 0 && p.h > 0)) { b[0] = (p.x - 0.5) * STUD_MM; b[1] = (p.y - 4) * PLATE_MM; b[2] = (p.z - 0.5) * STUD_MM; b[3] = (p.x + 0.5) * STUD_MM; b[4] = p.y * PLATE_MM; b[5] = (p.z + 0.5) * STUD_MM; return b; }
  const turned = p.rotation === 90 || p.rotation === 270, fx = turned ? p.d : p.w, fz = turned ? p.w : p.d;
  b[0] = (p.x - fx / 2) * STUD_MM; b[1] = p.y * PLATE_MM; b[2] = (p.z - fz / 2) * STUD_MM; b[3] = (p.x + fx / 2) * STUD_MM; b[4] = (p.y + p.h) * PLATE_MM; b[5] = (p.z + fz / 2) * STUD_MM;
  return b;
}

// The hollow() of a part's kind, kept: a model uses the same few dozen kinds
// over and over (by id, then checked against its size, shape and studs).
const kinds = new Map();
function kindOf(p) {
  const studs = p.studs !== false;
  let list = kinds.get(p.id);
  if (!list) kinds.set(p.id, (list = []));
  for (const k of list) if (k.w === p.w && k.d === p.d && k.h === p.h && k.shape === p.shape && k.studs === studs) return k;
  const h = hollow(p.w, p.d, p.h, studs), k = { w: p.w, d: p.d, h: p.h, shape: p.shape, studs, v: h.v * (FILL[p.shape] ?? 1), cy: h.cy, studV: studs ? p.w * p.d * Math.PI * STUD.r ** 2 * STUD.h : 0 };
  list.push(k);
  return k;
}

// A part's volume (mm³) and centre height (mm) into `out`, from its box `b`; returns where the volume came from.
function measure(p, b, volumes, out) {
  const boxV = (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]);
  let from, extra = 0;
  if (p.origin || !(p.w > 0 && p.d > 0 && p.h > 0)) { out.v = boxV * BOUNDS_FILL; out.cy = (b[1] + b[4]) / 2; from = 'bounds'; }
  else { const k = kindOf(p); out.v = k.v; out.cy = b[1] + k.cy; extra = k.studV; from = 'box'; }
  const mesh = volumes ? volumes.get(p.id) : 0;
  if (mesh && plausible(mesh, boxV + extra)) { out.v = mesh * MESH_SCALE; from = 'shape'; }
  return from;
}

// One part: { grams, centre [x, y, z] mm, from: 'shape' | 'box' | 'bounds' }.
// `volumes`: optional Map of part id → mm³ from its LDraw shape.
export function partMass(p, volumes = null) {
  const b = boxOf(p), out = {}, from = measure(p, b, volumes, out);
  return { grams: (out.v / 1000) * ABS_DENSITY, centre: [(b[0] + b[3]) / 2, out.cy, (b[2] + b[5]) / 2], from };
}

// The convex hull of points [[x, z], …], anticlockwise (monotone chain).
function hull(pts) {
  const P = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of P) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), p) <= 1e-9) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), p) <= 1e-9) hi.pop(); hi.push(p); }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

// How far a point is inside a convex polygon (mm): positive inside (to the
// nearest edge), negative outside (to the polygon).
function margin([x, z], poly) {
  let near = Infinity, inside = poly.length >= 3;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const ex = bx - ax, ez = bz - az, L = ex * ex + ez * ez;
    if ((ex * (z - az) - ez * (x - ax)) < 0) inside = false;              // right of an anticlockwise edge: outside
    const t = L ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L)) : 0;
    near = Math.min(near, Math.hypot(x - ax - t * ex, z - az - t * ez));
  }
  return inside ? near : -near;
}

// The model's weight and balance: { grams, pieces, centre [x, y, z] mm,
// base [[x, z], …] mm (the hull on the desk), desk (mm, its height), margin
// (mm: how far the centre is inside the base, negative past it), tips,
// fromShape (parts whose volume came from their LDraw shape), estimate: true }.
// Spares lying loose on the desk are not part of the model.
export function statics(model, { volumes = null } = {}) {
  const parts = model.parts ?? [], n = parts.length;
  let g = 0, mx = 0, my = 0, mz = 0, fromShape = 0, desk = Infinity;
  // (one pass, no garbage per part: the mosaic has 16,500 parts and this runs after every edit)
  const boxes = new Float64Array(n * 6), b = new Array(6), out = { v: 0, cy: 0 };
  for (let i = 0; i < n; i++) {
    const p = parts[i];
    boxOf(p, b);
    if (measure(p, b, volumes, out) === 'shape') fromShape++;
    const m = out.v;
    g += m; mx += m * (b[0] + b[3]) / 2; my += m * out.cy; mz += m * (b[2] + b[5]) / 2;
    for (let j = 0; j < 6; j++) boxes[i * 6 + j] = b[j];
    if (b[1] < desk) desk = b[1];
  }
  if (!n || !g) return { grams: 0, pieces: 0, centre: null, base: [], desk: 0, margin: 0, tips: false, fromShape: 0, estimate: true };
  const centre = [mx / g, my / g, mz / g];
  // What stands on the desk: every part whose underside is at the lowest
  // level. Of the corners along one line across the desk, only the two ends
  // can be on the hull.
  const ends = new Map();                                                   // z → [least x, most x]
  const corner = (x, z) => { const e = ends.get(z); if (!e) ends.set(z, [x, x]); else { if (x < e[0]) e[0] = x; if (x > e[1]) e[1] = x; } };
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    if (boxes[o + 1] - desk >= 0.5) continue;
    corner(boxes[o] + GAP, boxes[o + 2] + GAP); corner(boxes[o + 3] - GAP, boxes[o + 2] + GAP);
    corner(boxes[o] + GAP, boxes[o + 5] - GAP); corner(boxes[o + 3] - GAP, boxes[o + 5] - GAP);
  }
  const base = hull([...ends].flatMap(([z, [x0, x1]]) => (x0 === x1 ? [[x0, z]] : [[x0, z], [x1, z]])));
  const m = margin([centre[0], centre[2]], base);
  const r = (v) => Math.round(v * 10) / 10;
  return { grams: (g / 1000) * ABS_DENSITY, pieces: n, centre: centre.map(r), base, desk, margin: r(m), tips: m < -0.05, fromShape, estimate: true };
}

// Grams for people: "2.3 g", "148 g", "1.24 kg".
export function formatMass(g) {
  if (g < 10) return `${(Math.round(g * 10) / 10).toFixed(1)} g`;
  if (g < 1000) return `${Math.round(g)} g`;
  return `${(g / 1000).toFixed(g < 10000 ? 2 : 1)} kg`;
}
