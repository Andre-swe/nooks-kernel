// A build's construction record (docs/BUILD_BY_CONNECTOR.md, piece 6): the steps a person or an agent actually took
// in the workbench, as build program ops (lib/program.mjs), so a person's build and an agent's are one program.
// Nothing is made up for a build that wasn't built this way: an old set or an import starts its record with a
// `base` op, the model as it stood, and only the edits after it are steps.
// Pure: the caller passes BrickNet's tables (lib/bricknet.mjs load) and a frame lookup (lib/frames.mjs framesFrom).
//
// A placed part's op is `attach` when one of its BrickNet connectors fits a placed part's exactly, otherwise `add`
// at its pose. It is named k<key> and carries `key` and our part number `id`, so the program and the model map one
// to one, and `who` ('human' or 'agent'), as `by` is attach's own connector.
//
// Sub-builds and mirrors are one op for several parts, carrying `keys` (the parts' keys in their definition's order):
// a copy of a sub-build is `add { use }` or `attach { use }` after its `define … end` (model.subBuilds, lib/subbuild.mjs),
// and a selection mirrored by BrickNet's counterparts is `mirror { of }` of a definition of the parts as they stood. A
// part of one is named `<op>/d<i>`, so what is attached to it names its connector ('copy-x/d3.stud[0]').
import { compose, inverse, toLDraw as ldrawOf, mul3 } from './pose.mjs';
import { compatible, placement, AXLE_MIN_OVERLAP } from './bricknet.mjs';
import { runProgram, LIMITS } from './program.mjs';
import { parts as flatten } from './assembly.mjs';
import { poseOf } from './bridge.mjs';
import { copiesOf } from './subbuild.mjs';

const RX_PI = [1, 0, 0, 0, -1, 0, 0, 0, -1];
const EXACT = 1e-6, CELL = 24, REACH = 3;
const tidy = (v) => { const r = Math.round(v); return Math.abs(v - r) < 1e-9 ? r + 0 : +v.toFixed(12); };
const gap = (a, b) => Math.max(...a.t.map((v, i) => Math.abs(v - b.t[i])), ...a.r.map((v, i) => Math.abs(v - b.r[i])));
const cellOf = (t) => t.map((v) => Math.floor(v / CELL));
const cellKey = (x, y, z) => Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) < 32768 ? (x + 32768) * 4294967296 + (y + 32768) * 65536 + z + 32768 : `${x},${y},${z}`;
export const nameOf = (key) => `k${key}`;

// Inline base snapshots are data, not inferred construction history. The original
// order supplies stable p<index> names even after a base part has been removed.
const snapshot = (p, T, geom) => {
  const at = !p.flex && poseOf(p, T, geom);
  return at ? { key: p.key, id: p.id, stem: at.stem, color: p.color, pose: ldrawOf(at.pose) } : { key: p.key, id: p.id, fixed: true, part: structuredClone(p) };
};
export function baseProgram(model, T, geom) {
  if (model.parts.length > LIMITS.parts) return null;
  const program = { version: 1, ops: [{ op: 'base', parts: model.parts.map((p) => snapshot(p, T, geom)), removed: [] }] };
  const hash = connectorHash(T), names = programNames(program), poses = new Map();
  for (const p of model.parts) { const at = !p.flex && poseOf(p, T, geom); if (at) { hash.add(names.get(p.key), at.stem, at.pose); poses.set(p.key, at); } }
  indexes.set(program, { T, geom, hash, names, poses });
  return program;
}

export function programNames(program) {
  const names = new Map(), base = program?.ops?.find((o) => o.op === 'base');
  const removed = new Set(base?.removed ?? []);
  base?.parts?.forEach((p, i) => { if (!removed.has(p.key)) names.set(p.key, `p${i}`); });
  for (const o of program?.ops ?? []) {
    if (o.key !== undefined) names.set(o.key, o.name);
    else if (Array.isArray(o.keys)) o.keys.forEach((k, i) => names.set(k, `${o.name}/d${i}`));
  }
  return names;
}
// The op a reference ("copy-x/d3.stud[0]", "k12.hole[1]") is to.
const unitOf = (to) => to.split('.')[0].split('/')[0];

