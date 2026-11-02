// Tested Brain Flakes construction techniques. Each one is generated as a
// reusable `define` op from the compiler's own slot frames, so an agent can
// paste it into a program and place copies with `instance`. Pure: no DOM,
// no network; the same input gives the same program.
import { runBrainflakesProgram, slotWorld, approximateCollisions } from './brainflakes-program.mjs';
import { inspectBrainflakesParts, checkBrainflakesSymmetry } from './brainflakes-inspect.mjs';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
const dirOf = deg => [Math.cos(deg * Math.PI / 180), 0, Math.sin(deg * Math.PI / 180)];

// Attach `name` to the free slot of `from` that points most nearly along
// `want`, joining by the child's slot 4 so its slot 0 continues straight on.
// Among equally good choices, prefer the child pose whose normal is most
// nearly along `face` (when given).
function toward(def, ops, from, want, name, { color, face = null } = {}) {
  const base = runBrainflakesProgram({ ops }, def).model;
  let best = null;
  for (let slot = 0; slot < 8; slot++) {
    if (base.connections.some(e => (e.a.id === from && e.a.slot === slot) || (e.b.id === from && e.b.slot === slot))) continue;
    const s = dot(slotWorld(base, def, from, slot).outward, want);
    if (best && s < best.s - 1e-9) continue;
    for (const pose of [0, 1]) {
      const op = { op: 'attach', name, to: `${from}.slot[${slot}]`, by: 4, pose, ...(color ? { color } : {}) };
      const run = runBrainflakesProgram({ ops: [...ops, op] }, def);
      if (run.errors.length) continue;
      const d = run.model.discs.find(x => x.id === name);
      const f = face ? Math.abs(dot([d.pose.r[2], d.pose.r[5], d.pose.r[8]], face)) : 0;
      if (!best || s > best.s + 1e-9 || f > best.f + 1e-9) best = { s, f, op };
    }
  }
  if (!best || best.s < 0.99) throw new Error(`No slot of ${from} points that way.`);
  ops.push(best.op);
}

// A straight run along +X. Discs alternate flat and upright; centres stay on
// one line 19.79 mm apart.
function beam(def, { length = 5, color } = {}) {
  const ops = [{ op: 'disc', name: 'b1', ...(color ? { color } : {}) }];
  for (let i = 2; i <= length; i++) toward(def, ops, `b${i - 1}`, [1, 0, 0], `b${i}`, { color });
  return ops;
}

// A vertical post rising from a flat foot disc. Each disc above the foot
// stands upright, turning 90° about the vertical from the one below.
function post(def, { height = 4, color } = {}) {
  const ops = [{ op: 'disc', name: 'foot', ...(color ? { color } : {}) }];
  toward(def, ops, 'foot', [1, 0, 0], 'p1', { color });
  for (let i = 2; i <= height; i++) toward(def, ops, `p${i - 1}`, [0, 0, 1], `p${i}`, { color });
  return ops;
}

// A flat grid of discs (normal ±Z) every 39.58 mm, joined by upright links;
// interior squares are closed so the panel is one rigid piece. Links reach
// about 16 mm above and below the panel plane.
function panel(def, { width = 3, depth = 3, color, linkColor } = {}) {
  const ops = [{ op: 'disc', name: 'f1_1', ...(color ? { color } : {}) }];
  const lc = linkColor ?? color;
  for (let i = 2; i <= width; i++) {
    toward(def, ops, `f${i - 1}_1`, [1, 0, 0], `x${i - 1}_1`, { color: lc });
    toward(def, ops, `x${i - 1}_1`, [1, 0, 0], `f${i}_1`, { color, face: [0, 0, 1] });
  }
  for (let i = 1; i <= width; i++) for (let j = 2; j <= depth; j++) {
    toward(def, ops, `f${i}_${j - 1}`, [0, 1, 0], `y${i}_${j - 1}`, { color: lc });
    toward(def, ops, `y${i}_${j - 1}`, [0, 1, 0], `f${i}_${j}`, { color, face: [0, 0, 1] });
  }
  // Remaining X links between rows above the first, closed onto the neighbour.
  for (let j = 2; j <= depth; j++) for (let i = 2; i <= width; i++) {
    toward(def, ops, `f${i - 1}_${j}`, [1, 0, 0], `x${i - 1}_${j}`, { color: lc });
  }
  ops.push({ op: 'close' });
  return ops;
}

