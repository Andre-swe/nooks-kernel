// The connection graph: what holds what, as typed edges, with rigid bodies and
// the joints between them. A drop-in for linkIndex (lib/edit.mjs), which stays
// the base: stud, touch, face and floor links come from it as they do today
// (incremental and tested); the graph adds the connectors linkIndex knows
// nothing of (pins, axles, bars in clips, hinge fingers, balls), found through
// a spatial hash of their world points and lib/connectors.mjs `mate`.
// Pure: the caller loads the tables.
import { studPoints, inside, faceJoin, jointLike } from './studs.mjs';
import { connectorsOf, mate, KINDS } from './connectors.mjs';
import { linkIndex } from './edit.mjs';

const CELL = 2;          // mm: a hash cell. A mate needs two sample points within 2 mm, and the 27 cells around a point reach at least that
const STEP = 3;          // mm: sample points along a cylinder (so one is within 1.5 mm of any point on it)
const ODD = new Set(KINDS.map((k, i) => (k === 'stud' || k === 'antistud' || k === 'gen' ? -1 : i)));   // (generic snaps never mate: left out)
const KIND = { bar: 'clip' };                      // (a bar in a clip is a 'clip' edge)
const cellOf = (v) => Math.floor(v / CELL);

// connectors.json's rows cut down to the ones that make a connector edge, once per table.
const odds = new WeakMap();
function oddTable(rows) {
  let t = odds.get(rows);
  if (t) return t;
  t = {};
  for (const id in rows) { const odd = rows[id].filter((r) => ODD.has(r[0])); if (odd.length) t[id] = odd; }
  odds.set(rows, t);
  return t;
}

// Points along a connector to hash it by: its middle, or for a cylinder
// points a few millimetres apart from end to end.
function samples(c) {
  if (c.k === 'ball' || c.k === 'socket' || !(c.l > 0)) return [c.at];
  const n = Math.max(1, Math.ceil(c.l / STEP)), out = [];
  for (let i = 0; i <= n; i++) { const t = (i / n - 0.5) * c.l; out.push(c.at.map((v, j) => v + c.axis[j] * t)); }
  return out;
}
const cellKeys = (pts) => [...new Set(pts.map((p) => `${cellOf(p[0])},${cellOf(p[1])},${cellOf(p[2])}`))];

// The same joint twice: one kind, one way of moving, on one line.
function sameJoint(r, q) {
  if (r.kind !== q.kind || r.dof !== q.dof || Math.abs(r.axis[0] * q.axis[0] + r.axis[1] * q.axis[1] + r.axis[2] * q.axis[2]) < 0.995) return false;
  const d = q.at.map((v, i) => v - r.at[i]), t = d[0] * r.axis[0] + d[1] * r.axis[1] + d[2] * r.axis[2];
  return Math.hypot(...d.map((v, i) => v - t * r.axis[i])) < 0.5;
}
// A part's pose as the workbench moves parts in place (putDown, turnFree): the connector entry is good while it is the same.
const poseOf = (p) => [p.id, p.x, p.y, p.z, p.rotation, p.shape, ...(p.ldMatrix ?? [])];
const samePose = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const ord = (p) => (typeof p.key === 'number' ? p.key : Infinity);
const byEdge = (a, b) => ord(a.to) - ord(b.to) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.at && b.at ? a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2] : 0);