// A definition's ops, `define name` … `end`, for workbench parts as they stand in its frame: each part attached to
// the ones before it where a connector fits exactly, else added at its pose, named d0, d1, … in order. Null when
// BrickNet lacks one of them.
export function defineOps(name, parts, T, geom) {
  const hash = connectorHash(T), ops = [{ op: 'define', name }], poses = [];
  for (let i = 0; i < parts.length; i++) {
    const p = { ...parts[i], key: i }, op = opFor(p, T, geom, hash), at = op && poseOf(p, T, geom);
    if (!op) return null;
    delete op.key; delete op.who;
    op.name = `d${i}`;
    ops.push(op); poses.push(at);
    hash.add(op.name, at.stem, at.pose);
  }
  ops.push({ op: 'end' });
  return { ops, poses };
}

// The op for one copy of a sub-build (`parts` by their index in the definition, `def` defineOps's), named `name`:
// `attach { use }` when one of its connectors fits a placed part's exactly, else `add { use }` at its pose; null when
// the copy isn't the definition moved rigidly (to 1e-6 LDU) or BrickNet lacks a part.
export function copyOpFor(name, use, parts, def, T, geom, placed, { who = 'human' } = {}) {
  const at = parts.map((p) => p && !p.flex && poseOf(p, T, geom));
  if (at.length !== def.poses.length || at.some((a, i) => !a || a.stem !== def.poses[i].stem)) return null;
  const X = compose(at[0].pose, inverse(def.poses[0].pose));
  if (at.some((a, i) => gap(compose(X, def.poses[i].pose), a.pose) > EXACT)) return null;
  const head = { name, use, keys: parts.map((p) => p.key), who };
  for (let i = 0; i < at.length; i++) for (const c of T.stems.get(at[i].stem).conns) {
    const world = compose(at[i].pose, c.frame);
    for (const t of placed.near(world.t, c.kind === 'axle' ? REACH : 1)) {
      if (t.name.startsWith(`${name}/`) || !compatible(t.conn, c)) continue;
      if (c.kind !== 'axle' && world.t.some((v, k) => Math.abs(v - t.pose.t[k]) > EXACT)) continue;
      const inner = { ...c, frame: compose(def.poses[i].pose, c.frame) };
      const fit = fitOf(T, { stem: t.stem, conn: t.conn, pose: t.pose }, { stem: at[i].stem, conn: inner }, X);
      if (fit) return { op: 'attach', ...head, to: `${t.name}.${t.conn.type}[${t.conn.index}]`, by: `d${i}.${c.type}[${c.index}]`, ...fit };
    }
  }
  return { op: 'add', ...head, pose: [{ ldraw: ldrawOf(X).map(tidy) }] };
}

// A program's define blocks by name, and its other ops.
function blocksOf(ops) {
  const blocks = new Map(), top = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].op !== 'define') { top.push(ops[i]); continue; }
    let j = i, depth = 0;
    for (; j < ops.length; j++) { if (ops[j].op === 'define') depth++; else if (ops[j].op === 'end' && --depth === 0) break; }
    blocks.set(ops[i].name, ops.slice(i, j + 1));
    i = j;
  }
  return { blocks, top };
}

// Cache only derived indexes. Consuming an index removes the old entry, so
// replaying an older program (undo, branches) always reconstructs its own index.
const indexes = new WeakMap();
function indexOf(program, model, T, geom, changed) {
  let index = indexes.get(program);
  indexes.delete(program);
  if (index?.T === T && index.geom === geom) return index;
  const hash = connectorHash(T), names = programNames(program), poses = new Map();
  const run = runProgram(program, T, { roomForFlex: false, hoses: true });
  for (const [key, name] of names) { const occ = run.names.get(name); if (occ?.isPart) poses.set(key, { stem: occ.what, pose: occ.pose }); }
  for (const p of model.parts) {
    if (changed.has(p.key)) continue;
    const at = !p.flex && poseOf(p, T, geom), name = names.get(p.key);
    if (at && name) hash.add(name, at.stem, at.pose);
  }
  return { T, geom, hash, names, poses };
}

