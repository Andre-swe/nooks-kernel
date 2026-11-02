// Placing a held part by its connectors, in any orientation (Phase 1, docs/
// PHASE1_CONTRACTS.md §10 D). The grid path (lib/place.mjs) puts bricks on
// studs when they are upright; this is for what it cannot do: a plate on a part
// tilted on a hinge, a Technic pin into a beam, a bar into a clip. A held
// connector is set on a free connector of the model that `mate` accepts (axes
// opposite, positions together), the whole held group moving as one, and each
// way of doing that is checked (nothing in the way, what it would hold to) and
// ranked. Pure: no DOM; the caller loads the tables.
//
// Positions are millimetres in the model (studs × 8, plates × 3.2).
import { freeForm, fromFree, worldBox } from './studio.mjs';
import { frameOf } from './frames.mjs';
import { connectorsOf, mate } from './connectors.mjs';

const STUD = 8, PLATE = 3.2;
const REACH = 24;                // mm: targets this near the pointer (three studs)
const SIDE = 6;                  // mm: a joint this near the pointer is being aimed at
const KEEP = 12, TRY = 40, TARGETS = 24, GROUP = 60;
const CELL = 2, STEP = 3;        // the spatial hash: as lib/graph.mjs
const NONE = { cx: 0, cz: 0, minY: 0, slopeTurn: 0 };
// What each kind goes with (the genders are asked of `mate`). Kinds that turn freely are tried at the
// hinge's own clicks, the rest in quarter turns.
const GOES = { stud: ['antistud'], antistud: ['stud'], pin: ['hole'], hole: ['pin', 'axle'], axle: ['hole', 'axlehole'], axlehole: ['axle'], bar: ['clip'], clip: ['bar'], finger: ['finger'], ball: ['socket'], socket: ['ball'] };
const FREE_SPIN = new Set(['bar', 'clip', 'finger', 'ball', 'socket']);
const BOTH_WAYS = new Set(['pin', 'hole', 'axle', 'axlehole', 'bar', 'clip', 'finger']);   // (these mate with their axes parallel as well as opposite)
const ODD_ROWS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]);   // connectors.json kinds that are neither studs, antistuds nor generic snaps

// What a part of the model costs to know, kept while the part stays as it was (the workbench moves parts in
// place, so each use checks the pose): its box, and its connectors for the tables they were made with.
const info = new WeakMap();
const FIELDS = ['id', 'x', 'y', 'z', 'w', 'd', 'h', 'rotation', 'shape', 'origin', 'extent'];
const fresh = (e, p) => { const g = e.sig; return g[0] === p.id && g[1] === p.x && g[2] === p.y && g[3] === p.z && g[4] === p.w && g[5] === p.d && g[6] === p.h && g[7] === p.rotation && g[8] === p.shape && g[9] === p.origin && g[10] === p.extent && e.ld === p.ldMatrix && (!p.ldMatrix || e.m.every((v, i) => v === p.ldMatrix[i])); };
function infoOf(p) {
  let e = info.get(p);
  if (!e || !fresh(e, p)) info.set(p, (e = { sig: FIELDS.map((f) => p[f]), ld: p.ldMatrix, m: p.ldMatrix ? [...p.ldMatrix] : null, box: worldBox(p), conns: null, env: null }));
  return e;
}
const connsOf = (p, env) => { const e = infoOf(p); return e.env === env.table && e.frames === env.frames ? e.conns : (e.env = env.table, e.frames = env.frames, e.conns = connectorsOf(p, env)); };

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);   // (as Math.hypot(...sub(a, b)), without the arrays)
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const clean = (v) => (Math.abs(v) < 1e-9 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-9 ? Math.sign(v) : v);
const app3 = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
const mul3 = (A, B) => { const r = Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = clean(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]); return r; };
const colOf = (M, j) => [M[j], M[3 + j], M[6 + j]];
// A turn of `rad` about a direction (Rodrigues, as lib/studio.mjs rot).
function turnAbout(axis, rad) {
  const c = clean(Math.cos(rad)), s = clean(Math.sin(rad)), [x, y, z] = unit(axis), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C].map(clean);
}
// The shortest turn that takes direction u to direction v.
function shortest(u, v) {
  const c = dot(u, v);
  if (c > 1 - 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (c < -1 + 1e-9) return turnAbout(cross(u, Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]), Math.PI);   // opposite: any axis across
  return turnAbout(cross(u, v), Math.acos(c));
}
// A direction across `axis` that a frame can be lined up by: one of the frame's own columns that stands
// across it, else a world axis projected.
function across(M, axis) {
  for (let j = 0; j < 3; j++) { const c = colOf(M, j); if (Math.abs(dot(c, axis)) < 0.1) return c; }
  const e = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1], k = dot(e, axis);
  return unit(e.map((v, i) => v - k * axis[i]));
}
const angleAbout = (axis, from, to) => Math.atan2(dot(axis, cross(from, to)), dot(from, to));
// The angle between two rotations (degrees).
const between = (A, B) => { const t = A[0] * B[0] + A[1] * B[1] + A[2] * B[2] + A[3] * B[3] + A[4] * B[4] + A[5] * B[5] + A[6] * B[6] + A[7] * B[7] + A[8] * B[8]; return (Math.acos(Math.max(-1, Math.min(1, (t - 1) / 2))) * 180) / Math.PI; };

