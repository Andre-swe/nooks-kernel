// Checks a person sees while building (docs/BUILD_BY_CONNECTOR.md, piece 3), alongside lib/benchmark.mjs evaluate:
// connections that are nearly made but not exactly (BrickAgent's "non-exact connection"), and a parts limit, the
// set a build is made from (BrickAgent's BRICKAGENT_SET). Pure: the caller passes BrickNet's tables (lib/bricknet.mjs
// load) and a frame lookup (lib/frames.mjs framesFrom).
import { compose } from './pose.mjs';
import { connections } from './assembly.mjs';
import { poseOf } from './bridge.mjs';
import { fitOf } from './record.mjs';
import { partKey } from './benchmark.mjs';
import { compatible } from './bricknet.mjs';
import { connectivity } from './edit.mjs';
import { worldBox, isFigurePiece } from './studio.mjs';

// Incremental live checks. The caller keeps a spatial index and passes the
// changed keys. Findings elsewhere survive; no whole-model connector graph is
// rebuilt for a one-part edit. Floating comes from the editor's existing graph.
export function liveCheck(model, T, geom, { only, index, space, previous = null } = {}) {
  const keys = only ?? new Set(model.parts.map((p) => p.key));
  const byKey = new Map(model.parts.map((p) => [p.key, p]));
  // (the whole model: every part is checked, so there are no neighbours to gather)
  const nearby = only ? new Map() : byKey;
  if (only) for (const key of keys) {
    const p = byKey.get(key);
    if (!p) continue;
    nearby.set(key, p);
    const at = !p.flex && poseOf(p, T, geom);
    if (at && index) for (const c of T.stems.get(at.stem).conns) {
      const point = compose(at.pose, c.frame).t;
      for (const e of index.hash.near(point, c.kind === 'axle' ? 3 : 1)) {
        if (!compatible(c, e.conn)) continue;
        const reach = c.kind === 'axle' ? c.length + e.conn.length + 3 : 3;
        if (point.some((v, i) => Math.abs(v - e.pose.t[i]) > reach)) continue;
        const q = index.byName.get(e.name);
        if (q) nearby.set(q.key, q);
      }
    }
  }
  const inexact = [...(previous?.inexact ?? []).filter((e) => !e.keys.some((k) => keys.has(k))), ...inexactConnections({ parts: [...nearby.values()] }, T, geom, { only: keys })];
  const collisions = (previous?.collisions ?? []).filter((e) => !e.keys.some((k) => keys.has(k)));
  // (a minifigure stands by its own rules, its hips on a stud and its pieces fitted to each other: not an overlap)
  for (const key of keys) {
    const p = byKey.get(key), q = p && !isFigurePiece(p.id) && space?.blocker(p, new Set([p])), o = q && (q.src ?? q);
    if (o && !isFigurePiece(o.id)) collisions.push({ keys: [key, o.key] });
  }
  const limit = model.limit ? partsLimit(model, model.limit) : { over: [], absent: [] };
  const floating = model.validation?.floating ?? [];
  return { inexact, collisions, floating, over: limit.over, absent: limit.absent, count: inexact.length + collisions.length + floating.length + limit.over.length + limit.absent.length };
}