// `model` is after the edit; initialize with baseProgram before the first edit.
// changed accepts changes()'s [part, oldValues] rows or worker part objects.
// Optional ops are the exact choices made by placement, keyed by part key.
// Sub-builds: `model.subBuilds` (lib/subbuild.mjs) and each copy's parts' `sub`; `edit.redefine`: the sub-builds whose
// definition the edit changed (every copy then replays from the new one). `edit.mirror`: { axis, about, keys, from }
// when the edit mirrored parts by BrickNet's counterparts, `from` the parts before (in the order of `keys`).
export function recordEdit(program, model, edit, T, geom) {
  if (model.parts.length > LIMITS.parts) return null;
  if (!program) return baseProgram(model, T, geom);
  const changedParts = (edit.changed ?? []).map((p) => Array.isArray(p) ? p[0] : p);
  const touched = new Set([...(edit.added ?? []), ...changedParts, ...(edit.removed ?? [])].map((p) => typeof p === 'object' ? p.key : p));
  const current = new Map(model.parts.map((p) => [p.key, p]));
  const subs = model.subBuilds ?? {}, copies = copiesOf(model);
  const { blocks, top } = blocksOf(program.ops);
  const oldOps = new Map(top.filter((o) => o.key !== undefined).map((o) => [o.key, o]));
  // An op for several parts is made again whole when any of them is touched, and so is every copy of a sub-build
  // whose definition changed; a copy is always recorded whole.
  const units = new Map();
  for (const o of top) if (Array.isArray(o.keys)) for (const k of o.keys) units.set(k, o);
  const redefined = new Set((edit.redefine ?? []).map((s) => `sub-${String(s).replace(/[^A-Za-z0-9_-]/g, '_')}`));
  const mirrored = new Set(edit.mirror?.keys ?? []);
  for (const o of top) if (o.use && redefined.has(o.use)) o.keys.forEach((k) => touched.add(k));
  for (const k of [...touched]) {
    for (const j of units.get(k)?.keys ?? []) touched.add(j);
    const c = current.get(k)?.sub && copies.get(current.get(k).sub.c);
    if (c) for (const q of c.parts) if (q) touched.add(q.key);
  }
  const index = indexOf(program, model, T, geom, touched), { hash, names } = index;
  const recoloured = new Set();
  for (const p of changedParts) {
    if (!touched.has(p.key) || units.has(p.key) || p.sub || mirrored.has(p.key)) continue;
    const old = index.poses.get(p.key), at = !p.flex && poseOf(p, T, geom);
    if (old && at && old.stem === at.stem && gap(old.pose, at.pose) < EXACT) { recoloured.add(p.key); touched.delete(p.key); }
  }
  for (const key of recoloured) { const name = names.get(key), at = index.poses.get(key); hash.drop(name); hash.add(name, at.stem, at.pose); }
  const invalid = new Set([...touched].map((k) => names.get(k)).filter(Boolean));
  // Remove the dependent closure from the index too: attaching a repaired
  // parent to its own descendant would otherwise introduce a cycle.
  const repair = new Set(touched);
  const dependents = new Map();
  for (const o of top) if (o.op === 'attach') {
    const parent = o.to.split('.')[0];
    if (!dependents.has(parent)) dependents.set(parent, []);
    dependents.get(parent).push(o);
  }
  const keysOf = (o) => (Array.isArray(o.keys) ? o.keys : [o.key]);
  for (const name of invalid) for (const o of dependents.get(name) ?? []) for (const k of keysOf(o)) { if (repair.has(k)) continue; repair.add(k); const n = names.get(k); if (n) invalid.add(n); }
  for (const key of repair) { const name = names.get(key); if (name) hash.drop(name); names.delete(key); index.poses.delete(key); }
  let base = top.find((o) => o.op === 'base');
  if (base?.parts) {
    const removed = new Set(base.removed ?? []);
    let altered = false;
    for (const p of base.parts) if (repair.has(p.key) && !removed.has(p.key)) { removed.add(p.key); altered = true; }
    if (altered || base.parts.some((p) => recoloured.has(p.key))) base = { ...base, removed: [...removed], parts: base.parts.map((p) => recoloured.has(p.key) ? { ...p, color: current.get(p.key).color } : p) };
  }
  const ops = top.filter((o) => o.op !== 'base' && !keysOf(o).some((k) => repair.has(k))).map((o) => recoloured.has(o.key) ? { ...o, color: current.get(o.key).color } : o);
  // Definitions: kept as they are unless the edit changed them, made when first needed.
  const defs = new Map(), made = new Set();
  const defFor = (name, parts) => {
    if (defs.has(name)) return defs.get(name);
    let d = null;
    if (blocks.has(name) && !redefined.has(name)) {
      const inner = blocks.get(name).filter((o) => o.op !== 'define' && o.op !== 'end');
      const run = runProgram({ ops: [...blocks.get(name).map((o) => (o.op === 'end' ? { op: 'end' } : o)), { op: 'add', name: '_', use: name }] }, T, { roomForFlex: false, hoses: true });
      const flat = flatten(run.names.get('_'));
      if (flat.length === inner.length) d = { ops: blocks.get(name), poses: flat.map((f) => ({ stem: f.stem, pose: f.pose })) };
    }
    d ??= parts && defineOps(name, parts, T, geom);
    if (d) made.add(name);
    defs.set(name, d);
    return d;
  };
  const recorded = (op, parts) => parts.forEach((q, i) => { const at = poseOf(q, T, geom), n = `${op.name}/d${i}`; hash.add(n, at.stem, at.pose); names.set(q.key, n); index.poses.set(q.key, at); });
  // Repaired parts are appended after the stable placements they can refer to.
  // Adding each to the hash only after recording it prevents cycles.
  const choices = new Map((edit.ops ?? []).map((o) => [o.key, o]));
  const done = new Set(), who = edit.who ?? 'human';
  for (const key of repair) {
    const p = current.get(key);
    if (!p || done.has(key)) continue;
    // A copy of a sub-build: one op, after its definition.
    const copy = p.sub && subs[p.sub.s] && copies.get(p.sub.c);
    if (copy) {
      const use = `sub-${String(p.sub.s).replace(/[^A-Za-z0-9_-]/g, '_')}`, def = defFor(use, subs[p.sub.s].parts);
      const op = def && copy.parts.every(Boolean) && copyOpFor(`copy-${String(p.sub.c).replace(/[^A-Za-z0-9_-]/g, '_')}`, use, copy.parts, def, T, geom, hash, { who });
      if (op) { if (edit.revision !== undefined) op.revision = edit.revision; ops.push(op); recorded(op, copy.parts); copy.parts.forEach((q) => done.add(q.key)); continue; }
    }
    // Parts just mirrored by their counterparts: `mirror` of a definition of the parts as they stood.
    if (mirrored.has(key) && edit.mirror.from?.length === edit.mirror.keys.length) {
      const m = edit.mirror, list = m.keys.map((k) => current.get(k)), n = 1 + Math.max(0, ...top.concat(ops).filter((o) => o.op === 'mirror' && o.keys).map((o) => +o.name.split('-')[1] || 0));
      const def = list.every(Boolean) && defFor(`mir-${n}`, m.from);
      const op = def && { op: 'mirror', name: `mirror-${n}`, of: `mir-${n}`, axis: m.axis, about: m.about, keys: m.keys, who, ...(edit.revision !== undefined ? { revision: edit.revision } : {}) };
      if (op && replays({ ops: [...def.ops, op] }, { parts: list }, T, geom).ok) { ops.push(op); recorded(op, list); list.forEach((q) => done.add(q.key)); mirrored.clear(); continue; }
      mirrored.clear();
    }
    const old = oldOps.get(key);
    const preferred = choices.get(key);
    const op = opFor(p, T, geom, hash, { who, prefer: preferred ?? old });
    if (!op) {
      if (!base) base = { op: 'base', parts: [], removed: [] };
      // Unsupported parts remain fixed, including additions and later edits.
      const exists = base.parts.some((q) => q.key === key);
      base = { ...base, parts: exists ? base.parts.map((q) => q.key === key ? snapshot(p, T, geom) : q) : [...base.parts, snapshot(p, T, geom)], removed: (base.removed ?? []).filter((k) => k !== key) };
      continue;
    }
    if (edit.revision !== undefined) op.revision = edit.revision;
    // Retain the actual fit's options when its chosen connector is still a
    // valid target. opFor has independently checked that pair at this pose.
    ops.push(preferred && preferred.to === op.to && preferred.by?.join() === op.by?.join() ? { ...preferred, name: op.name, key: op.key, id: op.id, part: op.part, color: op.color, who: op.who } : op);
    const at = poseOf(p, T, geom);
    hash.add(op.name, at.stem, at.pose); names.set(key, op.name); index.poses.set(key, at);
  }
  const ordered = [], byName = new Map(ops.map((o) => [o.name, o])), seen = new Set(), visiting = new Set();
  const visit = (o) => {
    if (seen.has(o)) return;
    if (visiting.has(o)) throw new Error('Construction record has a dependency cycle.');
    visiting.add(o);
    const parent = o.to && byName.get(unitOf(o.to));
    if (parent) visit(parent);
    visiting.delete(o); seen.add(o); ordered.push(o);
  };
  ops.forEach(visit);
  // The definitions the ops use, in the order they were first made, each returning the connectors its copies are
  // attached by.
  const wanted = new Set(ordered.map((o) => o.use ?? (o.op === 'mirror' && o.keys ? o.of : null)).filter(Boolean));
  const kept = [...new Set([...blocks.keys(), ...made])].filter((n) => wanted.has(n)).map((n) => {
    const block = made.has(n) || !blocks.has(n) ? defs.get(n).ops : blocks.get(n);
    const by = [...new Set(ordered.filter((o) => o.use === n && o.op === 'attach').map((o) => o.by))];
    return [...block.slice(0, -1), { op: 'end', ...(by.length ? { returns: Object.fromEntries(by.map((b) => [b, b])) } : {}) }];
  });
  const next = { ...program, version: 1, ops: [...(base ? [base] : []), ...kept.flat(), ...ordered] };
  indexes.set(next, index);
  return next;
}

