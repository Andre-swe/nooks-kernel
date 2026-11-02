// Where two parts pass into each other, from collision shapes instead of
// whole-part boxes: a few oriented boxes per part (ldraw/hulls.json, made by
// scripts/bundle-hulls.mjs) placed exactly as the part is (lib/studio.mjs
// freeForm, with the part's frame from lib/frames.mjs). Studs are not in the
// shape, and a slope's empty wedge is empty. Pure: the caller loads the tables.
// Phase 1 (docs/PHASE1_CONTRACTS.md §4).
//
// `hulls`: hulls.json's `parts` (per part a flat list of boxes
// [x0, y0, z0, x1, y1, z1, …], mm, about the part's LDraw origin);
// `frames`: frames.json's `parts`.
import { frameOf } from './frames.mjs';
import { freeForm } from './studio.mjs';

// A part's boxes in the world (mm): { c: middle, h: half sizes, R: axes, 3 × 3
// row-major, the box's own axes being its columns }; null when the table has
// nothing for the part. The boxes are axis-aligned about the part's origin, so
// their axes are the part's (centre = M·c + O, axes = M·R with R the identity).
// Cached by part and table, since a part is asked about many times as it moves.
const cache = new WeakMap();
export function hullsOf(part, { hulls, frames } = {}) {
  const own = hulls?.[part.id];
  if (!own) return null;
  const g = frameOf(part.id, frames);
  if (!g && !(part.origin && part.ldMatrix)) return null;        // (a part turned off the grid carries its own matrix)
  const { O, M } = freeForm(part, g ?? { cx: 0, cz: 0, minY: 0, slopeTurn: 0 });
  const out = [];
  for (let n = 0; n < own.length; n += 6) {
    const c = [(own[n] + own[n + 3]) / 2, (own[n + 1] + own[n + 4]) / 2, (own[n + 2] + own[n + 5]) / 2];
    out.push({ c: [0, 1, 2].map((i) => M[i * 3] * c[0] + M[i * 3 + 1] * c[1] + M[i * 3 + 2] * c[2] + O[i]), h: [(own[n + 3] - own[n]) / 2, (own[n + 4] - own[n + 1]) / 2, (own[n + 5] - own[n + 2]) / 2], R: M });
  }
  return out;
}
// The same, remembered for a part object while it stays where it is. The
// workbench moves and turns a part by changing it in place, so what is
// remembered goes with the pose it was worked out for.
const poseOf = (p) => `${p.id}|${p.x}|${p.y}|${p.z}|${p.rotation}|${p.ldMatrix ?? ''}|${p.shape ?? ''}`;
export function hullsFor(part, tables) {
  let by = cache.get(part);
  if (!by) cache.set(part, (by = new Map()));
  const key = tables.hulls, pose = poseOf(part), had = by.get(key);
  if (had?.pose === pose) return had.hulls;
  const hulls = hullsOf(part, tables);
  by.set(key, { pose, hulls });
  return hulls;
}