// ---- builds, scenes and faults
// Parts held by nothing are not all mistakes. A scene places separate objects together: a cup on a table, a chair
// by it, a figure on the floor, each holding together on its own and resting where it is put. A chair whose leg is
// only pushed up against the seat is a mistake: that leg holds something up, or leans on something, without being
// attached. They are told apart by how each unattached group (parts joined to each other but not to the rest) meets
// the parts around it:
//   - it rests: it meets others only from above, sitting on top of them (or on the desk), and nothing sits on it;
//     it is a placed object;
//   - it holds something up (something else sits on it), is pushed into another part, or hangs in the air with
//     nothing below: it is a fault. Standing against another's side is allowed: a chair pushed up to a table.
// → { kind: 'build' | 'scene' | 'faulty', objects, loose, faults, faultParts, qualified, whole }
//   kind     'build': every part held; 'scene': unattached objects, all resting; 'faulty': at least one fault
//   objects  how many separate objects (1 for a build)
//   loose    parts held by nothing; faults: the faulty groups, with faultParts their part keys
//   qualified  structurally sound throughout: a build, or a scene whose every object holds together and rests
//   whole    one object: what a kit or a benchmark that asks for one assembly needs
// Figures' parts hold by what they touch (lib/edit.mjs connectivity), so a figure is one object; a figure group
// left unattached is taken as standing where it is put.
const EPS = 1e-6;
const footprintOf = (p) => (p.rotation === 90 || p.rotation === 270 ? [p.d ?? 1, p.w ?? 1] : [p.w ?? 1, p.d ?? 1]);
export function buildClass(model, { groupOf = null } = {}) {
  const parts = model?.parts ?? [], v = model?.validation;
  if (!parts.length) return { kind: 'build', objects: 0, loose: 0, faults: 0, faultParts: [], qualified: false, whole: false };
  const floating = Array.isArray(v?.floating) ? new Set(v.floating) : null;
  if (v?.valid === true && (!floating || !floating.size)) return { kind: 'build', objects: 1, loose: 0, faults: 0, faultParts: [], qualified: true, whole: true };
  if (!floating) return { kind: 'faulty', objects: null, loose: floating?.size ?? null, faults: null, faultParts: [], qualified: false, whole: false };
  groupOf ??= connectivity(model).groupOf;
  // Groups by the connectivity's own grouping (0 is the main one); only groups holding a part held by nothing count.
  const byGroup = new Map();
  for (const p of parts) { const g = groupOf.get(p.key) ?? 0; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(p); }
  const box = (p) => { const [fx, fz] = footprintOf(p); return { x0: p.x - fx / 2, x1: p.x + fx / 2, z0: p.z - fz / 2, z1: p.z + fz / 2, y0: p.y, y1: p.y + (p.h ?? 3) }; };
  const boxes = new Map(parts.map((p) => [p, box(p)]));
  let floor = Infinity;
  for (const p of parts) if (!p.origin && p.y < floor) floor = p.y;
  const over = (a0, a1, b0, b1) => a0 < b1 - EPS && b0 < a1 - EPS;                 // overlap with some area
  // Others by column, so a group asks only its neighbourhood.
  const cells = new Map(), cellKey = (x, z) => `${x},${z}`;
  for (const p of parts) { const b = boxes.get(p); for (let x = Math.floor(b.x0) - 1; x <= Math.ceil(b.x1); x++) for (let z = Math.floor(b.z0) - 1; z <= Math.ceil(b.z1); z++) { const k = cellKey(x, z); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(p); } }
  let objects = 0, loose = 0;
  const faultParts = [];
  let faults = 0;
  for (const [g, group] of byGroup) {
    objects++;
    if (!group.some((p) => floating.has(p.key))) continue;
    loose += group.length;
    if (group.some((p) => p.origin)) continue;                                      // a figure standing where it is put
    const mine = new Set(group);
    let rests = group.some((p) => Math.abs(p.y - floor) < EPS), fault = false;
    for (const p of group) {
      const a = boxes.get(p), seen = new Set();
      for (let x = Math.floor(a.x0); x <= Math.ceil(a.x1) - 1 && !fault; x++) for (let z = Math.floor(a.z0); z <= Math.ceil(a.z1) - 1 && !fault; z++) for (const q of cells.get(cellKey(x, z)) ?? []) {
        if (mine.has(q) || seen.has(q) || q.origin) continue;
        seen.add(q);
        const b = boxes.get(q), xz = over(a.x0, a.x1, b.x0, b.x1) && over(a.z0, a.z1, b.z0, b.z1);
        if (xz && Math.abs(a.y0 - b.y1) < EPS) rests = true;                            // sits on q
        else if (xz && Math.abs(a.y1 - b.y0) < EPS) fault = true;                      // q sits on it: it holds q up
        else if (xz && over(a.y0, a.y1, b.y0, b.y1)) fault = true;                    // inside another part
        if (fault) break;
      }
    }
    if (fault || !rests) { faults++; for (const p of group) faultParts.push(p.key); }
  }
  const kind = faults ? 'faulty' : loose ? 'scene' : 'build';
  return { kind, objects, loose, faults, faultParts, qualified: !faults, whole: objects === 1 && !faults };
}