// Where two connectors meet: a stud's foot is the mouth of the hollow that takes it; the rest by their middles.
const meet = (c) => (c.k === 'stud' ? c.at.map((v, i) => v - c.axis[i] * (c.l / 2)) : c.k === 'antistud' ? c.at.map((v, i) => v + c.axis[i] * (c.l / 2)) : c.at);

// A spatial hash of connectors, a cylinder by points along it (a mate needs two within 2 mm).
const cellOf = (v) => Math.floor(v / CELL);
// (a cell as one number, not a string: a hash is looked up some thousands of times per call)
const keyOf = (x, y, z) => (x + 32768) * 4294967296 + (y + 32768) * 65536 + (z + 32768);
const sampled = new WeakMap();   // (a connector of a kept part is asked about again and again)
function samples(c, keep = true) {
  let out = keep ? sampled.get(c) : null;
  if (out) return out;
  if (c.k === 'ball' || c.k === 'socket' || !(c.l > 0)) out = [c.at];
  else {
    const n = Math.max(1, Math.ceil(c.l / STEP)); out = [];
    for (let i = 0; i <= n; i++) { const t = (i / n - 0.5) * c.l; out.push(c.at.map((v, j) => v + c.axis[j] * t)); }
  }
  if (keep) sampled.set(c, out);
  return out;
}
// The cells a connector sits in (`ck`), and those it has to look in (`nk`: all around each point, each once, in the order
// they would be met): kept with the connector, since a kept part's connectors are asked about every pointer move.
const cells = new WeakMap();
function cellsOf(c) {
  let e = cells.get(c);
  if (e) return e;
  const ck = new Set(), nk = new Set();
  for (const pt of samples(c)) {
    const x = cellOf(pt[0]), y = cellOf(pt[1]), z = cellOf(pt[2]);
    ck.add(keyOf(x, y, z));
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) nk.add(keyOf(x + i, y + j, z + k));
  }
  cells.set(c, (e = { ck: [...ck], nk: [...nk] }));
  return e;
}
// (`kept`: the connectors are of the model's parts and will be asked about again; the held group's are made afresh each time, and not worth keeping)
function hashOf(conns, kept = false) {
  const grid = new Map();
  for (const c of conns) {
    const ck = kept ? cellsOf(c).ck : new Set(samples(c, false).map((pt) => keyOf(cellOf(pt[0]), cellOf(pt[1]), cellOf(pt[2]))));
    for (const k of ck) { const had = grid.get(k); if (!had) grid.set(k, [c]); else had.push(c); }
  }
  return grid;
}
// What connector `c` mates with in a hash: [{ b, m }] (the same part's own connectors never). `first`: stop at one.
function matesIn(c, grid, first = false, kept = false) {
  const seen = new Set(), out = [];
  const look = (key) => {
    const had = grid.get(key);
    if (!had) return false;
    for (const b of had) {
      if (b.part === c.part || (b.g === c.g && c.k !== 'finger') || seen.has(b)) continue;
      seen.add(b);
      const m = mate(c, b);
      if (m) { out.push({ b, m }); if (first) return true; }
    }
    return false;
  };
  if (kept) { for (const key of cellsOf(c).nk) if (look(key)) return out; return out; }
  for (const pt of samples(c, false)) {
    const x = cellOf(pt[0]), y = cellOf(pt[1]), z = cellOf(pt[2]);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) if (look(keyOf(x + i, y + j, z + k)) && first) return out;
  }
  return out;
}

