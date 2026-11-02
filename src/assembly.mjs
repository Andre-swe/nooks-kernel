// The agent runtime's model: assemblies of parts placed by their connectors, as BrickAgent builds them (a port of
// its model.py, reflection.py, export.py and check.py; MIT, Kulits 2026), on BrickNet's connector data
// (lib/bricknet.mjs) and our parts. Pure: the caller passes the tables.
//
//   const a = new Assembly('bridge');
//   const left = a.add('brick 1x1', { color: 'tan' });
//   const right = a.add('brick 1x1', { pose: at(2), color: 'tan' });
//   const span = a.attach('plate 1x3', { to: left.c('stud', 0), by: ['hole', 0], orient: ID, color: 'red' });
//   check(a, { contacts: [[span.c('hole', 2), right.c('stud', 0)]] });
//
// LDraw units and axes (-y up). An occurrence is a placement in its parent assembly; a connector is a path of
// occurrences from an assembly down to a part, and the part's native connector index. Assemblies placed more than
// once share their definition, and are written as MPD submodels (the workbench's sub-builds).
import { ID, compose, inverse, apply, mul3, dir } from './pose.mjs';
import { resolve, partOf, connectorsOf, addresses, compatible, placement, NoMate } from './bricknet.mjs';

let keys = 0;

export class Occurrence {
  constructor(parent, what, pose = ID, color = null, index = 0) {
    this.parent = parent; this.what = what; this.pose = pose; this.color = color; this.index = index; this.key = ++keys;
  }
  get location() { return `${this.parent?.name ?? 'part'}[${this.index}]`; }
  get isPart() { return typeof this.what === 'string'; }
  // A connector of this part by type and typed index: c('stud', 0).
  c(type, index = 0) {
    if (!this.isPart) throw new NoMate('A copy of an assembly gives its connectors through ref(the connector it returned).');
    const T = tablesOf(this);
    const list = connectorsOf(T, this.what, type);
    const k = index < 0 ? list.length + index : index;
    if (!list[k]) throw new NoMate(`${this.what}: no ${type}[${index}]; its connectors: ${addresses(T, this.what)}`);
    return new Connector([this], list[k].i, T);
  }
  // The connector of a type nearest a point (in this occurrence's parent's frame).
  near(type, point) {
    const T = tablesOf(this);
    const all = connectorsOf(T, this.what, type).map((x) => new Connector([this], x.i, T));
    if (!all.length) throw new NoMate(`${this.what}: no ${type}; its connectors: ${addresses(T, this.what)}`);
    return all.reduce((best, x) => (dist2(x.at, point) < dist2(best.at, point) ? x : best));
  }
  // This placement reflected through its parent's plane `axis` = `about`, detached, for add().
  mirror(axis = 'x', { about = [0, 0, 0], name = null } = {}) { return mirrorOf(this, axis, about, name); }
  // A connector inside this copy of an assembly, from a reference into its definition.
  ref(reference) {
    if (this.isPart) throw new NoMate('ref() is for copies of assemblies; a part has c(type, index).');
    const bound = this.what.connector(reference);
    return new Connector([this, ...bound.path], bound.i, bound.T);
  }
}
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const tablesOf = (occ) => { let a = occ.parent; return a?.T ?? occ.T; };

export class Connector {
  constructor(path, i, T) { this.path = path; this.i = i; this.T = T; }
  get stem() { return this.path.at(-1).what; }
  get conn() { return partOf(this.T, this.stem).conns[this.i]; }
  get type() { return this.conn.type; }
  get index() { return this.conn.index; }
  get address() { return `${this.type}[${this.index}]`; }
  get kind() { return this.conn.kind; }
  // The frame in the frame of the path's first occurrence's parent.
  get pose() { return this.path.reduceRight((f, occ) => compose(occ.pose, f), this.conn.frame); }
  get at() { return this.pose.t; }
  get axis() { const r = this.pose.r; return [r[1], r[4], r[7]]; }
  get where() { return `${this.path.map((o) => o.location).join('/')}.${this.address}`; }
}