// ---- inexact connections
// BrickNet's graph joins connectors within a tolerance (3 LDU, a few degrees). A join it finds that no exact fit
// gives is inexact: a part nudged a little off, or a file's rounding. → [{ a, b, keys: [a, b], where, off: LDU,
// degrees }] by part key, `where` the two connectors ("stud[3] of 3001 to hole[0] of 3003"). `only`: a Set of keys;
// when given, joins touching other parts only are skipped (the parts an edit changed).
export function inexactConnections(model, T, geom, { only = null } = {}) {
  const flat = [], keyAt = [];
  for (const p of model.parts) {
    const at = p.flex ? null : poseOf(p, T, geom);
    if (at) { flat.push({ stem: at.stem, pose: at.pose, where: String(p.key), figure: isFigurePiece(p.id) }); keyAt.push(p.key); }
  }
  const { edges } = connections(null, T, flat), out = [];
  for (const [i, ci, j, cj] of edges) {
    if (only && !only.has(keyAt[i]) && !only.has(keyAt[j])) continue;
    // (a minifigure's joints are posed by lib/figures.mjs, turned to any angle: two of its pieces never nearly miss)
    if (flat[i].figure && flat[j].figure) continue;
    const A = flat[i], B = flat[j], ca = T.stems.get(A.stem).conns[ci], cb = T.stems.get(B.stem).conns[cj];
    const target = { stem: A.stem, conn: ca, pose: compose(A.pose, ca.frame) };
    if (fitOf(T, target, { stem: B.stem, conn: cb }, B.pose)) continue;
    const fb = compose(B.pose, cb.frame), off = Math.hypot(...target.pose.t.map((v, k) => v - fb.t[k]));
    const ya = [target.pose.r[1], target.pose.r[4], target.pose.r[7]], yb = [fb.r[1], fb.r[4], fb.r[7]];
    const cos = Math.abs(ya[0] * yb[0] + ya[1] * yb[1] + ya[2] * yb[2]);
    out.push({
      a: keyAt[i], b: keyAt[j], keys: [keyAt[i], keyAt[j]],
      where: `${ca.type}[${ca.index}] of ${A.stem} to ${cb.type}[${cb.index}] of ${B.stem}`,
      off: +off.toFixed(3), degrees: +((Math.acos(Math.min(1, cos)) * 180) / Math.PI).toFixed(2),
    });
  }
  return out;
}

// ---- the parts limit
// A set's inventory as lib/benchmark.mjs normaliseInventory gives it ({ id: { colour: count | null } | null }),
// against a model: what is left of each, what is over and what is not in the set. → { left(id, colour) → count
// (Infinity when any number may be used), allows(id), colours(id) → [codes] | null (any), over: [{ id, color, used,
// limit, keys }], absent: [{ id, keys }] }. The parts past a count are the last ones placed of their kind.
export function partsLimit(model, inventory) {
  const used = new Map(), keys = new Map(), absent = new Map();
  for (const p of model.parts) {
    const id = partKey(p.id), allowed = inventory[id];
    if (allowed === null) continue;
    if (allowed === undefined) { if (!absent.has(id)) absent.set(id, []); absent.get(id).push(p.key); continue; }
    const k = `${id}|${p.color}`;
    used.set(k, (used.get(k) ?? 0) + 1);
    if (!keys.has(k)) keys.set(k, []);
    keys.get(k).push(p.key);
  }
  const limitOf = (id, colour) => { const a = inventory[partKey(id)]; return a === null ? Infinity : a === undefined ? 0 : a[colour] === null ? Infinity : a[colour] ?? 0; };
  const over = [];
  for (const [k, n] of used) {
    const [id, c] = k.split('|'), limit = limitOf(id, Number(c));
    if (n > limit) over.push({ id, color: Number(c), used: n, limit, keys: keys.get(k).slice(limit) });
  }
  return {
    left: (id, colour) => Math.max(0, limitOf(id, colour) - (used.get(`${partKey(id)}|${colour}`) ?? 0)),
    allows: (id) => inventory[partKey(id)] !== undefined,
    colours: (id) => { const a = inventory[partKey(id)]; return a === null || a === undefined ? (a === null ? null : []) : Object.keys(a).map(Number); },
    over,
    absent: [...absent].map(([id, k]) => ({ id, keys: k })),
  };
}

