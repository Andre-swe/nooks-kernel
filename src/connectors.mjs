// Where a part connects and what two connectors make together. The data is
// ldraw/connectors.json (scripts/bundle-connectors.mjs; LDCad's shadow library,
// CC BY-SA 4.0); this module only reads it. Pure: the caller loads the tables.
//
// A connector is a stud, an antistud (the hollow that takes one), a pin, a
// hole, an axle, an axle hole, a bar, a clip, a row of hinge fingers, a ball,
// a socket, or a generic snap. Its row in the file is
//   [kind, gender, x, y, z, ax, ay, az, radius, length, detail, group, caps, slide]
// in millimetres about the part's LDraw origin, this app's axes. The axis points
// out of the part (a stud's up, a brick's antistud's down).
import { freeForm } from './studio.mjs';
import { frameOf } from './frames.mjs';

export const KINDS = ['stud', 'antistud', 'pin', 'hole', 'axle', 'axlehole', 'bar', 'clip', 'finger', 'ball', 'socket', 'gen'];

const POS_TOL = 0.4 + 1e-3;   // mm: two connectors meet within this (1 LDU, with room for rounding)
const SEAT = 0.85;       // mm: a stud sits this far off its hollow's mouth and still holds (sets are drawn in 2 LDU steps, 0.8 mm)
const PARALLEL = 0.995;   // dot product of axes that count as the same line
const r4 = (v) => Math.round(v * 1e4) / 1e4 || 0;
const app3 = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];

// Every connector of `part` in the world (mm): [{ part, i, k, g, at, axis, r, l,
// s, grp }], i the connector's index in the part's table entry. `table` is
// connectors.json's `parts`, `frames` frames.json's. A part the tables don't
// know has none. Placed with freeForm exactly as the workbench places it:
// world = M·p + O, axis = M·a.
export function connectorsOf(part, { table, frames }) {
  const rows = table?.[part.id];
  if (!rows?.length) return [];
  const g = frameOf(part.id, frames);
  if (!g && !(part.origin && part.ldMatrix)) return [];
  const { O, M } = freeForm(part, g ?? { cx: 0, cz: 0, minY: 0 });
  return rows.map((row, i) => ({
    part, i, k: KINDS[row[0]], g: row[1],
    at: app3(M, [row[2], row[3], row[4]]).map((v, j) => r4(v + O[j])),
    axis: app3(M, [row[5], row[6], row[7]]).map(r4),
    r: row[8], l: row[9], s: row[10] || undefined, grp: row[11] || undefined,
  }));}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const along = (c, u) => { const t = dot(c.at, u); return [t - c.l / 2, t + c.l / 2]; };

// Two cylinders on one line: axes parallel or opposite, centre lines within
// tolerance, and their lengths overlapping. Returns the middle of the overlap
// (on `a`'s line) or null.
function sameLine(a, b, play = 0) {
  if (Math.abs(dot(a.axis, b.axis)) < PARALLEL) return null;
  const d = sub(b.at, a.at), t = dot(d, a.axis), off = d.map((v, i) => v - t * a.axis[i]);
  if (Math.hypot(...off) > POS_TOL + play) return null;
  const [a0, a1] = along(a, a.axis), [b0, b1] = along(b, a.axis);
  const lo = Math.max(a0, b0), hi = Math.min(a1, b1);
  if (hi - lo <= POS_TOL) return null;
  const mid = (lo + hi) / 2 - dot(a.at, a.axis);
  return a.at.map((v, i) => r4(v + mid * a.axis[i]));
}
const fits = (inner, outer) => inner.r <= outer.r + 0.05;   // a pin goes in a hole its size or bigger
const clearance = (inner, outer) => Math.max(0, outer.r - inner.r);   // and sits anywhere in it: off-centre by the room it has

// A row of hinge fingers as sections along `u`: [[from, to, gender]]. Its detail is the
// sections' lengths (mm), the first of the row's gender and alternating from there (a row
// with none is one finger). They run from the row's start along its own axis.
function sections(c, u) {
  const lens = c.s ? String(c.s).split(' ').map(Number) : [c.l], dir = dot(c.axis, u) < 0 ? -1 : 1;
  let t = dot(c.at, u) - (dir * c.l) / 2;
  return lens.map((n, i) => { const a = t; t += dir * n; return [Math.min(a, t), Math.max(a, t), i % 2 ? (c.g === 'M' ? 'F' : 'M') : c.g]; });
}
// Two rows of fingers of one kind on one line mesh when every finger faces a gap: wherever
// their sections overlap, one is a finger and the other the gap (two hinge halves alike never do).
function fingers(a, b) {
  if (!a.grp || a.grp !== b.grp) return null;
  const at = sameLine(a, b);
  if (!at) return null;
  let met = 0;
  for (const [a0, a1, ga] of sections(a, a.axis)) for (const [b0, b1, gb] of sections(b, a.axis)) {
    if (Math.min(a1, b1) - Math.max(a0, b0) <= POS_TOL) continue;
    if (ga === gb) return null;
    met++;
  }
  return met ? { dof: 'turn', at, axis: (a.g === 'M' ? a : b).axis } : null;
}

// What two world connectors make, or null: { dof, at, axis }. dof: 'rigid',
// 'turn', 'slide', 'turn+slide' or 'ball'. `at` is where they meet, `axis` the
// line they turn or slide along. Either order. A stud pair also says `lone:
// 'turn'`: the dof if it is the only pair joining its two parts (one stud
// lets the parts turn; two or more, apart, hold them rigid).
export function mate(a, b) {
  if (!a || !b) return null;
  if (a.k === 'finger' && b.k === 'finger') return fingers(a, b);
  if (a.g === b.g) return null;                             // every pair is one that goes in and one that takes it
  const [m, f] = a.g === 'M' ? [a, b] : [b, a];
  switch (`${m.k}/${f.k}`) {
    case 'stud/antistud': {
      if (dot(m.axis, f.axis) > -PARALLEL) return null;
      // The stud's foot against the hollow's mouth, on one line.
      const foot = m.at.map((v, i) => v - m.axis[i] * (m.l / 2)), mouth = f.at.map((v, i) => v + f.axis[i] * (f.l / 2));
      const d = sub(mouth, foot), t = dot(d, m.axis);
      if (Math.hypot(...d.map((v, i) => v - t * m.axis[i])) > POS_TOL || Math.abs(t) > SEAT) return null;
      return { dof: 'rigid', lone: 'turn', at: foot.map(r4), axis: m.axis };
    }
    case 'pin/hole': case 'axle/hole': {
      if (!fits(m, f)) return null;
      const at = sameLine(m, f, clearance(m, f));
      return at && { dof: 'turn', at, axis: m.axis };
    }
    case 'axle/axlehole': {
      if (!fits(m, f)) return null;
      const at = sameLine(m, f);
      return at && { dof: 'rigid', at, axis: m.axis };
    }
    case 'bar/clip': {
      if (Math.abs(m.r - f.r) > 0.2) return null;
      const at = sameLine(m, f);
      return at && { dof: 'turn+slide', at, axis: m.axis };
    }
    case 'ball/socket': {
      if (!m.grp || m.grp !== f.grp) return null;
      if (Math.hypot(...sub(m.at, f.at)) > POS_TOL) return null;
      return { dof: 'ball', at: m.at, axis: m.axis };
    }
    default: return null;
  }
}
