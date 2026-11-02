// Where a part's studs are, for telling what holds what. Pure: no DOM.
//
// A part's studs are the middles of the stud cells on its top, in studs
// (x, z) in the model. Most parts have one on every cell; tiles and parts
// that say so have none; a slope has a row along its high side only (45°,
// 33°, 18°, 65°, 75°), a curved, cheese or double (ridge) slope none, and an
// inverted slope a full top. A slope's high side faces −z at rotation 0 (the
// viewer turns slope geometry to match; plain LDraw slopes already do) and
// turns with the part. A part on its own matrix (a figure piece, a brick on
// its side) has no studs here: it holds by touching (lib/edit.mjs).
import { CATALOG } from './parts.mjs';
import { reach } from './figures.mjs';

const footprint = (p) => (p.rotation === 90 || p.rotation === 270 ? [p.d, p.w] : [p.w, p.d]);
const EPS = 0.05;

// Parts whose studs are not one per cell, as offsets from the footprint's
// middle at rotation 0 (from their LDraw geometry, ldraw/<id>.mpd).
// 2423 Plant Leaves 4 x 3: six open studs in a diamond, one at each end of
// the long middle line and two pairs on the outer lines between.
// 4740 Dish 2 x 2 Inverted: one stud, on its middle.
const STUDS_AT = {
  '2423': [[0, -1.5], [-1, -0.5], [1, -0.5], [-1, 0.5], [1, 0.5], [0, 1.5]],
  '4740': [[0, 0]],
};

// 'all', 'none', 'high' (the high side's row), 'middle'/'middle2' (a jumper)
// or 'listed' (STUDS_AT), from what the part is.
export function studKind(p, catalog = {}) {
  if (p.origin) return 'none';
  if (STUDS_AT[p.id]) return 'listed';
  const name = String(catalog[p.id]?.name ?? CATALOG.get(p.id)?.name ?? '');
  const slope = p.shape === 'slope' || /\bslope|\bsloped/i.test(name);
  if (slope) {
    if (/no stud/i.test(name)) return 'none';
    if (/inverted/i.test(name)) return 'all';
    if (/two studs/i.test(name)) return 'high';
    // Smooth ones: curved, cheese and other 30° x 2/3, ridges, corners, "no stud".
    if (/no stud|curved|cheese|double|triple|convex|pyramid|wedge|corner|\b30\b.*2\/3/i.test(name)) return 'none';
    return 'high';
  }
  if (p.studs === false || p.shape === 'tile' || /^tile\b/i.test(name)) return 'none';
  // A jumper: its stud (or two) on its middle line, half a stud off the grid.
  if (/jumper|center stud|with 1 stud\b/i.test(name)) return /\b(2|two) (center )?studs\b/i.test(name) ? 'middle2' : 'middle';
  return 'all';
}

// The stud middles on top of `p`: [[x, z], …].
export function studPoints(p, catalog = {}) {
  const kind = studKind(p, catalog);
  if (kind === 'none') return [];
  if (kind === 'middle') return [[p.x, p.z]];
  if (kind === 'listed') {
    // Turned with the part, as its footprint turns (x, z) → (z, −x) a quarter turn.
    const r = ((p.rotation || 0) * Math.PI) / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
    return STUDS_AT[p.id].map(([x, z]) => [p.x + x * c + z * s, p.z - x * s + z * c]);
  }
  if (kind === 'middle2') { const [fx2, fz2] = footprint(p); return fx2 >= fz2 ? [[p.x - 0.5, p.z], [p.x + 0.5, p.z]] : [[p.x, p.z - 0.5], [p.x, p.z + 0.5]]; }
  const [fx, fz] = footprint(p), x0 = p.x - fx / 2, z0 = p.z - fz / 2, out = [];
  for (let i = 0; i < Math.round(fx); i++) for (let k = 0; k < Math.round(fz); k++) out.push([x0 + i + 0.5, z0 + k + 0.5]);
  if (kind === 'all') return out;
  // The high side: −z turned by the rotation (−sin r, −cos r).
  const r = ((p.rotation || 0) * Math.PI) / 180, dx = -Math.round(Math.sin(r)), dz = -Math.round(Math.cos(r));
  const score = ([x, z]) => x * dx + z * dz, top = Math.max(...out.map(score));
  return out.filter((pt) => score(pt) > top - 0.5);
}