// "Swap for one in the set": for a part past its count, the same part in the colours the set still has some of,
// most left first. → [{ color, left }]
export function swapsFor(model, inventory, id) {
  const L = partsLimit(model, inventory), colours = L.colours(id);
  return (colours ?? []).map((c) => ({ color: c, left: L.left(id, c) })).filter((s) => s.left > 0).sort((a, b) => b.left - a.left);
}

// "Show what holds it": the parts a loose part touches (its box meets theirs, lib/studio.mjs worldBox), which it
// rests against without being joined to. → keys, nearest first.
export function touching(model, key, { mm = 0.05 } = {}) {
  const p = model.parts.find((q) => q.key === key);
  if (!p) return [];
  const a = worldBox(p), out = [];
  for (const q of model.parts) {
    if (q === p) continue;
    const b = worldBox(q);
    if ([0, 1, 2].every((k) => a[k] <= b[k + 3] + mm && b[k] <= a[k + 3] + mm)) out.push([q.key, Math.hypot(...[0, 1, 2].map((k) => (a[k] + a[k + 3] - b[k] - b[k + 3]) / 2))]);
  }
  return out.sort((x, y) => x[1] - y[1]).map(([k]) => k);
}

// A parts list as a CSV (one row a part and colour: a part number, a colour as its number or name, a count) as an
// inventory for lib/benchmark.mjs normaliseInventory. The header names the columns ("part", "colour" or "color",
// "quantity", "qty" or "count", in any order); without one they are part, colour, count. `colourCode(name)`: a
// colour's number from its name, or undefined. Throws naming the first row it can't read.
export function inventoryFromCSV(text, colourCode = () => undefined) {
  const rows = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"(.*)"$/, '$1')));
  if (!rows.length) throw new Error('The parts list is empty.');
  const head = rows[0].map((h) => h.toLowerCase());
  const col = (re) => head.findIndex((h) => re.test(h));
  let [ip, ic, iq] = [col(/^(part|part ?(no|num|number|id)|design ?id|element|item ?(no|id)|id)$/), col(/^colou?r( ?(id|code|name))?$/), col(/^(qty|quantity|count|amount|number)$/)];
  const header = ip >= 0;
  if (!header) [ip, ic, iq] = [0, 1, 2];
  const out = {};
  rows.slice(header ? 1 : 0).forEach((r, n) => {
    const id = partKey(r[ip] ?? ''), c = r[ic] ?? '', q = r[iq] === undefined || r[iq] === '' ? 1 : Number(r[iq]);
    const code = /^\d+$/.test(c) ? Number(c) : colourCode(c);
    if (!id || code === undefined || !Number.isInteger(q) || q < 0) throw new Error(`Row ${n + (header ? 2 : 1)} of the parts list: give a part number, a colour and a count.`);
    out[id] ??= {};
    out[id][code] = (out[id][code] ?? 0) + q;
  });
  if (!Object.keys(out).length) throw new Error('The parts list has no parts.');
  return out;
}

// A model's own parts as an inventory, so one of our kits can be the set another build is made from.
export function inventoryOf(model) {
  const out = {};
  for (const p of model.parts) {
    const id = partKey(p.id);
    out[id] ??= {};
    out[id][p.color] = (out[id][p.color] ?? 0) + 1;
  }
  return out;
}