// A curve in the vertical XZ plane. Every other disc lies in that plane and
// turns the heading by 45°, so `turns` × 45° of arc uses 2 × turns + 3 discs.
function arc(def, { turns = 4, startDeg = 0, color } = {}) {
  const ops = [{ op: 'disc', name: 'a0', spin: [['x', 90]], ...(color ? { color } : {}) }];
  let heading = startDeg, n = 0;
  // Only a disc lying in the arc's plane has slots at 45° within it, so the
  // heading changes when leaving an in-plane disc; the perpendicular disc
  // after it can only carry straight on to the next in-plane disc.
  for (let t = 0; t <= turns; t++) {
    toward(def, ops, `a${n}`, dirOf(heading), `a${n + 1}`, { color }); n++;
    toward(def, ops, `a${n}`, dirOf(heading), `a${n + 1}`, { color, face: [0, 1, 0] }); n++;
    heading += 45;
  }
  return ops;
}

// A solid volume on a 19.79 mm lattice, width × depth × height cells along
// X, Y and Z. Grown breadth-first from the corner: a disc reaches a
// neighbouring cell only through a slot pointing at it, and a placement is
// skipped when the approximate collision screen rejects both poses, so about
// three quarters of the cells are filled. `close` then joins every other
// lined-up pair, so the block is one rigid, interlocked piece.
function block(def, { width = 3, depth = 3, height = 3, color } = {}) {
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], size = [width, depth, height];
  const ops = [{ op: 'disc', name: 'c0_0_0', ...(color ? { color } : {}) }];
  const placed = new Map([['0,0,0', 'c0_0_0']]), queue = [[0, 0, 0]];
  let model = runBrainflakesProgram({ ops }, def).model;
  while (queue.length) {
    const cell = queue.shift(), from = placed.get(cell.join(','));
    for (const d of dirs) {
      const next = cell.map((v, k) => v + d[k]);
      if (next.some((v, k) => v < 0 || v >= size[k]) || placed.has(next.join(','))) continue;
      let slot = -1;
      for (let s = 0; s < 8 && slot < 0; s++)
        if (dot(slotWorld(model, def, from, s).outward, d) > 0.99 && !model.connections.some(e => (e.a.id === from && e.a.slot === s) || (e.b.id === from && e.b.slot === s))) slot = s;
      if (slot < 0) continue;
      const name = `c${next.join('_')}`;
      for (const pose of [0, 1]) {
        const op = { op: 'attach', name, to: `${from}.slot[${slot}]`, by: 4, pose, ...(color ? { color } : {}) };
        const run = runBrainflakesProgram({ ops: [...ops, op] }, def);
        if (run.errors.length || approximateCollisions(run.model, def, { only: new Set([name]), limit: 1 }).length) continue;
        ops.push(op); model = run.model; placed.set(next.join(','), name); queue.push(next);
        break;
      }
    }
  }
  ops.push({ op: 'close' });
  return ops;
}

// The one lattice every block lies on (measured from the compiler: a seated
// pair's centres are LATTICE_MM apart, and each disc centre is 1.25 mm above
// its grid point). Cell parity fixes which way a disc faces; two parity
// classes never hold a disc. The disc's eight-fold symmetry makes these one
// pose per class, so any set of cells fills the same way and `close` joins
// every neighbouring pair.
export const LATTICE_MM = 19.78809858668763;
const LATTICE_POSE = { '000': [1,0,0,0,1,0,0,0,1], '111': [0,1,0,1,0,0,0,0,-1], '010': [0,0,1,1,0,0,0,1,0], '101': [0,0,1,0,-1,0,1,0,0], '011': [0,1,0,0,0,1,1,0,0], '100': [1,0,0,0,0,-1,0,1,0] };
const parity = c => c.map(v => ((v % 2) + 2) % 2).join('');
export const LATTICE_NOTE = 'Cells [i,j,k] are 19.788 mm apart along X, Y, Z; cell parity (i,j,k mod 2) decides the disc: 000 and 111 lie flat (face up), 010 and 101 face ±X, 011 and 100 face ±Y, 001 and 110 are always empty. A disc on a side of the shape faces outward only where its parity faces that axis: colour those cells for eyes, patches and markings.';