// Whether a point (studs) is inside part q's footprint.
export const inside = (q, [x, z]) => { const [fx, fz] = footprint(q); return Math.abs(x - q.x) < fx / 2 - EPS && Math.abs(z - q.z) < fz / 2 - EPS; };

// A part's box in millimetres [minX, minY, minZ, maxX, maxY, maxZ]: its
// footprint and height, or for a part turned off the grid its `extent`
// about its origin (lib/studio.mjs fromFree); a figure piece's reaches
// 3.5 plates under its origin (its legs; a skirt 5, figures.mjs reach).
export function boxMM(p) {
  if (p.extent) { const e = p.extent; return [(p.x + e[0]) * 8, (p.y + e[1]) * 3.2, (p.z + e[2]) * 8, (p.x + e[3]) * 8, (p.y + e[4]) * 3.2, (p.z + e[5]) * 8]; }
  const [fx, fz] = footprint(p), low = p.origin ? p.y - reach(p) : p.y;
  return [(p.x - fx / 2) * 8, low * 3.2, (p.z - fz / 2) * 8, (p.x + fx / 2) * 8, (p.y + p.h) * 3.2, (p.z + fz / 2) * 8];
}

// Hinges, clips, bars, turntables and ball joints hold by their joint, not
// by studs: turned about it, what they carry stays attached where they touch.
const nameOf = (p, catalog) => String(catalog[p.id]?.name ?? CATALOG.get(p.id)?.name ?? '');
export const jointLike = (p, catalog = {}) => !!p.flex || /\bhinge|\bclip|\bbar\b|turntable|swivel|\bball\b|socket|towball|tow ball/i.test(nameOf(p, catalog));
// A hinge's clicks: a locking hinge clicks every 22.5° (9 teeth) or 30°
// (7 teeth); other hinges and clips turn freely (null). { name, step }.
export function hingeOf(p, catalog = {}) {
  const name = nameOf(p, catalog);
  if (!/\bhinge/i.test(name)) return /\bclip|\bbar\b|turntable|swivel/i.test(name) ? { name, step: null } : null;
  if (/locking|click/i.test(name)) return { name, step: /\b7 teeth/i.test(name) ? 30 : 22.5 };
  return { name, step: null };
}