export class Assembly {
  constructor(name, T) {
    if (typeof name !== 'string' || !name) throw new Error('An assembly needs a name.');
    this.name = name; this.T = T; this.children = []; this.attachments = []; this.mirrored = new Map(); this.subs = new Set();
  }
  // Place a part (number or name), an assembly, or a detached occurrence (a mirror's result) at `pose`.
  add(what, { pose = ID, color = null } = {}) {
    if (what instanceof Occurrence) { pose = compose(pose, what.pose); color = color ?? what.color; what = what.what; }
    if (what instanceof Assembly) {
      if (what === this || definitions(what).has(this)) throw new Error('An assembly cannot contain itself.');
      this.subs.add(what);
    } else what = resolve(this.T, what);
    const child = new Occurrence(this, what, pose, colourCode(this.T, color), this.children.length);
    this.children.push(child);
    return child;
  }
  // Place a part or an assembly by one of its connectors (`by`) meeting `to`, a connector of this assembly.
  // `by` for a part: [type, index] (or left out when only one connector fits); for an assembly: a connector inside
  // it (as its builder returned one). The rest: lib/bricknet.mjs placement.
  attach(what, { to, by = null, color = null, ...opts } = {}) {
    if (!(to instanceof Connector) || !contains(this, to)) throw new NoMate('The target connector must belong to this assembly (bind it through the placed copy).');
    let source;
    if (what instanceof Assembly) {
      if (!(by instanceof Connector)) throw new NoMate('`by` for an assembly is a connector inside it, such as one it returned.');
      source = what.connector(by);
    } else {
      const stem = resolve(this.T, what);
      if (by) {
        const [type, index] = by;
        const list = connectorsOf(this.T, stem, type);
        const k = index < 0 ? list.length + index : index;
        if (!list[k]) throw new NoMate(`${stem}: no ${type}[${index}]; its connectors: ${addresses(this.T, stem)}`);
        source = new Connector([new Occurrence(null, stem)], list[k].i, this.T);
      } else {
        const fits = connectorsOf(this.T, stem).filter((x) => compatible(to.conn, x));
        if (fits.length !== 1) throw new NoMate(`${stem}: choose by: [type, index]; compatible connectors: ${fits.map((x) => `${x.type}[${x.index}]`).join(', ') || 'none'}`);
        source = new Connector([new Occurrence(null, stem)], fits[0].i, this.T);
      }
      what = stem;
    }
    const pose = placement(this.T, { stem: to.stem, conn: to.conn, pose: to.pose }, { stem: source.stem, conn: source.conn, pose: source.pose }, opts);
    const child = this.add(what, { pose, color });
    const bound = what instanceof Assembly ? child.ref(source) : new Connector([child], source.i, this.T);
    this.attachments.push([to, bound]);
    return child;
  }
  // A reference into this definition, mapped through a mirror when this assembly is one.
  connector(reference) {
    if (contains(this, reference)) return reference;
    let model = this; const path = [];
    for (const old of reference.path) {
      const now = model instanceof Assembly ? model.mirrored.get(old.key) : null;
      if (!now) throw new NoMate('The reference must belong to this assembly (or the one it mirrors).');
      path.push(now); model = now.what;
    }
    const map = this.T.mirror[reference.stem]?.[2];
    const i = map ? map[reference.i] : null;
    if (i === null || i === undefined) throw new NoMate(`No mirrored connector for ${reference.where} (${reference.stem}).`);
    return new Connector(path, i, this.T);
  }
  // An independent mirror image (counterpart parts, sharing kept), reflected through the plane `axis` = `about`.
  mirror(axis = 'x', { about = [0, 0, 0], name = null } = {}) { return mirrorOf(this, axis, about, name); }
}

function colourCode(T, c) {
  if (c === null || c === undefined) return null;
  if (Number.isInteger(c)) return c;
  const key = String(c).replace(/[\s_-]/g, '').toLowerCase();
  for (const [n, code] of Object.entries(T.colours)) if (n.replace(/\s/g, '').toLowerCase() === key) return code;
  const words = new Set(String(c).toLowerCase().split(/[\s_-]+/));
  const near = Object.keys(T.colours).filter((n) => n.split(' ').some((w) => words.has(w))).sort((a, b) => a.length - b.length).slice(0, 8);
  throw new NoMate(`No colour named "${c}"; sharing a word: ${near.join(', ') || 'none'}`);
}
export const colour = colourCode;