// The attach options that put `source` ({ stem, conn }, a connector of the part being placed) on `target` ({ stem,
// conn, pose: its world frame }) so the part lands at `pose`, or null. Turns about the joint (yaw), flips and
// slides where BrickNet allows them; a ball joint by its whole orientation. placement() itself has the last word.
export function fitOf(T, target, source, pose) {
  const a = target.conn, b = source.conn;
  if (!compatible(a, b)) return null;
  const X = compose(inverse(target.pose), compose(pose, b.frame));   // the joint, in the target's frame
  const axle = a.kind === 'axle';
  if (Math.abs(X.t[0]) > EXACT || Math.abs(X.t[2]) > EXACT || (!axle && Math.abs(X.t[1]) > EXACT)) return null;
  const slide = axle ? tidy(X.t[1]) : 0;
  if (axle && Math.abs(slide) > a.length + b.length - Math.min(AXLE_MIN_OVERLAP, 2 * a.length, 2 * b.length) + 1e-8) return null;
  let opts, orient = null;
  if (Math.abs(Math.abs(X.r[4]) - 1) < EXACT) {
    const flip = X.r[4] < 0;
    if (flip && !(axle || a.kind === 'hinge')) return null;
    const Ry = flip ? mul3(X.r, RX_PI) : X.r;
    opts = { yaw: tidy((Math.atan2(Ry[2], Ry[0]) * 180) / Math.PI), ...(axle || a.kind === 'hinge' ? { flip } : {}), ...(slide ? { slide } : {}), ...(axle ? { seat: 'center' } : {}) };
  } else if (a.kind === 'ball') {
    orient = { r: pose.r.map(tidy), t: [0, 0, 0] };
    opts = { orient: [{ ldraw: [0, 0, 0, ...orient.r] }] };
  } else return null;
  try {
    const got = placement(T, target, { stem: source.stem, conn: b, pose: b.frame }, { ...opts, orient });
    return gap(got, pose) < EXACT ? opts : null;
  } catch { return null; }
}

