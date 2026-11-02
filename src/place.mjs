// Placing parts the way bricks go together. Pure: no DOM.
//
// A part held over a face of the model snaps to where it would really
// connect: on top of studs; up into the underside of an overhang (building
// downwards from a ceiling); beside a wall at the height where it sits on
// the course below or presses into the one above. Near an edge or a tight
// spot it slides along the studs to the nearest place that fits. Every place
// offered is checked: nothing in the way, and something holding it (a part
// with studs under it, or a part above for its own studs to press into; a
// minifigure needs a stud to stand on). Nothing floats.
//
// `space(model)` indexes the model by stud column (half-stud cells, as kits
// sit half a stud off in places) so a check looks only at nearby parts.
// `tables` ({ hulls, frames, joints }: the `parts` of ldraw/hulls.json,
// frames.json and joints.json) lets parts off the grid be tested by their real
// shape (lib/hulls.mjs) instead of their boxes; without it, the boxes as before.

import { STAND, legSeat, holdingLeg, studUnder, setPose, turnFigure } from './figures.mjs';
import { CATALOG } from './parts.mjs';
import { studKind, studPoints, studsInto, boxMM, faceJoin, sideStuds, jointLike } from './studs.mjs';
import { hullsFor, clashHulls, joined } from './hulls.mjs';

const footprint = (p) => (p.rotation === 90 || p.rotation === 270 ? [p.d, p.w] : [p.w, p.d]);
const near = (a, b) => Math.abs(a - b) < 0.01;
// Half-stud cells a part covers.
function cells(p) {
  const [fx, fz] = footprint(p), x0 = Math.round((p.x - fx / 2) * 2), z0 = Math.round((p.z - fz / 2) * 2), out = [];
  for (let i = 0; i < Math.max(1, Math.round(fx * 2)); i++) for (let k = 0; k < Math.max(1, Math.round(fz * 2)); k++) out.push((x0 + i) * 65536 + (z0 + k));
  return out;
}
// Any studs on top at all (a slope's high side counts; lib/studs.mjs says where).
export const hasStuds = (p, catalog = {}) => studKind(p, catalog) !== 'none';

// A plain plate or brick placed by its own LDraw matrix (a kit's 1 × 1 plate
// under a figure's feet), as an ordinary part: its origin is its top face,
// so its body is the h plates below. Figure pieces, plants and parts turned
// off upright stay out. `src`: the part itself.
export function asBrick(p, catalog = {}) {
  const e = catalog[p.id] ?? CATALOG.get(p.id), m = p.ldMatrix;
  if (!p.origin || p.extent || !e || e.shape === 'custom' || /^(tree|bush|leaves|flower)/.test(e.shape ?? '') || (m && Math.abs(m[4] - 1) > 1e-3)) return null;
  const quarter = m && Math.abs(m[0]) < 0.5;
  return { ...p, origin: false, ldMatrix: undefined, shape: e.shape === 'rectangular' ? undefined : e.shape, studs: e.studs, y: p.y - p.h, rotation: quarter ? 90 : 0, src: p };
}