// Whether a connector's path runs down from this assembly (or occurrence).
function contains(shape, ref) {
  if (shape instanceof Occurrence) return ref.path[0] === shape;
  let children = shape.children;
  for (const occ of ref.path) {
    if (children[occ.index] !== occ) return false;
    children = occ.what instanceof Assembly ? occ.what.children : [];
  }
  return true;
}
function definitions(root) {
  const seen = new Set(), stack = [root];
  while (stack.length) { const a = stack.pop(); if (seen.has(a)) continue; seen.add(a); stack.push(...a.subs); }
  return seen;
}

// ---- mirroring with native counterparts
const LOCAL = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const m4 = (p) => [p.r[0], p.r[1], p.r[2], p.t[0], p.r[3], p.r[4], p.r[5], p.t[1], p.r[6], p.r[7], p.r[8], p.t[2], 0, 0, 0, 1];
const m4mul = (A, B) => [0, 1, 2, 3].flatMap((i) => [0, 1, 2, 3].map((j) => A[i * 4] * B[j] + A[i * 4 + 1] * B[4 + j] + A[i * 4 + 2] * B[8 + j] + A[i * 4 + 3] * B[12 + j]));
const fromM4 = (M) => ({ r: [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]], t: [M[3], M[7], M[11]] });
function counterpart(T, stem) {
  const m = T.mirror[stem];
  if (!m) throw new NoMate(`No verified mirror for ${stem} (${partOf(T, stem).name}).`);
  return [m[0], m[1].flat()];
}
function mirrorOf(source, axis, about, name) {
  const n = typeof axis === 'string' ? [axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0] : axis;
  const len = Math.hypot(...n);
  if (!(len > 1e-12)) throw new Error('mirror needs x, y, z or a plane normal.');
  const u = n.map((v) => v / len), d = 2 * (u[0] * about[0] + u[1] * about[1] + u[2] * about[2]);
  const plane = [1 - 2 * u[0] * u[0], -2 * u[0] * u[1], -2 * u[0] * u[2], d * u[0], -2 * u[1] * u[0], 1 - 2 * u[1] * u[1], -2 * u[1] * u[2], d * u[1], -2 * u[2] * u[0], -2 * u[2] * u[1], 1 - 2 * u[2] * u[2], d * u[2], 0, 0, 0, 1];
  const isAsm = source instanceof Assembly, root = isAsm ? source : source.what;
  const T = isAsm ? source.T : tablesOf(source);
  const memo = new Map();
  const place = (old, reflection) => {
    if (!memo.has(old.what)) memo.set(old.what, counterpart(T, old.what));
    const [what, correction] = memo.get(old.what);
    return [what, fromM4(m4mul(m4mul(reflection, m4(old.pose)), correction))];
  };
  if (root instanceof Assembly) {
    // Definitions children first, so each copy is complete before what uses it.
    const order = [], seen = new Set();
    const visit = (a) => { if (seen.has(a)) return; seen.add(a); for (const s of a.subs) visit(s); order.push(a); };
    visit(root);
    for (const original of order) {
      const result = new Assembly(original === root && name ? name : `${original.name} mirrored`, T);
      for (const old of original.children) {
        const [what, pose] = place(old, original === source ? plane : LOCAL);
        result.children.push(new Occurrence(result, what, pose, old.color, old.index));
      }
      result.subs = new Set([...original.subs].map((s) => memo.get(s)[0]));
      original.children.forEach((old, k) => result.mirrored.set(old.key, result.children[k]));
      result.attachments = original.attachments.map((pair) => pair.map((ref) => result.connector(ref)));
      memo.set(original, [result, LOCAL]);
    }
  }
  if (isAsm) return memo.get(source)[0];
  const [what, pose] = place(source, plane);
  const occ = new Occurrence(null, what, pose, source.color);
  occ.T = T;
  return occ;
}

// ---- flattening, measuring, writing

// Every part in the enclosing frame: [{ stem, color, pose, path, where }].
export function parts(shape) {
  const out = [];
  const walk = (children, parent, colour, path) => {
    for (const child of children) {
      const world = compose(parent, child.pose), tint = child.color === null || child.color === 16 ? colour : child.color;
      const here = [...path, child.location];
      if (child.what instanceof Assembly) walk(child.what.children, world, tint, here);
      else out.push({ stem: child.what, color: tint, pose: world, path: here, where: here.join('/') });
    }
  };
  walk(shape instanceof Assembly ? shape.children : [shape], ID, 16, []);
  return out;
}