// The placed parts' connectors in the world, by grid cell: add(name, stem, pose) as parts are placed, drop(name) as
// they go, near(point, reach) for the candidates.
export function connectorHash(T) {
  const cells = new Map(), of = new Map();
  return {
    add(name, stem, pose) {
      const mine = [];
      for (const c of T.stems.get(stem).conns) {
        const f = compose(pose, c.frame), k = cellKey(...cellOf(f.t));
        if (!cells.has(k)) cells.set(k, []);
        const e = { name, stem, conn: c, pose: f };
        cells.get(k).push(e); mine.push([k, e]);
      }
      of.set(name, mine);
    },
    drop(name) {
      for (const [k, e] of of.get(name) ?? []) { const list = cells.get(k); list.splice(list.indexOf(e), 1); }
      of.delete(name);
    },
    near(t, reach) {
      const [x, y, z] = cellOf(t), out = [];
      for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) for (let k = -reach; k <= reach; k++) { const list = cells.get(cellKey(x + i, y + j, z + k)); if (list) out.push(...list); }
      return out;
    },
  };
}

// The op for a workbench part just placed, against the parts already in `placed` (connectorHash), or null when
// BrickNet has no data for it (or it bends: a flexible part). `prefer`: the connector pair the person or agent chose
// ({ to: name.type[index], by: [type, index] }), tried first, so the record says what they did.
export function opFor(part, T, geom, placed, { who = 'human', prefer = null } = {}) {
  const at = part.flex ? null : poseOf(part, T, geom);
  if (!at) return null;
  const { stem, pose } = at;
  const head = { name: nameOf(part.key), part: stem, id: part.id, key: part.key, color: part.color, who };
  const tries = [];
  for (const c of T.stems.get(stem).conns) {
    const world = compose(pose, c.frame);
    for (const t of placed.near(world.t, c.kind === 'axle' ? REACH : 1)) {
      if (!compatible(t.conn, c)) continue;
      if (c.kind !== 'axle' && world.t.some((v, i) => Math.abs(v - t.pose.t[i]) > EXACT)) continue;
      const to = `${t.name}.${t.conn.type}[${t.conn.index}]`, by = [c.type, c.index];
      const first = prefer && prefer.to === to && prefer.by?.[0] === by[0] && prefer.by?.[1] === by[1];
      tries.push([first ? 0 : 1, t, c, to, by]);
    }
  }
  tries.sort((x, y) => x[0] - y[0]);
  for (const [, t, c, to, by] of tries) {
    const fit = fitOf(T, { stem: t.stem, conn: t.conn, pose: t.pose }, { stem, conn: c }, pose);
    if (fit) return { op: 'attach', ...head, to, by, ...fit };
  }
  return { op: 'add', ...head, pose: [{ ldraw: ldrawOf(pose).map(tidy) }] };
}