// The model by column. `from` (the space of the model before some edits)
// and `edits` (what each did, oldest first: { added, removed, changed:
// [[part, …]] }): its columns, with only the parts those touched taken out
// and put back, instead of every part indexed again (on a mosaic of 16,000
// parts, a tenth of a second after every edit). `from` is spent by it.
export function space(model, from = null, edits = null, tables = null) {
  // Only solid parts take up room; plants, trees and figure pieces leave
  // space around them that their boxes do not.
  const soft = (p) => p.origin || p.shape === 'custom' || /^(tree|bush|leaves|flower)/.test(p.shape ?? '');
  // `placed`: part → what stands for it in the columns and which, to take it out again.
  let columns, placed;
  const put = (p0) => {
    const p = asBrick(p0, model.catalog) ?? p0;
    if (soft(p)) return;
    const cs = cells(p);
    for (const c of cs) { let col = columns.get(c); if (!col) columns.set(c, (col = [])); col.push(p); }
    placed.set(p0, [p, cs]);
  };
  const take = (p0) => {
    const e = placed.get(p0);
    if (!e) return;
    placed.delete(p0);
    for (const c of e[1]) { const col = columns.get(c), k = col ? col.indexOf(e[0]) : -1; if (k >= 0) col.splice(k, 1); if (col && !col.length) columns.delete(c); }
  };
  if (from?.index && edits?.length) {
    ({ columns, placed } = from.index);
    from.index = null;
    for (const e of edits) { for (const p of e.removed) take(p); for (const [p] of e.changed) { take(p); put(p); } for (const p of e.added) { take(p); put(p); } }
  } else {
    columns = new Map(); placed = new Map();
    for (const p0 of model.parts) put(p0);
  }
  const around = (p) => { const out = new Set(); for (const c of cells(p)) for (const q of columns.get(c) ?? []) out.add(q); return out; };
  // Parts turned off the grid (a brick on its side, lib/studio.mjs).
  const free = model.parts.filter((p) => p.origin && p.extent);
  // (made once: the columns are only changed while a space is built, and a space whose index was handed on is spent)
  let all = null;
  const solids = () => all ?? (all = [...new Set([...columns.values()].flat())]);
  const loose = model.parts.filter((p) => !p.origin && soft(p));
  // Boxes (mm) that pass into each other further than a stud goes into a
  // part (1.7 mm).
  const clash = (a, b) => [0, 1, 2].every((k) => Math.min(a[k + 3], b[k + 3]) - Math.max(a[k], b[k]) > 1.8);
  // Whether part c (its box b) passes into q, off the grid. By their shapes when the tables know both parts:
  // a pair that forms a joint is meant to meet (a pin in its hole, two hinge fingers) and only that pair is
  // let through; where joints.json is not given, a pair both joint-like by name; a flexible part is not
  // modelled. Otherwise by the boxes, as before, a hinge or clip let through whatever it meets
  // (`exempt`: 0 nothing, 1 when q is joint-like, 2 when q or c is).
  const fits = tables?.hulls && tables.frames ? tables : null;
  const pass = (c, b, q, exempt) => {
    const bq0 = boxMM(q);
    if (![0, 1, 2].every((k) => Math.min(b[k + 3], bq0[k + 3]) - Math.max(b[k], bq0[k]) > -1)) return false;   // far apart: no test below says otherwise, and this is cheap
    const hc = fits && hullsFor(c, fits), hq = fits && hullsFor(q.src ?? q, fits);
    if (hc && hq) {
      const bq = boxMM(q);
      if (![0, 1, 2].every((k) => Math.min(b[k + 3], bq[k + 3]) - Math.max(b[k], bq[k]) > -1)) return false;   // far apart: the shapes need not be asked
      if (c.flex || q.flex) return false;
      if (fits.joints ? joined(c, q.src ?? q, fits) : jointLike(q, model.catalog) && jointLike(c, model.catalog)) return false;
      return clashHulls(hc, hq);
    }
    return !(exempt && (jointLike(q, model.catalog) || (exempt > 1 && jointLike(c, model.catalog)))) && clash(b, boxMM(q));
  };
  return {
    // (for the next edit's space: see above)
    index: { columns, placed },
    // The solid parts in the columns part c covers (a plate under a figure's
    // feet as its brick, `src` the part itself): what it could sit on or under;
    // and the few that take up no room (plants, a designed part), wherever they are.
    near: (c) => { const out = around(c); for (const q of loose) out.add(q); return out; },
    // Something solid where part c would go?
    blocked(c, moving) {
      if (c.origin && !c.extent) return false;
      const b = boxMM(c);
      // (a hinge or clip meets what it turns into: its own box does not block)
      if (c.extent) return [...solids(), ...free].some((q) => !moving.has(q.src ?? q) && q !== c && pass(c, b, q, 2));
      for (const q of around(c)) if (!moving.has(q.src ?? q) && q.y < c.y + c.h - 1e-6 && c.y < q.y + q.h - 1e-6) return true;
      return free.some((q) => !moving.has(q) && pass(c, b, q, 0));
    },
    // The part in the way, when one is (for saying why a place is refused).
    blocker(c, moving) {
      if (c.origin && !c.extent) return null;
      if (c.extent) { const b = boxMM(c); return [...solids(), ...free].find((q) => !moving.has(q.src ?? q) && q !== c && pass(c, b, q, 1))?.src ?? null; }
      for (const q of around(c)) if (!moving.has(q.src ?? q) && q.y < c.y + c.h - 1e-6 && c.y < q.y + q.h - 1e-6) return q.src ?? q;
      const b = boxMM(c);
      return free.find((q) => !moving.has(q) && pass(c, b, q, 0)) ?? null;
    },
    // Would part c be held: a stud of the part below in its underside, or
    // its own studs in a part above (where each really has studs). With a
    // part off the grid (on its side), a face with studs against a face
    // that takes them (lib/studs.mjs faceJoin): side studs, a brick laid on
    // its side on a bracket, two tipped parts stud to underside.
    holds(c, moving) {
      if (c.origin && !c.extent) return false;
      const cat = model.catalog;
      if (c.extent) return [...solids(), ...free].some((q) => !moving.has(q.src ?? q) && q !== c && faceJoin(c, q, cat));
      for (const q of around(c)) {
        if (moving.has(q.src ?? q)) continue;
        if (studsInto(q, c, cat) || studsInto(c, q, cat)) return true;
        if (sideStuds(q, cat) && faceJoin(c, q, cat)) return true;
      }
      return free.some((f) => !moving.has(f) && faceJoin(c, f, cat));
    },
    // A minifigure's legs on a stud: the one in the hole facing down (under
    // a foot standing, the back of a thigh seated), where the part under it
    // really has a stud.
    stands(legs, moving) {
      const s = legSeat(legs);
      if (!s) return false;
      const x = legs.x + s.x, z = legs.z + s.z, top = legs.y + s.y, cell = Math.floor(x * 2 + 1e-6) * 65536 + Math.floor(z * 2 + 1e-6);
      return (columns.get(cell) ?? []).some((q) => !moving.has(q.src ?? q) && near(q.y + q.h, top) && studPoints(q, model.catalog).some(([sx, sz]) => Math.abs(sx - x) < 0.3 && Math.abs(sz - z) < 0.3));
    },
  };
}

