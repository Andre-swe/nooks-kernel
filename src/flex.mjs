// Flexible parts (the workbench's flex tool): hoses and strings laid along a
// curve between two points. Pure: no DOM.
//
// A flexible part is drawn through its control points (millimetres, from
// its start) as a smooth curve, the same one the viewer draws (a uniform
// Catmull-Rom spline, ends extended straight). Its length on that curve picks
// the stock part: the shortest one at least that long, as these parts come
// in set lengths (L = studs, 8 mm). It holds where its ends touch parts.

import { boxMM } from './studs.mjs';

export const STUD_MM = 8, PLATE_MM = 3.2;
// Hoses and strings are off for now (owner, 2026-10-25): the workbench's flex tool and the build programs' flex op are
// switched off, so agents and people build with what BrickAgent builds with. A saved build with a hose still opens and
// shows it. Set true to bring them back.
export const HOSES = false;
export const HOSES_OFF = 'Hoses and strings are switched off for now. Build with rigid parts.';
const lengths = (from, to, step = 1) => { const out = []; for (let v = from; v <= to + 1e-9; v += step) out.push(+v.toFixed(3)); return out; };
// Each kind: its name, thickness (mm) and the stock lengths it comes in (id → L).
export const FLEX = {
  ribbed: { name: 'Hose, Ribbed 7mm D.', radius: 3.5, colour: 0, stock: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 23, 24, 25, 26, 28, 30, 31, 32].map((L) => [`78c${String(L).padStart(2, '0')}`, L]) },
  pneumatic: { name: 'Hose, Pneumatic 4mm D.', radius: 2, colour: 0, stock: lengths(2, 23).map((L) => [`5102c${String(L).padStart(2, '0')}`, L]) },
  soft: { name: 'Hose Soft 3mm D.', radius: 1.5, colour: 72, stock: [5, 7, 9, 12].map((L) => [`46215c${String(L).padStart(2, '0')}`, L]) },
  string: { name: 'String with End Studs', radius: 0.7, colour: 0, stock: [11, 21, 31, 41].map((L) => [`14226c${L}`, L]) },
};
export const kindOf = (id) => Object.entries(FLEX).find(([, k]) => k.stock.some(([sid]) => sid === id))?.[0] ?? null;

// Points along the curve through `pts` ([[x, y, z] …]), `per` a span.
export function samples(pts, per = 16) {
  if (pts.length < 2) return pts.map((p) => [...p]);
  const P = [pts[0].map((v, k) => 2 * v - pts[1][k]), ...pts, pts[pts.length - 1].map((v, k) => 2 * v - pts[pts.length - 2][k])];
  const out = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    for (let s = 0; s < per; s++) {
      const t = s / per, t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  out.push([...pts[pts.length - 1]]);
  return out;
}
export const curveLength = (pts) => { const s = samples(pts); let L = 0; for (let i = 1; i < s.length; i++) L += Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1], s[i][2] - s[i - 1][2]); return L; };

// The stock part for a length (mm): the shortest that reaches, or null when none is long enough.
export function stockFor(kind, mm) {
  const L = mm / STUD_MM, k = FLEX[kind];
  const hit = k?.stock.find(([, l]) => l >= L - 0.05);
  return hit ? { id: hit[0], L: hit[1], name: `${k.name} ${hit[1]}L` } : null;
}

// The default shape between two ends (mm, world): a gentle sag below the
// straight line, or an arch over it when it runs along the floor.
export function defaultPoints(a, b) {
  const mid = [0, 1, 2].map((k) => (a[k] + b[k]) / 2), d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  mid[1] += d * 0.22 * (Math.abs(b[1] - a[1]) < d * 0.3 ? 1 : -1);
  return [a, mid, b];
}

// A flexible part along world points `pts` (mm), of `kind`, in `colour`:
// placed at its first point (studs and plates), the points kept relative to
// it, its box and stock part from the curve. Null when it is longer than
// any stock length.
export function flexPart(kind, colour, pts, extra = {}) {
  const k = FLEX[kind], len = curveLength(pts), stock = stockFor(kind, len);
  if (!k || !stock) return null;
  const [o] = pts, rel = pts.map((p) => p.map((v, i) => +(v - o[i]).toFixed(3)));
  const s = samples(rel), lo = [0, 1, 2].map((i) => Math.min(...s.map((p) => p[i])) - k.radius), hi = [0, 1, 2].map((i) => Math.max(...s.map((p) => p[i])) + k.radius);
  return {
    ...extra, id: stock.id, color: colour, x: o[0] / STUD_MM, y: o[1] / PLATE_MM, z: o[2] / STUD_MM, rotation: 0,
    w: Math.max(1, Math.round((hi[0] - lo[0]) / STUD_MM)), d: Math.max(1, Math.round((hi[2] - lo[2]) / STUD_MM)), h: Math.max(1, Math.round((hi[1] - lo[1]) / PLATE_MM)),
    origin: true, studs: false, ldMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    extent: [lo[0] / STUD_MM, lo[1] / PLATE_MM, lo[2] / STUD_MM, hi[0] / STUD_MM, hi[1] / PLATE_MM, hi[2] / STUD_MM],
    flex: { kind, points: rel, length: +(len / STUD_MM).toFixed(2) },
    name: stock.name,
  };
}
// Its control points in the world (mm).
export const worldPoints = (p) => p.flex.points.map((q) => [q[0] + p.x * STUD_MM, q[1] + p.y * PLATE_MM, q[2] + p.z * STUD_MM]);