// Bounds (lo, hi) in LDU of a part in its own frame, or of a shape's parts in the enclosing frame.
export function measure(shape, T = shape.T) {
  if (typeof shape === 'string') { const b = partOf(T, resolve(T, shape)).bounds; return [b[0], b[1]]; }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts(shape)) for (const corner of corners(partOf(T, p.stem).bounds)) {
    const w = apply(p.pose, corner);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
  }
  return [lo, hi];
}
const corners = ([lo, hi]) => [0, 1, 2, 3, 4, 5, 6, 7].map((m) => [m & 1 ? hi[0] : lo[0], m & 2 ? hi[1] : lo[1], m & 4 ? hi[2] : lo[2]]);

// Authored attachments inside a shape, nested copies included, bound into its frame.
export function attachments(shape) {
  const out = shape instanceof Assembly ? [...shape.attachments] : [];
  const stack = (shape instanceof Assembly ? shape.children : [shape]).map((c) => [c.what, [c]]);
  while (stack.length) {
    const [model, path] = stack.pop();
    if (!(model instanceof Assembly)) continue;
    for (const pair of model.attachments) out.push(pair.map((c) => new Connector([...path, ...c.path], c.i, c.T)));
    for (const child of model.children) stack.push([child.what, [...path, child]]);
  }
  return out;
}

// LDraw: an MPD with every definition as a file (shared copies stay shared), or one flat .ldr. Part numbers are our
// catalogue's (a BrickNet stem that is an alias of ours is written as ours, its transform undone).
export function toLDraw(shape, { flat = false } = {}) {
  const T = shape.T;
  const line = (stem, colour, pose) => {
    const back = T.reverse.get(stem);
    let p = pose, id = stem;
    if (back) { id = back.id; if (back.matrix) p = compose(pose, inverse(fromLDraw12(back.matrix))); }
    return `1 ${colour ?? 16} ${fmt(p.t)} ${fmt(p.r)} ${id}.dat`;
  };
  if (flat || !(shape instanceof Assembly)) return [`0 ${shape.name ?? 'model'}`, ...parts(shape).map((p) => line(p.stem, p.color, p.pose))].join('\n') + '\n';
  const order = [], seen = new Set();
  const visit = (a) => { if (seen.has(a)) return; seen.add(a); for (const s of a.subs) visit(s); order.push(a); };
  visit(shape);
  const names = new Map(order.map((a, k) => [a, `${slug(a.name)}${order.findIndex((b) => slug(b.name) === slug(a.name)) < k ? `-${k}` : ''}.ldr`]));
  const files = [shape, ...order.filter((a) => a !== shape)].map((a) => [
    `0 FILE ${names.get(a)}`, `0 ${a.name}`,
    ...a.children.map((c) => (c.what instanceof Assembly ? `1 ${c.color ?? 16} ${fmt(c.pose.t)} ${fmt(c.pose.r)} ${names.get(c.what)}` : line(c.what, c.color, c.pose))),
    '0 NOFILE',
  ].join('\n'));
  return files.join('\n') + '\n';
}
const fromLDraw12 = (m) => ({ r: m.slice(3, 12), t: m.slice(0, 3) });
const fmt = (v) => v.map((x) => +(+x).toFixed(6)).join(' ');
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model';

// ---- what holds what (BrickNet's pairing rules)
const POS = 3, AXIS = 0.95, AXLE_AXIS = 0.9, AXLE_RAD = 4, AXLE_MIN = 4, FIXED_AXIS = 0.9999, FIXED_TRACE = 2.99;
const ORIENTED = new Set(['0', '1', '2', '3']), A_SIDE = new Set(['socket', 'cross', 'clip']);
const STUD_OK = [['hole', 'open'], ['hole', 'stud'], ['open', 'post'], ['open', 'tube'], ['stud', 'tube']];
const AXLE_OK = [['axle', 'cross'], ['axle', 'socket'], ['bar', 'clip'], ['bar', 'cross'], ['pin', 'socket']];
const okPair = (list, a, b) => list.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