// Any set of lattice cells, filled as one interlocked solid: the shape is the
// agent's, the lattice is the compiler's. Cells may carry a colour. With
// `shell`, only cells within that many steps (city-block) of the outside are
// kept: a hollow, lighter piece that still interlocks (2 is the thinnest that
// holds together, because two parity classes are always empty).
function sculpt(def, { cells = [], color, shell = 0 } = {}) {
  if (shell) {
    const inside = new Set(cells.map(c => c.slice(0, 3).join(',')));
    const nearOutside = ([x, y, z]) => {
      for (let i = -shell; i <= shell; i++) for (let j = -shell; j <= shell; j++) for (let k = -shell; k <= shell; k++)
        if (Math.abs(i) + Math.abs(j) + Math.abs(k) <= shell && !inside.has(`${x + i},${y + j},${z + k}`)) return true;
      return false;
    };
    cells = cells.filter(c => nearOutside(c));
  }
  // A repeated cell keeps its first position and its last colour.
  const ops = [], tints = new Map(cells.map(c => [c.slice(0, 3).join(','), c[3] ?? color])), seen = new Set();
  for (const cell of cells) {
    const c = cell.slice(0, 3), r = LATTICE_POSE[parity(c)], key = c.join(',');
    if (!r || seen.has(key)) continue;
    seen.add(key);
    const t = c.map((v, a) => v * LATTICE_MM + (a === 2 ? def.midplane : 0) - r[3 * a + 2] * def.midplane);
    const name = 'c' + c.map(v => v < 0 ? 'm' + -v : v).join('_'), tint = tints.get(key);
    ops.push({ op: 'disc', name, transform: { r, t }, ...(tint ? { color: tint } : {}) });
  }
  if (!ops.length) throw new Error('sculpt needs cells that can hold a disc (not parity 001 or 110).');
  ops.push({ op: 'close' });
  return ops;
}

function connectedGroups(model) {
  const adj = new Map(model.discs.map(d => [d.id, []])), seen = new Set(), out = [];
  for (const e of model.connections) { adj.get(e.a.id).push(e.b.id); adj.get(e.b.id).push(e.a.id); }
  for (const id of adj.keys()) if (!seen.has(id)) { const g = [id]; seen.add(id); for (let i = 0; i < g.length; i++) for (const n of adj.get(g[i])) if (!seen.has(n)) { seen.add(n); g.push(n); } out.push(g); }
  return out;
}

// Eight discs around a hub, all upright: a rosette, wheel or flower head.
function ring(def, { color, hubColor } = {}) {
  return [{ op: 'disc', name: 'hub', ...(hubColor ?? color ? { color: hubColor ?? color } : {}) },
    { op: 'ring', prefix: 'r', to: 'hub', slots: [0, 1, 2, 3, 4, 5, 6, 7], by: 0, pose: 0, ...(color ? { color } : {}) }];
}

export const BRAINFLAKES_TECHNIQUES = {
  beam: { build: beam, params: { length: [2, 20] }, summary: 'Straight run along +X; discs alternate flat and upright on one line, 19.79 mm apart. Use for limbs, rails, beams and edges.' },
  post: { build: post, params: { height: [1, 20] }, summary: 'Vertical column on a flat foot disc; upright discs stacked 19.79 mm apart. Use for legs, pillars, masts and supports.' },
  panel: { build: panel, params: { width: [2, 6], depth: [2, 6] }, summary: 'Flat rigid grid of discs every 39.58 mm joined by upright links. Lay flat for decks, floors and bases; turn it upright (spin) for walls and torsos.' },
  arc: { build: arc, params: { turns: [1, 8], startDeg: [-180, 180] }, summary: 'Planar curve in the XZ plane turning 45° every two discs; turns: 4 ends heading back the way it started (a half circle). Use for arches, curved backs, tails and wheels.' },
  block: { build: block, params: { width: [2, 5], depth: [2, 5], height: [2, 5] }, summary: 'Solid interlocked volume on a 19.79 mm lattice (width × depth × height cells along X, Y, Z; about 3/4 of cells filled). Use for bodies, heads, torsos, piers, towers and anything that must look solid from every side. Odd width and depth (3, 5) are mirror-symmetric about the block centre; even sizes are not, because disc orientation alternates through the lattice. Attach limbs at the listed faces (or with toward) so both sides match.' },
  sculpt: { build: sculpt, params: { cells: 'list of [i,j,k] or [i,j,k,"colour"], up to 6000', shell: [1, 10] }, summary: 'Any shape you choose as a set of lattice cells, filled as one interlocked solid (bodies, heads, necks and limbs in one piece, tapered or curved). shell: 2 keeps only a two-cell skin, hollow and far lighter, still one interlocked piece. Cells of parity 001 and 110 stay empty. Disc names are c<i>_<j>_<k> (negatives as m1). Blocks and sculpts share one lattice, so separate pieces placed without moving them join with close.' },
  ring: { build: ring, params: {}, summary: 'Hub with eight upright discs around it. Use for flowers, wheels, rosettes, heads and round details.' },
};