// Whether a hit calls for snapping by connectors rather than the grid: the part hit is off the grid
// (turned on its own matrix), or a joint that is not a stud (pin, hole, axle, bar, clip, finger, ball)
// lies within 6 mm of the hit point. `tables`: { frames, connectors, … } as the workbench loads them.
const odd = new WeakMap();
const hasOdd = (rows) => { let v = odd.get(rows); if (v === undefined) odd.set(rows, (v = rows.some((r) => ODD_ROWS.has(r[0])))); return v; };
export function wantsSnap(hit, tables) {
  const q = hit?.part;
  if (!q || !tables?.connectors || !tables.frames) return false;
  if (q.origin && q.extent) return true;
  const rows = tables.connectors[q.id];
  if (!rows?.length || !hasOdd(rows)) return false;
  const at = [hit.point.x * STUD, hit.point.y * PLATE, hit.point.z * STUD];
  return connectorsOf(q, { table: tables.connectors, frames: tables.frames }).some((c) => c.k !== 'stud' && c.k !== 'antistud' && c.k !== 'gen' && dist(c.at, at) < SIDE);
}

// The ways the held group could be set on the model at `hit`, best first (at most 12):
// [{ parts, ok, how: 'connector', mates: [{ a, b, dof, kind, at, axis }], why?, blocker? }].
// held: { parts, anchor, moving } as the workbench's drag holds them (copies); hit: { part, point, normal }
// from the viewer (studs and plates); ctx: { tables, space, graph, model? } (`model` finds the parts near the
// hit; without it, the hit part and what the graph links to it). `ok`: nothing in the way, and at least
// one mate. Best: ok, then the most mates, then nearest the pointer (a quarter turn away from how it is
// held counts as a stud's worth of distance).
export function snapTries(held, hit, ctx) {
  const { tables, space } = ctx;
  if (!tables?.connectors || !tables.frames || !hit?.part || !held?.parts?.length) return [];
  const env = { table: tables.connectors, frames: tables.frames };
  const moving = held.moving ?? new Set(held.parts);
  const geom = (q) => frameOf(q.id, tables.frames) ?? (q.origin && q.ldMatrix ? NONE : null);
  if (held.parts.some((q) => !geom(q))) return [];
  const P = [hit.point.x * STUD, hit.point.y * PLATE, hit.point.z * STUD];
  const N = hit.normal ? [hit.normal.x, hit.normal.y, hit.normal.z] : null;

  // The held group: its connectors that nothing else held takes, and its middle.
  const group = held.parts.length > GROUP ? [held.parts[held.anchor]] : held.parts;
  const own = group.flatMap((q) => connectorsOf(q, env));
  const ownHash = hashOf(own);
  const Hs = own.filter((c) => GOES[c.k] && !matesIn(c, ownHash, true).length);
  if (!Hs.length) return [];
  const boxes = held.parts.map(worldBox);
  const lo = [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b[k]))), hi = [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b[k + 3])));
  const mid = lo.map((v, k) => (v + hi[k]) / 2), rad = Math.hypot(...sub(hi, lo));

  // The model near the hit, its connectors, and the free ones near the pointer.
  const close = (p, r) => { const b = infoOf(p).box; return [0, 1, 2].every((k) => P[k] > b[k] - r && P[k] < b[k + 3] + r); };
  const pool = ctx.model?.parts ?? [hit.part, ...(ctx.graph?.links(hit.part) ?? [])];
  const near = [], reach = REACH + rad;
  for (const p of pool) if (!moving.has(p) && (p === hit.part || close(p, reach))) near.push(p);
  const theirs = near.flatMap((p) => connsOf(p, env)).filter((c) => dist(c.at, P) < reach + 20), theirHash = hashOf(theirs, true);
  // (nearest first, and only as many asked whether they are free as are needed: TARGETS facing the surface, or
  // when none face it, TARGETS of any)
  const aimed = theirs.filter((c) => GOES[c.k] && dist(c.at, P) < REACH).sort((u, v) => dist(u.at, P) - dist(v.at, P));
  const facing = [], rest = [];
  for (const c of aimed) {
    if (matesIn(c, theirHash, true, true).length) continue;
    if (N && dot(c.axis, N) > 0.3) { if (facing.push(c) >= TARGETS) break; } else if (rest.length < TARGETS) rest.push(c);
    if (!N && rest.length >= TARGETS) break;
  }
  const Ts = facing.length ? facing : rest;

  // Every way to set a held connector on a target: its transform, once.
  const a0 = held.parts[held.anchor], fa = freeForm(a0, geom(a0)), poses = held.parts.map((q) => freeForm(q, geom(q)));
  const seen = new Set(), cands = [];
  for (const T of Ts) {
    const Tm = freeForm(T.part, frameOf(T.part.id, tables.frames) ?? NONE).M, ref = across(Tm, T.axis), to = meet(T);
    for (const H of Hs) {
      if (!GOES[T.k].includes(H.k) || (H.g === T.g && H.k !== 'finger')) continue;
      for (const want of BOTH_WAYS.has(H.k) && BOTH_WAYS.has(T.k) ? [-1, 1] : [-1]) {
        const R1 = shortest(H.axis, T.axis.map((v) => v * want)), R1M = mul3(R1, poses[held.parts.indexOf(H.part)]?.M ?? fa.M);
        const phi = angleAbout(T.axis, across(R1M, T.axis), ref), step = FREE_SPIN.has(T.k) ? 22.5 : 90;
        for (let s = 0; s < 360 / step; s++) {
          const Q = mul3(turnAbout(T.axis, phi + (s * step * Math.PI) / 180), R1), from = meet(H);
          const move = (v) => app3(Q, sub(v, from)).map((x, i) => x + to[i]);
          const Oa = move(fa.O), Ma = mul3(Q, fa.M);
          const sig = Math.round(Oa[0] * 20) + ',' + Math.round(Oa[1] * 20) + ',' + Math.round(Oa[2] * 20) + ',' + Ma.map((v) => Math.round(v * 1000)).join();
          if (seen.has(sig)) continue;
          seen.add(sig);
          cands.push({ Q, Ma, move, H, T, pre: dist(move(mid), P) });
        }
      }
    }
  }
  cands.sort((u, v) => u.pre - v.pre);

  // Each candidate as parts, checked and counted.
  const theirOnly = theirHash;   // (`near` has no moving part, so this is all of theirs)
  const out = [];
  // (the nearest TRY of each kind of target: a crowd of studs does not push a clip out of the running)
  const taken = {};
  for (const cd of cands.filter((c) => (taken[c.T.k] = (taken[c.T.k] ?? 0) + 1) <= TRY)) {
    const parts = held.parts.map((q, i) => fromFree(q, cd.move(poses[i].O), mul3(cd.Q, poses[i].M), geom(q)));
    const mates = [], keyed = new Set();
    const mineAt = held.parts.indexOf(cd.H.part), conns = [];
    conns[mineAt] = connectorsOf(parts[mineAt], env);
    // (first, so that a wrong one costs nothing more) The pair it was made for has to mate, or the transform was wrong.
    // (cd.T is the connector of `theirs` itself)
    if (!mate(conns[mineAt].find((c) => c.i === cd.H.i), cd.T)) continue;
    for (const [i, q] of parts.entries()) {
      if (held.parts.length > GROUP && i !== held.anchor) continue;
      conns[i] ??= connectorsOf(q, env);
      for (const c of conns[i]) for (const { b, m } of matesIn(c, theirOnly)) {
        const key = `${i}|${c.i}|${b.part.key ?? near.indexOf(b.part)}|${b.i}`;
        if (!keyed.has(key)) { keyed.add(key); mates.push({ a: q, b: b.part, dof: m.dof, kind: (c.g === 'M' ? c : b).k, at: m.at, axis: m.axis }); }
      }
    }
    let blocker = null;
    for (const c of parts) { blocker = (worldBox(c)[1] < -0.5 ? hit.part : space.blocked(c, moving) ? space.blocker(c, moving) ?? hit.part : null); if (blocker) break; }
    const ok = !blocker && mates.length > 0;
    const ac = worldBox(parts[held.anchor]), here = [0, 1, 2].map((k) => (ac[k] + ac[k + 3]) / 2);
    out.push({ parts, ok, how: 'connector', mates, ...(ok ? {} : { why: blocker ? 'blocked' : 'loose', blocker }), score: dist(here, P) + (10 * between(cd.Ma, fa.M)) / 90 });
  }
  out.sort((u, v) => v.ok - u.ok || v.mates.length - u.mates.length || u.score - v.score);
  return out.slice(0, ctx.keep ?? KEEP).map(({ score, ...t }) => t);
}

// The rings a try shows, as sideAt gives them: [{ at, dir }] (mm), one per place it mates.
export const matesAsStuds = (t) => {
  const out = [], seen = new Set();
  for (const m of t.mates) { const k = m.at.map((v) => Math.round(v * 5)).join(); if (!seen.has(k)) { seen.add(k); out.push({ at: m.at, dir: m.axis }); } }
  return out;
};