// { edges: [[partA, connA, partB, connB]], components: [[part, …]] largest first } over parts(shape).
export function connections(shape, T = shape.T, flat = parts(shape)) {
  const all = [];
  flat.forEach((p, k) => { for (const c of partOf(T, p.stem).conns) { const f = compose(p.pose, c.frame); all.push({ k, c, pos: f.t, r: f.r, axis: [-f.r[1], -f.r[4], -f.r[7]] }); } });
  // Studs and holes, nearly every connector of a big build, join only within POS of each other: each stud looks
  // for holes in a grid of POS-sized cells. The other kinds (axles reach further) keep a coarser grid of their own.
  // Cells have numeric keys, and a pair's id is made only once it joins, which few do.
  // 16 bits a coordinate keeps the key exact (under 2^48); a build past ±32,768 cells falls back to strings.
  const key = (x, y, z) => (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) < 32768 ? (x + 32768) * 4294967296 + (y + 32768) * 65536 + (z + 32768) : `${x},${y},${z}`);
  const grid = (list, size) => { const cell = new Map(); for (const x of list) { const kk = key(Math.floor(x.pos[0] / size), Math.floor(x.pos[1] / size), Math.floor(x.pos[2] / size)); let l = cell.get(kk); if (!l) cell.set(kk, (l = [])); l.push(x); } return cell; };
  all.forEach((x, g) => { x.g = g; });
  const found = [];
  const holes = grid(all.filter((x) => x.c.kind === 'hole'), POS);
  for (const s of all) {
    if (s.c.kind !== 'stud') continue;
    const bx = Math.floor(s.pos[0] / POS), by = Math.floor(s.pos[1] / POS), bz = Math.floor(s.pos[2] / POS);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const h of holes.get(key(bx + dx, by + dy, bz + dz)) ?? []) {
        if (h.k !== s.k && joins(s, h)) found.push(s.g < h.g ? [s.g, s, h] : [h.g, h, s]);
      }
    }
  }
  const rest = all.filter((x) => x.c.kind !== 'stud' && x.c.kind !== 'hole'), size = 24, cell = grid(rest, size), seen = new Set();
  for (const a of rest) {
    const reach = a.c.kind === 'axle' ? Math.ceil((Math.max(a.c.length, AXLE_RAD) * 2 + 8) / size) : 1;
    const bx = Math.floor(a.pos[0] / size), by = Math.floor(a.pos[1] / size), bz = Math.floor(a.pos[2] / size);
    for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) for (let dz = -reach; dz <= reach; dz++) {
      const list = cell.get(key(bx + dx, by + dy, bz + dz));
      if (!list) continue;
      for (const b of list) {
        if (b.k === a.k || !joins(a, b)) continue;
        const id = a.k < b.k || (a.k === b.k && a.c.i < b.c.i) ? `${a.k}:${a.c.i}|${b.k}:${b.c.i}` : `${b.k}:${b.c.i}|${a.k}:${a.c.i}`;
        if (seen.has(id)) continue;
        seen.add(id); found.push([a.g, a, b]);
      }
    }
  }
  // In the order a single pass over every connector finds them.
  const edges = found.sort((x, y) => x[0] - y[0]).map(([, a, b]) => [a.k, a.c.i, b.k, b.c.i]);
  return { edges, components: groups(flat.length, edges) };
}
function joins(a, b) {
  // The kinds first: most neighbours can't mate at all, and that's cheaper to see than how far apart they are.
  const ka = a.c.kind, kb = b.c.kind;
  if ((ka === 'stud' && kb === 'hole') || (ka === 'hole' && kb === 'stud')) return dist2(a.pos, b.pos) <= POS * POS && okPair(STUD_OK, a.c.sub, b.c.sub) && dot3(a.axis, b.axis) >= AXIS;
  if (ka !== kb || !(ka === 'hinge' || ka === 'ball' || ka === 'fixed' || ka === 'axle')) return false;
  const d = dist2(a.pos, b.pos), adot = dot3(a.axis, b.axis);
  if (ka === 'axle') {
    if (!okPair(AXLE_OK, a.c.sub, b.c.sub) || Math.abs(adot) < AXLE_AXIS) return false;
    const ref = !A_SIDE.has(a.c.sub) || A_SIDE.has(b.c.sub) ? a.axis : b.axis;
    const delta = b.pos.map((v, k) => v - a.pos[k]), proj = dot3(delta, ref);
    const perp2 = dot3(delta, delta) - proj * proj;
    if (perp2 > POS * POS) return false;
    const overlap = Math.max(a.c.length, AXLE_RAD) + Math.max(b.c.length, AXLE_RAD) - Math.abs(proj);
    return !(overlap < AXLE_MIN && Math.sqrt(Math.max(0, POS * POS - perp2)) < AXLE_MIN - overlap - 1e-4);
  }
  if (a.c.sub !== b.c.sub || !['in', 'on'].includes(a.c.pol) || !['in', 'on'].includes(b.c.pol) || a.c.pol === b.c.pol || d > POS * POS) return false;
  if (ka === 'hinge') return Math.abs(adot) >= AXIS;
  if (ka === 'fixed' && ORIENTED.has(a.c.sub) && ORIENTED.has(b.c.sub)) {
    const trace = [0, 1, 2].reduce((s, i) => s + a.r[i] * b.r[i] + a.r[3 + i] * b.r[3 + i] + a.r[6 + i] * b.r[6 + i], 0);
    return adot >= FIXED_AXIS && trace >= FIXED_TRACE;
  }
  return true;
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function groups(n, edges) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (const [a, , b] of edges) parent[find(a)] = find(b);
  const by = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!by.has(r)) by.set(r, []); by.get(r).push(i); }
  return [...by.values()].sort((a, b) => b.length - a.length || a[0] - b[0]);
}