// tables: { connectors, frames } (the `parts` of connectors.json and frames.json), or null for linkIndex's answer exactly.
// from, edits: as linkIndex (the graph before some edits; { added, removed, changed: [[part, …]] } per edit, oldest first). `from` is spent.
export function connectionGraph(model, tables = null, from = null, edits = null) {
  const cat = model.catalog;
  const base = linkIndex(model, from?.base, edits);
  const env = tables?.connectors ? { table: oddTable(tables.connectors), frames: tables.frames } : null;
  // The connector side: per part with any, its world connectors and the cells it sits in; and its mates (`recs`, shared with the other part).
  let gx;
  const resume = env && from?.gx && from.tables?.connectors === tables.connectors && from.tables?.frames === tables.frames && edits?.length;
  if (resume) { gx = from.gx; from.gx = null; } else gx = { state: new Map(), grid: new Map() };
  const { state, grid } = gx;

  function unindex(p) {
    const s = state.get(p);
    if (!s) return;
    state.delete(p);
    for (const k of s.cells) { const had = grid.get(k); if (!had) continue; const rest = had.filter((c) => c.part !== p); if (rest.length) grid.set(k, rest); else grid.delete(k); }
    for (const r of s.recs) { const q = r.a === p ? r.b : r.a, t = state.get(q); if (t) t.recs = t.recs.filter((x) => x !== r); }
  }
  function index(p) {
    unindex(p);
    const conns = connectorsOf(p, env);
    if (!conns.length) return;
    const s = { conns, cells: [], recs: [], pose: poseOf(p) };
    const seen = new Set();
    for (const a of conns) {
      const pts = samples(a), keys = new Set();
      for (const pt of pts) { const x = cellOf(pt[0]), y = cellOf(pt[1]), z = cellOf(pt[2]); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) keys.add(`${x + i},${y + j},${z + k}`); }
      for (const key of keys) for (const b of grid.get(key) ?? []) {
        if (b.part === p || (a.g === b.g && a.k !== 'finger') || seen.has(b)) continue;
        seen.add(b);
        const m = mate(a, b);
        if (!m) continue;
        const male = a.g === 'M' ? a : b, rec = { a: p, b: b.part, dof: m.dof, kind: KIND[male.k] ?? male.k, at: m.at, axis: m.axis };
        if (s.recs.some((r) => r.b === b.part && sameJoint(r, rec))) continue;   // (a pin has a few parts that each mate the same hole: one joint)
        s.recs.push(rec); state.get(b.part).recs.push(rec);
      }
      seen.clear();
    }
    // (put in the grid only now: a part's own connectors are not asked about each other)
    for (const a of conns) for (const k of cellKeys(samples(a))) { const had = grid.get(k); if (had) had.push(a); else grid.set(k, [a]); if (!s.cells.includes(k)) s.cells.push(k); }
    state.set(p, s);
  }
  if (env) {
    if (resume) {
      for (const ed of edits) {
        for (const p of ed.removed) unindex(p);
        for (const [p] of ed.changed) index(p);
        for (const p of ed.added) index(p);
      }
    } else for (const p of model.parts) index(p);
  }
  // `index` finds a part's mates among the parts already in the grid, so a part
  // indexed before its partner (the partner being indexed later) is found by
  // the partner: every pair is found by whichever came second.

  let bodies = null, jointList = null;
  // The entry of a part, made again if the part was moved in place without an edit saying so.
  const live = (p) => { const s = state.get(p); if (s && !samePose(s.pose, poseOf(p))) { index(p); bodies = jointList = null; return state.get(p); } return s; };
  // (a partner moved in place is found by looking at every part with connectors: a few numbers each.
  // Once a tick, not on every question: a walk asks links() of every part it reaches, and a part is
  // only ever moved between events, never in the middle of one walk.)
  let swept = false;
  const sweep = () => {
    if (swept) return;
    swept = true;
    queueMicrotask(() => { swept = false; });
    for (const p of [...state.keys()]) live(p);
  };
  // Links: linkIndex's, and the parts the connectors join. linkIndex's own sets are never touched.
  const links = (p) => {
    sweep();
    const had = base.links(p), s = state.get(p);
    if (!s?.recs.length) return had;
    const out = new Set(had);
    for (const r of s.recs) out.add(r.a === p ? r.b : r.a);
    return out;
  };
  // Every connector joint once, as f(a, b): what connectivity() adds to the stud links.
  const pairs = (f) => { sweep(); for (const [p, s] of state) for (const r of s.recs) if (r.a === p) f(r.a, r.b); };
  const rigidStud = (p, q) => {
    const up = (lo, hi) => Math.abs(lo.y + lo.h - hi.y) < 0.01 && studPoints(lo, cat).find((pt) => inside(hi, pt));
    const pt = up(p, q) || up(q, p), top = up(p, q) ? p : q;
    return pt && { at: [pt[0] * 8, (top.y + top.h) * 3.2, pt[1] * 8], axis: [0, 1, 0] };
  };
  // Which rule of linkIndex made a link, guessed from the two parts (a link none of ours explains is 'touch').
  const linkKind = (p, q, st) => (st ? 'stud' : (p.extent || q.extent) && faceJoin(p, q, cat) ? 'face' : !p.origin && !q.origin && p.y === base.ix.floor && q.y === base.ix.floor ? 'floor' : 'touch');
  // A figure or off-grid part links by touching anything near, which says nothing of how: where a pin, bar or finger
  // really joins two parts and nothing holds them rigidly, the connector is the truth and that touch is not rigid.
  const softTouch = (p, q) => {
    const rs = state.get(p)?.recs;
    if (!rs?.length) return false;
    let loose = false;
    for (const r of rs) if (r.a === q || r.b === q) { if (r.dof === 'rigid') return false; loose = true; }
    if (!loose) return false;
    // (a hinge part turned off the grid still touches its partner, which faceJoin counts as a face link: that is no more rigid)
    const kind = linkKind(p, q, rigidStud(p, q));
    return kind === 'touch' || (kind === 'face' && (jointLike(p, cat) || jointLike(q, cat)));
  };
  // Typed edges of a part: the studs and the rest from linkIndex, then the connector mates.
  function edges(p) {
    sweep();
    const out = [];
    for (const q of base.links(p)) {
      const st = rigidStud(p, q);
      if (!st && softTouch(p, q)) continue;
      out.push({ to: q, dof: 'rigid', kind: linkKind(p, q, st), at: st?.at ?? null, axis: st?.axis ?? null });
    }
    for (const r of state.get(p)?.recs ?? []) out.push({ to: r.a === p ? r.b : r.a, dof: r.dof, kind: r.kind, at: r.at, axis: r.axis });
    return out.sort(byEdge);
  }

  // Bodies: every rigid link joins; made once, when first asked after an edit.
  function bodiesNow() {
    if (bodies) return bodies;
    sweep();
    const parts = model.parts, at = new Map(parts.map((p, i) => [p, i])), parent = parts.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
    const join = (i, j) => { if (j !== undefined && i !== j) parent[find(i)] = find(j); };
    parts.forEach((p, i) => { for (const q of base.links(p)) if (!softTouch(p, q)) join(i, at.get(q)); });
    for (const [p, s] of state) for (const r of s.recs) if (r.dof === 'rigid' && r.a === p) join(at.get(p), at.get(r.b));
    const groups = new Map(), of = new Map();
    parts.forEach((p, i) => { const root = find(i); let g = groups.get(root); if (!g) groups.set(root, (g = { key: i, parts: [] })); g.parts.push(p); of.set(p, g); });
    // A body is named by its first part's place in the model (stable while the model is).
    return (bodies = { at, of });
  }
  const bodyOf = (p) => bodiesNow().of.get(p)?.parts ?? [p];
  // (made once, with the bodies: a hover asks on every move)
  function joints() {
    sweep();
    if (bodies && jointList) return jointList;
    const { of } = bodiesNow(), out = [];
    for (const p of model.parts) for (const r of state.get(p)?.recs ?? []) {
      if (r.a !== p || r.dof === 'rigid') continue;
      const x = of.get(r.a), y = of.get(r.b);
      if (!x || !y || x === y) continue;
      const [a, b, pa, pb] = x.key <= y.key ? [x.key, y.key, r.a, r.b] : [y.key, x.key, r.b, r.a];
      out.push({ a, b, dof: r.dof, at: r.at, axis: r.axis, parts: [pa, pb] });
    }
    return (jointList = out.sort((u, v) => u.a - v.a || u.b - v.b || (u.at[0] - v.at[0]) || (u.at[1] - v.at[1]) || (u.at[2] - v.at[2])));
  }
  return { links, pairs, has: base.has, ix: base.ix, edges, bodyOf, joints, base, gx, tables };
}