// Where a held group of parts goes at a hit (the viewer's surfaceAt): the
// best place it can really connect, or the nearest try (ok false) to show
// in red. `held`: { parts (where they are now), anchor (the index of the part
// the pointer holds) }. `moving`: parts being moved (they do not block or
// hold). `grid`: the desk's stud offsets. Returns { parts, ok, how }.
// `exact`: only right where the pointer puts it (no sliding to a place nearby).
export function findPlacement(sp, hit, held, { moving = new Set(), grid = { ox: 0, oz: 0 }, stand = false, exact = false } = {}) {
  // A minifigure over a chair sits on it; `stand`: one taken off a chair
  // stands up again anywhere else.
  if (holdingLeg(held.parts) && SEATS[hit.part?.id]) {
    const sat = sitOn(sp, hit.part, held.parts, moving);
    if (sat) return { parts: sat, ok: true, how: 'top' };
  }
  const parts = stand ? setPose(held.parts.map((q) => ({ ...q })), { legL: 0, legR: 0 }) : held.parts;
  const a = parts[held.anchor], legs = holdingLeg(parts);
  const frac = (v) => ((v % 1) + 1) % 1;
  // A part hit that is off the grid (on its side) counts as its box.
  const hb = hit.part?.extent ? boxMM(hit.part) : null;
  const hp = hb ? { ...hit.part, x: (hb[0] + hb[3]) / 16, z: (hb[2] + hb[5]) / 16, y: hb[1] / 3.2, h: (hb[4] - hb[1]) / 3.2, w: Math.max(1, Math.round((hb[3] - hb[0]) / 8)), d: Math.max(1, Math.round((hb[5] - hb[2]) / 8)), rotation: 0 } : hit.part;
  const n = hit.normal ?? { x: 0, y: 1, z: 0 };
  // The anchor's footprint and height (a minifigure is placed by the stud its
  // legs take: `seat`, from the legs' origin; lying down, as if standing).
  const seat = legs && (legSeat(legs) ?? { x: 0, y: -STAND, z: 0 });
  // A part turned off the grid is placed by its box: its middle, underside and size.
  const e = !legs && a.extent;
  const ref = legs ?? (e ? { x: a.x + (e[0] + e[3]) / 2, y: a.y + e[1], z: a.z + (e[2] + e[5]) / 2 } : a);
  const [fx, fz] = legs ? [1, 1] : e ? [Math.max(1, Math.round(e[3] - e[0])), Math.max(1, Math.round(e[5] - e[2]))] : footprint(a);
  const h = legs ? 1 : e ? e[4] - e[1] : a.h;
  let ox = grid.ox, oz = grid.oz;
  if (hp) { const [hx, hz] = footprint(hp); ox = frac(hp.x - hx / 2); oz = frac(hp.z - hz / 2); }
  // On top, under, or beside: by the face hit, but a hit at stud height (the
  // side of a stud) is on top, and so is one on the top plate's worth of a
  // taller part's side (aiming at a brick's upper edge means "on it", and the
  // ghost does not flicker between on and beside); the very bottom is under.
  const topZone = hp && hp.h >= 3 ? 1 : 0.05;
  const how = !hp ? 'desk' : n.y > 0.5 || hit.point.y >= hp.y + hp.h - topZone ? 'top' : n.y < -0.5 || hit.point.y <= hp.y + 0.05 ? 'under' : 'side';
  // What is held, as one: each solid part's box from the anchor (`ref`), in
  // studs and plates (a minifigure is placed by its legs alone).
  const solid = legs ? [] : parts.filter((q) => !q.origin || q.extent);
  const boxes = solid.map((q) => { const b = boxMM(q); return [b[0] / 8 - ref.x, b[1] / 3.2 - ref.y, b[2] / 8 - ref.z, b[3] / 8 - ref.x, b[4] / 3.2 - ref.y, b[5] / 8 - ref.z]; });
  const bottoms = boxes.map((b) => b[1]), tops = boxes.map((b) => b[4]);
  const lo = Math.min(0, ...bottoms), hi = Math.max(h, ...tops);
  const [x0, z0, x1, z1] = [[0, -fx / 2], [2, -fz / 2], [3, fx / 2], [5, fz / 2]].map(([k, v], i) => (i < 2 ? Math.min : Math.max)(v, ...boxes.map((b) => b[k])));
  // Where the pointer is, and which way out of the face: beside, what is held
  // goes against the face by its side nearest it (with several parts, not
  // only the anchor's), wherever along the face it was held.
  let px = hit.point.x, pz = hit.point.z, out = null;
  if (how === 'side') { if (Math.abs(n.x) >= Math.abs(n.z)) { out = 'x'; px += n.x > 0 ? 0.01 - x0 : -0.01 - x1; } else { out = 'z'; pz += n.z > 0 ? 0.01 - z0 : -0.01 - z1; } }
  // The part stays where it is held under the pointer: `held.grab` is the
  // point it was picked up by, from its middle (studs); a new part is held
  // by its middle. Snapped to the nearest place on the studs.
  const g = (!legs && !e && held.grab) || { x: 0, z: 0 };
  const gx = out === 'x' ? 0 : g.x, gz = out === 'z' ? 0 : g.z;
  const cx0 = Math.round(px - gx - fx / 2 - ox) + ox + fx / 2, cz0 = Math.round(pz - gz - fz / 2 - oz) + oz + fz / 2;
  // Heights to try (of the anchor's underside): on top, under, or (beside)
  // every course near the pointer. Several parts held go down as one: on a
  // top, the lowest of them rests on it (the anchor is whichever part the
  // pointer took, often not the lowest), then each other part's underside in
  // turn, highest first (the lowest may hang past the edge of what it is set
  // on); under an overhang, the highest presses up into it.
  const uniq = (vs) => [...new Set(vs.map((v) => Math.round(v * 1e6) / 1e6))];
  let ys;
  if (how === 'top') ys = uniq([0, ...bottoms].map((b) => hp.y + hp.h - b)).sort((u, v) => v - u);
  else if (how === 'under') ys = uniq([h, ...tops].map((t) => hp.y - t)).sort((u, v) => u - v);
  else if (how === 'side') { const at = hit.point.y; ys = []; for (let y = Math.floor(at - hi - 3); y <= Math.ceil(at - lo + 3); y++) ys.push(y); ys.sort((u, v) => Math.abs(u + h / 2 - at) - Math.abs(v + h / 2 - at)); }
  else ys = [-lo];
  // Small slides along the studs, nearest first (not across the face hit).
  const slides = [];
  for (let dx = -(fx - 1); dx <= fx - 1; dx++) for (let dz = -(fz - 1); dz <= fz - 1; dz++) slides.push([dx, dz]);
  slides.sort((u, v) => Math.hypot(...u) - Math.hypot(...v));
  const at = (x, y, z) => {
    if (seat) { x -= seat.x; y -= seat.y; z -= seat.z; }
    const dx = x - ref.x, dz = z - ref.z, dy = y - ref.y;
    return parts.map((q) => ({ ...q, x: q.x + dx, z: q.z + dz, y: q.y + dy }));
  };
  // The same question asked again (the pointer moving within one stud asks
  // it many times a second, and on a big model each answer takes a while):
  // the answer given, for as long as the model's index (`sp`) is the same.
  // The held parts are part of the question whole: the answer is copies of them.
  const memo = memoFor(sp), key = memo && [how, cx0, cz0, ys.join(','), exact ? 1 : 0, stand ? 1 : 0, idOf(moving), held.anchor, JSON.stringify(parts)].join('|');
  if (memo?.has(key)) return memo.get(key);
  const answer = search();
  if (memo) { if (memo.size > 4000) memo.clear(); memo.set(key, answer); }
  return answer;
  function search() {
    const works = (placed) => placed.every((c) => c.y >= -1e-6 && !sp.blocked(c, moving)) && (legs ? sp.stands(placed[parts.indexOf(legs)], moving) : placed.some((c) => sp.holds(c, moving)));
    let first = null, tries = 0;
    for (const y of ys) {
      for (const [dx, dz] of exact ? [[0, 0]] : slides) {
        if (++tries > 240) break;
        const placed = at(cx0 + dx, y, cz0 + dz);
        first ??= placed;
        if (works(placed)) return { parts: placed, ok: true, how };
      }
    }
    // Nothing fits under the pointer: the nearest place a little further
    // along the same surface (up to 3 studs past the part's own size), so a
    // big part aimed next to a wall slides clear of it instead of refusing.
    if (!exact && (how === 'top' || how === 'under')) {
      const wide = [];
      for (let dx = -(fx + 2); dx <= fx + 2; dx++) for (let dz = -(fz + 2); dz <= fz + 2; dz++) if (Math.abs(dx) > fx - 1 || Math.abs(dz) > fz - 1) wide.push([dx, dz]);
      wide.sort((u, v) => Math.hypot(...u) - Math.hypot(...v));
      for (const [dx, dz] of wide.slice(0, 260)) {
        const placed = at(cx0 + dx, ys[0], cz0 + dz);
        if (works(placed)) return { parts: placed, ok: true, how };
      }
    }
    // Why not, for the place under the pointer: in the way of a part (named),
    // or nothing to hold it.
    const tried = first ?? at(cx0, ys[0] ?? 0, cz0);
    const blocker = tried.map((c) => (c.y < -1e-6 ? null : sp.blocker?.(c, moving))).find(Boolean) ?? null;
    return { parts: tried, ok: false, how, why: blocker ? 'blocked' : 'loose', blocker };
  }
}
// Answers by index (a fresh index, after an edit, starts with none), and an
// id per set of moving parts (a drag keeps one set throughout).
const memos = new WeakMap(), ids = new WeakMap();
let nextId = 1;
const memoFor = (sp) => { if (!sp || typeof sp !== 'object') return null; if (!memos.has(sp)) memos.set(sp, new Map()); return memos.get(sp); };
const idOf = (set) => (!set?.size ? 0 : ids.get(set) ?? (ids.set(set, nextId), nextId++));