// A flattened part's box in the enclosing frame (LDU): [lo, hi], its bounds turned by its pose.
export function partBox(p, T) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const c of corners(partOf(T, p.stem).bounds)) { const w = apply(p.pose, c); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); } }
  return [lo, hi];
}

// ---- stability: each connected component a rigid body, solved from the ground up
// A component stands when it rests on the ground or on components already standing beneath it, and its centre of
// mass (part bounds as solid boxes, one density) is over the convex hull of where it rests. Static: it catches what
// tips over, floats or is held by nothing, not what would slide off a slope. +y is down.
export function stability(flat, components, T, { tolerance = 0.5 } = {}) {
  const box = flat.map((p) => partBox(p, T));
  const ground = Math.max(...box.map((b) => b[1][1]));
  const comp = new Int32Array(flat.length);
  components.forEach((c, j) => c.forEach((i) => { comp[i] = j; }));
  const order = components.map((c, j) => [j, Math.max(...c.map((i) => box[i][1][1]))]).sort((a, b) => b[1] - a[1]).map(([j]) => j);
  const standing = new Set(), result = [];
  for (const j of order) {
    const c = components[j];
    let mass = 0; const centre = [0, 0, 0];
    for (const i of c) { const [lo, hi] = box[i], v = Math.max(1, (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2])); mass += v; for (let k = 0; k < 3; k++) centre[k] += (v * (lo[k] + hi[k])) / 2; }
    const cx = centre[0] / mass, cz = centre[2] / mass;
    const pts = [];
    let restsOn = null;
    for (const i of c) {
      const [lo, hi] = box[i];
      if (Math.abs(hi[1] - ground) <= tolerance) pts.push([lo[0], lo[2]], [hi[0], lo[2]], [lo[0], hi[2]], [hi[0], hi[2]]);
      for (const o of flat.keys()) {
        if (comp[o] === j || !standing.has(comp[o])) continue;
        const [olo, ohi] = box[o];
        if (Math.abs(hi[1] - olo[1]) > tolerance) continue;
        const x0 = Math.max(lo[0], olo[0]), x1 = Math.min(hi[0], ohi[0]), z0 = Math.max(lo[2], olo[2]), z1 = Math.min(hi[2], ohi[2]);
        if (x1 - x0 > tolerance && z1 - z0 > tolerance) { pts.push([x0, z0], [x1, z0], [x0, z1], [x1, z1]); restsOn ??= o; }
      }
    }
    const lowest = Math.max(...c.map((i) => box[i][1][1]));
    let ok = false, why;
    if (!pts.length) why = Math.abs(lowest - ground) <= tolerance ? 'touches the ground only along an edge' : `${+(ground - lowest).toFixed(2)} LDU above the ground with nothing beneath it`;
    else {
      const margin = inside(hull2(pts), [cx, cz]);
      ok = margin >= -tolerance;
      why = ok ? null : `its weight is ${+(-margin).toFixed(1)} LDU past what holds it up${restsOn !== null ? ` (resting on ${flat[restsOn].where})` : ' (on the ground)'}`;
    }
    if (ok) standing.add(j);
    result.push({ component: j, parts: c, stands: ok, why, centre: [cx, centre[1] / mass, cz] });
  }
  return result.sort((a, b) => a.component - b.component);
}
function hull2(points) {
  const p = [...new Map(points.map((q) => [`${q[0].toFixed(4)},${q[1].toFixed(4)}`, q])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
// Signed distance of a point inside a convex polygon (anticlockwise; positive inside); for a point or a segment, its
// negative distance to it.
function inside(poly, [x, z]) {
  if (poly.length === 1) return -Math.hypot(x - poly[0][0], z - poly[0][1]);
  const seg = (a, b) => { const ex = b[0] - a[0], ez = b[1] - a[1], L = ex * ex + ez * ez, t = L ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L)) : 0; return Math.hypot(x - a[0] - t * ex, z - a[1] - t * ez); };
  if (poly.length === 2) return -seg(poly[0], poly[1]);
  let isIn = true, near = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) isIn = false;
    near = Math.min(near, seg(a, b));
  }
  return isIn ? near : -near;
}