// Whether two oriented boxes pass into each other deeper than `allow`: the
// separating-axis test over the 15 axes, the depth being the least overlap
// along any of them (so a box resting on another, or a stud's depth in, is
// not a clash, and two boxes crossing by a hair is not either).
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const col = (R, j) => [R[j], R[3 + j], R[6 + j]];
function depth(a, b) {
  const A = [0, 1, 2].map((j) => col(a.R, j)), B = [0, 1, 2].map((j) => col(b.R, j)), t = [b.c[0] - a.c[0], b.c[1] - a.c[1], b.c[2] - a.c[2]];
  let least = Infinity;
  const test = (axis) => {
    const n = Math.hypot(...axis);
    if (n < 1e-6) return true;                                // two parallel edges: no axis of their own
    const u = [axis[0] / n, axis[1] / n, axis[2] / n];
    const ra = Math.abs(dot(A[0], u)) * a.h[0] + Math.abs(dot(A[1], u)) * a.h[1] + Math.abs(dot(A[2], u)) * a.h[2];
    const rb = Math.abs(dot(B[0], u)) * b.h[0] + Math.abs(dot(B[1], u)) * b.h[1] + Math.abs(dot(B[2], u)) * b.h[2];
    const over = ra + rb - Math.abs(dot(t, u));
    if (over <= 0) { least = 0; return false; }
    if (over < least) least = over;
    return true;
  };
  for (const u of A) if (!test(u)) return 0;
  for (const u of B) if (!test(u)) return 0;
  for (const u of A) for (const v of B) if (!test([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]])) return 0;
  return least;
}
// A world box round a part's boxes, to reject far-apart parts cheaply.
const reach = (hs) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of hs) for (let i = 0; i < 3; i++) { const e = Math.abs(b.R[i * 3]) * b.h[0] + Math.abs(b.R[i * 3 + 1]) * b.h[1] + Math.abs(b.R[i * 3 + 2]) * b.h[2]; lo[i] = Math.min(lo[i], b.c[i] - e); hi[i] = Math.max(hi[i], b.c[i] + e); }
  return { lo, hi };
};
// Parts a and b (model parts), true when solid passes into solid deeper than
// `allow` mm (a stud goes 1.7 mm into the part above it). False when the
// table has no shape for either: ask `hullsOf` first to know.
export function clash(a, b, { hulls, frames, allow = 1.7 } = {}) {
  const ha = hullsOf(a, { hulls, frames }), hb = hullsOf(b, { hulls, frames });
  return ha && hb ? clashHulls(ha, hb, allow) : false;
}
// The same for boxes already placed (hullsOf, or hullsFor).
export function clashHulls(ha, hb, allow = 1.7) {
  const ra = reach(ha), rb = reach(hb);
  for (let i = 0; i < 3; i++) if (Math.min(ra.hi[i], rb.hi[i]) - Math.max(ra.lo[i], rb.lo[i]) <= allow) return false;
  for (const x of ha) for (const y of hb) if (depth(x, y) > allow) return true;
  return false;
}

// ---- joints
// Two parts form a joint where a joint of one (ldraw/joints.json: a pin, a
// hole, a hinge finger, a clip, a bar, a ball) lies on the same line as one of
// the other's, pointing the same way (or the opposite), and close enough along
// it to be in it: a pin in its hole, a clip on its bar, two hinge fingers
// meeting. Such a pair is meant to meet, so its parts' shapes passing into
// each other is no clash. `joints`: joints.json's `parts`.
const ON_LINE = 0.5, PARALLEL = 0.995;
const jointCache = new WeakMap();
function jointsWorld(part, { joints, frames }) {
  const own = joints?.[part.id];
  if (!own?.length) return [];
  let by = jointCache.get(part);
  if (!by) jointCache.set(part, (by = new Map()));
  const pose = poseOf(part), had = by.get(joints);
  if (had?.pose === pose) return had.out;
  const g = frameOf(part.id, frames);
  let out = [];
  if (g || (part.origin && part.ldMatrix)) {
    const { O, M } = freeForm(part, g ?? { cx: 0, cz: 0, minY: 0, slopeTurn: 0 });
    // (a joint's `p` is a whole length along `a` from its middle unless it is centred, `c`: as examples/ldraw-fit.mjs)
    out = own.filter((j) => j.a).map((j) => {
      const mid = j.c ? j.p : j.p.map((v, i) => v - j.a[i] * j.l);
      return { at: [0, 1, 2].map((i) => M[i * 3] * mid[0] + M[i * 3 + 1] * mid[1] + M[i * 3 + 2] * mid[2] + O[i]), axis: [0, 1, 2].map((i) => M[i * 3] * j.a[0] + M[i * 3 + 1] * j.a[1] + M[i * 3 + 2] * j.a[2]), l: j.l };
    });
  }
  by.set(joints, { pose, out });
  return out;
}
export function joined(a, b, { joints, frames } = {}) {
  if (!joints) return false;
  const ja = jointsWorld(a, { joints, frames }), jb = jointsWorld(b, { joints, frames });
  for (const x of ja) for (const y of jb) {
    if (Math.abs(dot(x.axis, y.axis)) < PARALLEL) continue;
    const d = [y.at[0] - x.at[0], y.at[1] - x.at[1], y.at[2] - x.at[2]], along = dot(d, x.axis);
    const off = Math.hypot(d[0] - along * x.axis[0], d[1] - along * x.axis[1], d[2] - along * x.axis[2]);
    if (off <= ON_LINE && Math.abs(along) <= x.l + y.l + ON_LINE) return true;
  }
  return false;
}