// Returns { name, summary, define, discs, bounds } for one technique, or
// throws for an unknown name or out-of-range parameter.
export function brainflakesTechnique(def, name, params = {}, { as = name } = {}) {
  const t = BRAINFLAKES_TECHNIQUES[name];
  if (!t) throw new Error(`Unknown technique ${name}. Known: ${Object.keys(BRAINFLAKES_TECHNIQUES).join(', ')}.`);
  for (const [k, v] of Object.entries(params)) {
    if (k === 'color' || k === 'linkColor' || k === 'hubColor') continue;
    if (name === 'sculpt' && k === 'cells') {
      if (!Array.isArray(v) || !v.length || v.length > 6000 || v.some(c => !Array.isArray(c) || c.length < 3 || c.length > 4 || c.slice(0, 3).some(x => !Number.isInteger(x) || Math.abs(x) > 100) || (c.length === 4 && typeof c[3] !== 'string'))) throw new Error('sculpt.cells is a list of up to 6000 [i,j,k] or [i,j,k,"colour"] with integers from -100 to 100.');
      continue;
    }
    const range = t.params[k];
    if (!range || !Number.isInteger(v) || v < range[0] || v > range[1]) throw new Error(`${name}.${k} must be an integer from ${range?.[0]} to ${range?.[1]}.`);
  }
  const ops = t.build(def, params);
  const run = runBrainflakesProgram({ ops }, def);
  if (run.errors.length) throw new Error(`Technique ${name} failed: ${run.errors[0].message}`);
  // A sculpt whose cells only touch through always-empty cells falls apart:
  // name the skipped cells and the pieces now, not when the define fails.
  if (name === 'sculpt') {
    const groups = connectedGroups(run.model), skipped = params.cells.filter(c => !LATTICE_POSE[parity(c.slice(0, 3))]).map(c => c.slice(0, 3));
    if (groups.length > 1) throw new Error(`sculpt cells form ${groups.length} separate pieces${skipped.length ? ` once the always-empty cells (parity 001 or 110) are left out: ${JSON.stringify(skipped.slice(0, 12))}` : ''}. Pieces: ${groups.map(g => g.slice(0, 6).join(' ') + (g.length > 6 ? ' …' : '')).join(' | ')}. Add cells that link them.`);
  }
  const lo =[Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const d of run.model.discs) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], d.pose.t[k]); hi[k] = Math.max(hi[k], d.pose.t[k]); }
  const r = v => v.map(x => Math.round(x * 100) / 100);
  // Attachment faces: free slots pointing straight out of each side, on the
  // outermost discs of that side, so copies can be joined with `toward`.
  const parts = inspectBrainflakesParts(run.model, def), faces = {};
  for (const [label, axis, sign] of [['+x', 0, 1], ['-x', 0, -1], ['+y', 1, 1], ['-y', 1, -1], ['+z', 2, 1], ['-z', 2, -1]]) {
    const edge = Math.max(...parts.map(p => sign * p.center[axis]));
    faces[label] = parts.filter(p => sign * p.center[axis] > edge - 5).flatMap(p => p.slots
      .filter(sl => sl.free && sign * sl.outward[axis] > 0.99).map(sl => ({ ref: `${p.id}.slot[${sl.slot}]`, disc: p.id, atMm: r(sl.at) })));
  }
  // Mirror symmetry of the local assembly about its own centre planes.
  const mid = [0, 1, 2].map(k => parts.reduce((sum, p) => sum + p.center[k], 0) / parts.length);
  const symmetric = Object.fromEntries(['x', 'y'].map((axis, k) => [axis, checkBrainflakesSymmetry(run.model, def, { axis, coordinate: mid[k], tolerance: 0.5, colors: false }).passed]));
  return { name, summary: t.summary, define: { op: 'define', name: as, ops }, discs: run.model.discs.length,
    connections: run.model.connections.length, centreBoundsMm: { min: r(lo), max: r(hi) }, centreMm: r(mid), mirrorSymmetric: symmetric, faces, lattice: LATTICE_NOTE, facesNote: 'Refs are inside the definition: after { op: "instance", name: "torso", of: "' + as + '" }, c1_0_0.slot[6] becomes torso-c1_0_0.slot[6]. Positions are in the definition frame.',
    parts: run.model.discs.map(d => d.id) };
}