// ---- check
// Throws an Error listing every problem, each naming the parts (as check() in BrickAgent does), or returns the
// flattened parts. `contacts`: extra [a, b] connector pairs that must be joined (a span's far end). `clash(flat)`:
// the caller's collision test (lib/hulls.mjs by our parts' shapes), → [[i, j], …]. `inventory`: lib/benchmark.mjs
// normaliseInventory's shape, by our part ids. `stability`: false for an unfinished subassembly.
export function check(shape, { contacts = [], clash = null, inventory = null, stability: stable = true } = {}) {
  const T = shape.T, flat = parts(shape), graph = connections(shape, T, flat), issues = [];
  const index = new Map(flat.map((p, i) => [p.where, i]));
  const edges = new Set(graph.edges.map(([a, ca, b, cb]) => `${a}:${ca}|${b}:${cb}`));
  const whereOf = (ref) => ref.path.map((o) => o.location).join('/');
  for (const [a, b] of [...attachments(shape), ...contacts]) {
    const ia = index.get(whereOf(a)), ib = index.get(whereOf(b));
    if (ia === undefined || ib === undefined) throw new Error('Required contacts must be connectors of the assembly being checked.');
    if (!edges.has(`${ia}:${a.i}|${ib}:${b.i}`) && !edges.has(`${ib}:${b.i}|${ia}:${a.i}`)) issues.push(`missing connection: ${a.where} to ${b.where}`);
  }
  const label = (i) => `#${i} ${flat[i].stem} (${partOf(T, flat[i].stem).name}) at ${flat[i].where}, (${flat[i].pose.t.map((v) => +v.toFixed(2)).join(', ')}) LDU`;
  const collisions = clash ? clash(flat) : [];
  for (const [a, b] of collisions.slice(0, 12)) issues.push(`collision: ${label(a)} <> ${label(b)}`);
  if (collisions.length > 12) issues.push(`…and ${collisions.length - 12} more colliding pairs`);
  if (inventory) {
    const used = new Map();
    for (const p of flat) { const id = T.reverse.get(p.stem)?.id ?? p.stem, k = `${id}|${p.color}`; used.set(k, (used.get(k) ?? 0) + 1); }
    for (const [k, n] of used) {
      const [id, c] = k.split('|'), allowed = inventory[id];
      if (allowed === null) continue;
      const limit = allowed === undefined ? 0 : allowed[c] === undefined ? 0 : allowed[c];
      if (limit !== null && n > limit) issues.push(`inventory: ${id} in colour ${c}: ${n} used, ${limit} available`);
    }
  }
  let standing = null;
  if (stable && !collisions.length) {
    standing = stability(flat, graph.components, T);
    for (const s of standing) if (!s.stands) issues.push(`unstable component (${s.parts.length} part${s.parts.length > 1 ? 's' : ''}, ${label(s.parts[0])}): ${s.why}`);
  }
  if (issues.length) {
    const head = `${flat.length} parts; ${collisions.length} colliding pairs; ${graph.components.length} connected components${stable && collisions.length ? '; stability not tested until the collisions are resolved' : ''}`;
    const e = new Error([head, ...issues].join('\n'));
    e.issues = issues; e.flat = flat;
    throw e;
  }
  return { parts: flat, components: graph.components.length, standing };
}