// Bricks with studs on their sides (the way sideways building starts). The
// catalogue entry's `side` says which ways they point when it is known
// (unit directions in the part's own frame, from ldraw/sidestuds.json);
// otherwise by name: "stud on 1 side", "studs on sides", headlights, brackets.
const sideOf = (p, catalog) => catalog[p.id]?.side ?? CATALOG.get(p.id)?.side;
export const sideStuds = (p, catalog = {}) => !p.origin && (sideOf(p, catalog) ? sideOf(p, catalog).length > 0 : /studs? on (\d |one |two |four )?sides?|headlight|bracket/i.test(String(catalog[p.id]?.name ?? CATALOG.get(p.id)?.name ?? '')));
// Which ways a part's studs point, and its underside (which takes studs):
// unit axes [x, y, z]. A part off the grid turns both with its matrix.
function faces(p, catalog) {
  const own = sideOf(p, catalog);
  if (p.extent && p.ldMatrix) {
    const m = p.ldMatrix, turn = (v) => [0, 1, 2].map((i) => Math.round(m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2])), d = turn([0, 1, 0]);
    return { studs: [d, ...(own ?? []).map(turn)], anti: [d.map((v) => -v)] };
  }
  if (p.origin) return { studs: [], anti: [] };
  const up = studKind(p, catalog) !== 'none' ? [[0, 1, 0]] : [];
  // Turned with the part: a quarter turn about the upright takes (x, z) to (x cos + z sin, −x sin + z cos).
  const t = ((p.rotation || 0) * Math.PI) / 180, c = Math.round(Math.cos(t)), s = Math.round(Math.sin(t));
  const side = own ? own.map(([x, y, z]) => [Math.round(x * c + z * s), Math.round(y), Math.round(-x * s + z * c)]) : sideStuds(p, catalog) ? [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] : [];
  return { studs: [...up, ...side], anti: [[0, -1, 0]] };
}
const has = (list, d) => list.some((v) => v[0] === d[0] && v[1] === d[1] && v[2] === d[2]);
// Whether two parts, at least one off the grid, are clicked together: a face
// of one against a face of the other (studs go 1.7 mm into it), over at
// least a stud's width, with studs on one face and an underside on the other.
export function faceJoin(a, b, catalog = {}) {
  const A = boxMM(a), B = boxMM(b);
  // (every way to join needs the boxes to meet to within 2.3 mm (the deepest a stud goes in, and more): most pairs asked are not near, so say so before the costly part)
  if (!(A[0] <= B[3] + 2.3 && B[0] <= A[3] + 2.3 && A[1] <= B[4] + 2.3 && B[1] <= A[4] + 2.3 && A[2] <= B[5] + 2.3 && B[2] <= A[5] + 2.3)) return false;
  const fa = faces(a, catalog), fb = faces(b, catalog);
  // A hinge or clip holds by its joint: touching is enough.
  if (jointLike(a, catalog) || jointLike(b, catalog)) return [0, 1, 2].every((k) => A[k] <= B[k + 3] + 0.5 && B[k] <= A[k + 3] + 0.5);
  for (let k = 0; k < 3; k++) {
    const o1 = (k + 1) % 3, o2 = (k + 2) % 3;
    if (Math.min(A[o1 + 3], B[o1 + 3]) - Math.max(A[o1], B[o1]) < 3 || Math.min(A[o2 + 3], B[o2 + 3]) - Math.max(A[o2], B[o2]) < 3) continue;
    for (const s of [1, -1]) {
      // b on the s side of a along axis k: a's face there meets b's opposite face.
      const gap = s > 0 ? B[k] - A[k + 3] : A[k] - B[k + 3];
      if (gap > 0.6 || gap < -2.2) continue;
      const n = [0, 0, 0]; n[k] = s;
      const m = n.map((v) => -v);
      if ((has(fa.studs, n) && has(fb.anti, m)) || (has(fa.anti, n) && has(fb.studs, m))) return true;
    }
  }
  return false;
}

// The studs that would hold `parts` (where they would go) to the rest of
// `model`: studs below going into their undersides, and their own studs
// going into parts above. [[x, y, z]] in studs and plates, y the height
// where stud meets underside. `moving`: parts not counted (being moved).
// `near(c)` (lib/place.mjs space().near): the parts in c's columns, instead
// of every part in the model (the same answer: only those can touch it).
export function engagedStuds(model, parts, moving = new Set(), near = null) {
  const out = [], mine = new Set(parts), cat = model.catalog ?? {};
  for (const c of parts) {
    if (c.origin) continue;
    const [fx, fz] = footprint(c);
    for (const q of near ? near(c) : model.parts) {
      if (q.origin || q.src || mine.has(q) || moving.has(q)) continue;
      const [gx, gz] = footprint(q);
      if (Math.abs(q.x - c.x) >= (fx + gx) / 2 || Math.abs(q.z - c.z) >= (fz + gz) / 2) continue;
      if (Math.abs(q.y + q.h - c.y) < 0.01) for (const pt of studPoints(q, cat)) if (inside(c, pt)) out.push([pt[0], c.y, pt[1]]);
      if (Math.abs(c.y + c.h - q.y) < 0.01) for (const pt of studPoints(c, cat)) if (inside(q, pt)) out.push([pt[0], q.y, pt[1]]);
    }
  }
  return out;
}

// Whether `lower`'s studs go into `upper` (upper sits on lower).
export const studsInto = (lower, upper, catalog = {}) => !upper.origin && Math.abs(lower.y + lower.h - upper.y) < 0.01 && studPoints(lower, catalog).some((pt) => inside(upper, pt));