// Whether a record gives the model back: every recorded part where the model has it, in its colour. → { ok, wrong:
// [keys], why? }. `bases` as runProgram's. Parts with no op (no BrickNet data) are not compared.
export function replays(program, model, T, geom, { bases = {} } = {}) {
  let run;
  try { run = runProgram(program, T, { bases, roomForFlex: false, hoses: true }); } catch (e) { return { ok: false, wrong: [], why: e.message }; }
  const byKey = new Map(model.parts.map((p) => [p.key, p])), wrong = [], checked = new Set();
  const base = program.ops.find((o) => o.op === 'base'), removed = new Set(base?.removed ?? []);
  const ops = [...(base?.parts ?? []).map((p, i) => ({ ...p, name: `p${i}` })).filter((p) => !removed.has(p.key)), ...program.ops.filter((o) => o.op !== 'base')];
  for (const o of ops) {
    // (a copy or a mirror: its parts in its definition's order, against the parts its keys name)
    if (Array.isArray(o.keys)) {
      const occ = run.names.get(o.name), flat = occ && !occ.isPart ? flatten(occ) : [];
      o.keys.forEach((k, i) => {
        if (checked.has(k)) { wrong.push(k); return; }
        checked.add(k);
        const f = flat[i], p = byKey.get(k), want = p && poseOf(p, T, geom);
        if (!f || !want || want.stem !== f.stem || gap(f.pose, want.pose) > EXACT || (f.color ?? null) !== (p.color ?? null)) wrong.push(k);
      });
      continue;
    }
    if (o.key === undefined) continue;
    if (checked.has(o.key)) { wrong.push(o.key); continue; }
    checked.add(o.key);
    if (o.fixed) {
      const p = byKey.get(o.key);
      const fields = ['key', 'id', 'color', 'x', 'y', 'z', 'w', 'd', 'h', 'rotation', 'origin', 'extent', 'ldMatrix', 'flex'];
      if (!p || fields.some((f) => JSON.stringify(o.part[f]) !== JSON.stringify(p[f]))) wrong.push(o.key);
      continue;
    }
    const occ = run.names.get(o.name), p = byKey.get(o.key), want = p && poseOf(p, T, geom);
    if (!occ || !want || want.stem !== occ.what || gap(occ.pose, want.pose) > EXACT || (occ.color ?? null) !== (p.color ?? null)) wrong.push(o.key);
  }
  // Revision-backed legacy programs have no key metadata on their base.
  if (!base || base.parts) for (const p of model.parts) if (!checked.has(p.key)) wrong.push(p.key);
  return { ok: !wrong.length, wrong };
}

// A saved model's construction record, checked as the server checks it on save: kept when running it gives the
// saved parts back, else taken off the model (its parts and edit log stay). → whether it was kept.
export function keepRecord(model, T, geom, { bases = {} } = {}) {
  if (!model.program) return false;
  if (replays(model.program, model, T, geom, { bases }).ok) return true;
  delete model.program;
  return false;
}