// ---- room for a hose: what its curve passes through. A hose is a tube of its kind's radius along the curve. It
// passes through a part when the tube goes into the part's box further than its soft wall gives (SINK), and
// through another hose when the two tubes overlap as far. Near an end it may run along the part that end is on
// (the end sits on that part's face, so the first few millimetres graze it). An end is on a part when it is within
// TOUCH of the part's box past the tube's wall (a stud's height, nearly: an end set on studs).
export const TOUCH = 2.5, SINK = 0.6;
const distBox = (p, b) => Math.hypot(...[0, 1, 2].map((k) => Math.max(b[k] - p[k], 0, p[k] - b[k + 3])));
// The tube's centre line (mm, world), no two points further apart than `step`, with the distance along it.
function path(pts, step) {
  const s = samples(pts), out = [{ at: s[0], arc: 0 }];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i], len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), n = Math.max(1, Math.ceil(len / step)), arc = out.at(-1).arc;
    for (let k = 1; k <= n; k++) out.push({ at: a.map((v, j) => v + ((b[j] - v) * k) / n), arc: arc + (len * k) / n });
  }
  return out;
}

// Whether flexible part `part` has room where it is. `boxes`: the solid parts near it, [{ box: [x0, y0, z0, x1, y1,
// z1] (mm, world), part? }]; `tubes`: other flexible parts, [{ points (world mm control points), radius, part? }].
// `ends`: also that both its ends are on a part (a hose put in place runs from part to part).
// → { ok, why: null | 'through' | 'end', through: [the box or tube entries it passes into], loose: [ends on nothing, 0 or 1] }.
export function flexCheck(part, boxes, tubes = [], { ends = false } = {}) {
  const r = FLEX[part.flex.kind].radius, line = path(worldPoints(part), Math.max(0.5, r / 2)), L = line.at(-1).arc;
  const tips = [line[0].at, line.at(-1).at];
  // The boxes each end is on, and how far along the curve a hose may graze them.
  const on = tips.map((t) => new Set(boxes.filter((b) => distBox(t, b.box) <= r + TOUCH)));
  const graze = Math.max(3 * r, 6);
  const nearEnd = (b, arc) => (arc < graze && on[0].has(b)) || (L - arc < graze && on[1].has(b));
  const through = [];
  for (const b of boxes) {
    if (line.some(({ at, arc }) => distBox(at, b.box) < r - SINK && !nearEnd(b, arc))) through.push(b);
  }
  for (const t of tubes) {
    const other = path(t.points, Math.max(0.5, t.radius / 2)), M = other.at(-1).arc, reach = r + t.radius - SINK;
    const free = (arc, len) => arc >= graze && len - arc >= graze;
    if (line.some((a) => free(a.arc, L) && other.some((o) => free(o.arc, M) && Math.hypot(a.at[0] - o.at[0], a.at[1] - o.at[1], a.at[2] - o.at[2]) < reach))) through.push(t);
  }
  const loose = ends ? [0, 1].filter((k) => !on[k].size) : [];
  return { ok: !through.length && !loose.length, why: through.length ? 'through' : loose.length ? 'end' : null, through, loose };
}

// The same for a hose among the workbench's parts (studs and plates): the solid parts whose boxes come near it (as
// lib/place.mjs counts them: not figure pieces, plants or a designed part) and the other hoses. `skip`: parts left
// out (the hose itself, as it was).
export function flexRoom(part, parts, { skip = new Set(), ends = false } = {}) {
  const [x0, y0, z0, x1, y1, z1] = boxMM(part), pad = TOUCH + 1;
  const near = (b) => b[0] < x1 + pad && b[3] > x0 - pad && b[1] < y1 + pad && b[4] > y0 - pad && b[2] < z1 + pad && b[5] > z0 - pad;
  const boxes = [], tubes = [];
  for (const q of parts) {
    if (q === part || skip.has(q)) continue;
    if (q.flex) { if (near(boxMM(q))) tubes.push({ points: worldPoints(q), radius: FLEX[q.flex.kind]?.radius ?? 1, part: q }); continue; }
    if ((q.origin && !q.extent) || q.shape === 'custom' || /^(tree|bush|leaves|flower)/.test(q.shape ?? '')) continue;
    const box = boxMM(q);
    if (near(box)) boxes.push({ box, part: q });
  }
  return flexCheck(part, boxes, tubes, { ends });
}