// A figure set back on the studs after its legs moved (sitting down,
// standing up): moved whole so the hole now facing down takes the stud the
// old one was on, or else the nearest stud on the same surface it can (up
// to 2 studs away). `was`: the stud it was on (studUnder). Returns the
// moved parts (copies), or null.
export function reseat(sp, parts, was, moving = new Set(parts)) {
  const now = studUnder(parts), i = parts.indexOf(holdingLeg(parts));
  if (!now || !was) return null;
  const tries = [];
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) tries.push([dx, dz]);
  tries.sort((u, v) => Math.hypot(...u) - Math.hypot(...v));
  for (const [dx, dz] of tries) {
    const ox = was.x + dx - now.x, oy = was.y - now.y, oz = was.z + dz - now.z;
    const placed = parts.map((q) => ({ ...q, x: q.x + ox, y: q.y + oy, z: q.z + oz }));
    if (placed.every((c) => c.y >= -1e-6) && sp.stands(placed[i], moving)) return placed;
  }
  return null;
}

// ---- chairs
// Chairs a minifigure sits on by itself: the studs its thighs take, (x, z)
// in studs from the chair's centre as it is unturned, when the chair's front
// (and the sitter) faces +z.
const SEATS = { 4079: { studs: [[-0.5, 0.5], [0.5, 0.5]] } };
export const isChair = (p) => !!SEATS[p?.id];
// A part turned `rotation` degrees about y (as the viewer turns it): where
// its (x, z) offset goes.
const turned = (x, z, rotation) => { const t = ((rotation || 0) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return [x * c + z * s, -x * s + z * c]; };
// Figure `parts` (copies) seated on `chair`: legs out in front, turned to
// face the way the chair does, a thigh on each seat stud. Null when it would
// not hold.
export function sitOn(sp, chair, parts, moving = new Set()) {
  const fig = setPose(parts.map((q) => ({ ...q, ldMatrix: q.ldMatrix && [...q.ldMatrix] })), { legL: -90, legR: -90 });
  const torso = fig.find((q) => /^973/.test(q.id)), [fx, fz] = turned(0, 1, chair.rotation);
  // A quarter turn at a time until it faces the chair's front (+z of the torso).
  for (let i = 0; i < 4 && torso && torso.ldMatrix[2] * fx + torso.ldMatrix[8] * fz < 0.9; i++) turnFigure(fig);
  const legs = holdingLeg(fig), other = fig.find((q) => q !== legs && /^381[67]/.test(q.id));
  const s = legs && legSeat(legs), s2 = other && legSeat(other);
  if (!s) return null;
  const top = chair.y + chair.h, studs = SEATS[chair.id].studs.map(([x, z]) => { const [dx, dz] = turned(x, z, chair.rotation); return [chair.x + dx, chair.z + dz]; });
  // The stud for the holding leg's thigh: the one that puts the other thigh on the other stud.
  for (const [tx, tz] of studs) {
    const ox = tx - s.x, oz = tz - s.z;
    if (s2 && !studs.some(([ux, uz]) => Math.hypot(ox + s2.x - ux, oz + s2.z - uz) < 0.05 && (ux !== tx || uz !== tz))) continue;
    const dx = ox - legs.x, dy = top - s.y - legs.y, dz = oz - legs.z;
    const placed = fig.map((q) => ({ ...q, x: q.x + dx, y: q.y + dy, z: q.z + dz }));
    if (sp.stands(placed[fig.indexOf(legs)], moving)) return placed;
  }
  return null;
}
// The chair a placed figure sits on, or null.
export function chairUnder(model, parts) {
  const at = studUnder(parts);
  if (!at) return null;
  return model.parts.find((q) => isChair(q) && Math.abs(q.y + q.h - at.y) < 0.01 && Math.abs(q.x - at.x) < Math.max(q.w, q.d) / 2 && Math.abs(q.z - at.z) < Math.max(q.w, q.d) / 2) ?? null;
}
