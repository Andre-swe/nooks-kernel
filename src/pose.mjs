// Rigid frames in LDraw units, LDraw's axes (x and z across, -y up), as the agent runtime (lib/assembly.mjs) and
// BrickAgent use them. A port of BrickAgent's pose.py (MIT, Kulits 2026). Pure.
//
// A pose is { r: 3x3 row-major (9 numbers), t: [x, y, z] }. compose(p, q) is q inside p; apply(p, v) maps a point;
// dir(p, v) turns a direction. Rotations are proper and orthogonal.

export const STUD = 20, PLATE = 8, BRICK = 24;
export const UP = [0, -1, 0];
const I9 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const ID = Object.freeze({ r: I9, t: [0, 0, 0] });

export const pose = (r = I9, t = [0, 0, 0]) => {
  if (r.length !== 9 || t.length !== 3 || ![...r, ...t].every(Number.isFinite)) throw new Error('A pose needs nine finite rotation values and three finite translation values.');
  return { r: r.map(Number), t: t.map(Number) };
};
// (written out: these run for every connector of every part, and the sums are in the same order as a loop's)
export const mul3 = (A, B) => [
  A[0] * B[0] + A[1] * B[3] + A[2] * B[6], A[0] * B[1] + A[1] * B[4] + A[2] * B[7], A[0] * B[2] + A[1] * B[5] + A[2] * B[8],
  A[3] * B[0] + A[4] * B[3] + A[5] * B[6], A[3] * B[1] + A[4] * B[4] + A[5] * B[7], A[3] * B[2] + A[4] * B[5] + A[5] * B[8],
  A[6] * B[0] + A[7] * B[3] + A[8] * B[6], A[6] * B[1] + A[7] * B[4] + A[8] * B[7], A[6] * B[2] + A[7] * B[5] + A[8] * B[8],
];
export const rot = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
export const transpose = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
export const apply = (p, v) => { const x = rot(p.r, v); return [x[0] + p.t[0], x[1] + p.t[1], x[2] + p.t[2]]; };
export const dir = (p, v) => rot(p.r, v);
export const compose = (p, q) => ({ r: mul3(p.r, q.r), t: apply(p, q.t) });
export const inverse = (p) => { const r = transpose(p.r); return { r, t: rot(r, p.t).map((x) => -x) }; };
export const composeAll = (...ps) => ps.reduce((a, b) => compose(a, b), ID);

// Translation by studs, plates and studs (20, 8, 20 LDU); negative y is up.
export const at = (x = 0, y = 0, z = 0) => ({ r: I9, t: [STUD * x, PLATE * y, STUD * z] });
// Translation in LDU.
export const move = (x = 0, y = 0, z = 0) => ({ r: I9, t: [x, y, z] });

// Rotation by `degrees` (right-handed) about the line through `about` (LDU) along `axis`. Quarter turns about a
// coordinate axis are exact.
export function spin(axis, degrees, about = [0, 0, 0]) {
  const n = Math.hypot(...axis);
  if (!(n > 1e-12) || axis.length !== 3) throw new Error('axis must be a nonzero 3-vector');
  const [x, y, z] = axis.map((v) => v / n), a = (degrees * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), C = 1 - c;
  let r = [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
  if (degrees % 90 === 0 && axis.filter((v) => v !== 0).length === 1) r = r.map((v) => Math.round(v) + 0);
  return { r, t: about.map((p, i) => p - rot(r, about)[i]) };
}

// The 4x4 of a pose, and a pose from LDraw's line-type-1 numbers (x y z a b c d e f g h i).
export const fromLDraw = (n) => ({ r: n.slice(3, 12), t: n.slice(0, 3) });
export const toLDraw = (p) => [...p.t, ...p.r];
// Within 1e-8 of each other (positions in LDU, rotations entrywise).
export const near = (p, q, tol = 1e-6) => p.r.every((v, i) => Math.abs(v - q.r[i]) < tol) && p.t.every((v, i) => Math.abs(v - q.t[i]) < tol);
