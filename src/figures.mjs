// Minifigures: a whole figure from real figure parts (legs, hips, torso,
// arms, hands, head, hair or a hat), each placed by its LDraw transform the
// way the kits place them. Pure: no DOM.
//
// The template is a standing figure from the Red Cliffs Family kit, in this
// app's axes: offsets in studs (x, z) and plates (y) from the legs' origin,
// which sits 3.5 plates (28 LDU) above the stud the figure stands on.
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ARM_R = [0.98546132, 0.1692534, 0.01480775, -0.16989992, 0.98171134, 0.08588861, 0, -0.08715574, 0.9961947];
const ARM_L = [0.98546132, -0.1692534, -0.01480775, 0.16989992, 0.98171134, 0.08588861, 0, -0.08715574, 0.9961947];
const HAND_R = [0.98546132, 0.13015089, -0.10920956, -0.16989992, 0.75490717, -0.63344233, 0, 0.64278761, 0.76604444];
const HAND_L = [0.98546132, -0.13015089, 0.10920956, 0.16989992, 0.75490717, -0.63344233, 0, 0.64278761, 0.76604444];
export const STAND = 3.5;
// How far under its origin a figure piece reaches: legs STAND, a hips and
// skirt piece (36036, its origin at the hips' top) 40 LDU, 5 plates.
export const reach = (p) => (/^36036/.test(p.id) ? 5 : STAND);

// role, design, offset, matrix, size (w, d, h) for the parts index.
const TEMPLATE = [
  ['legs', '3816c', [0, 0, 0], I, [1, 1, 4]],
  ['legs', '3817c', [0, 0, 0], I, [1, 1, 4]],
  ['legs', '3815b', [0, 1.5, 0], I, [2, 1, 1]],
  ['torso', '973', [0, 5.5, 0], I, [2, 1, 4]],
  ['arms', '3818', [-0.7776, 4.375, 0], ARM_R, [1, 1, 4]],
  ['skin', '3820', [-1.17645562, 2.2699844, 0.57460646], HAND_R, [1, 1, 1]],
  ['arms', '3819', [0.7776, 4.375, 0], ARM_L, [1, 1, 4]],
  ['skin', '3820', [1.17645562, 2.2699844, 0.57460646], HAND_L, [1, 1, 1]],
  ['head', null, [0, 8.5, 0], I, [1, 1, 3]],
  ['hair', null, [0, 8.5, 0], I, [2, 2, 3]],
];

const NAMES = {
  '3816c': 'Minifigure right leg', '3817c': 'Minifigure left leg', '3815b': 'Minifigure hips', 973: 'Minifigure torso', '973p5t': 'Minifigure torso, tuxedo',
  3818: 'Minifigure right arm', 3819: 'Minifigure left arm', 3820: 'Minifigure hand',
  '3626bp01': 'Minifigure head, smile', '3626cp8a': 'Minifigure head, smile with eyebrows', '3626c': 'Minifigure head',
  3901: 'Minifigure hair, short', 4530: 'Minifigure hair, shoulder length', '4485b': 'Minifigure cap', 3624: 'Minifigure police hat',
  3833: 'Minifigure construction helmet', 3878: 'Minifigure top hat', 3844: 'Minifigure knight helmet',
};

// Ready-made figures: colours are LDraw codes (14 yellow skin, 1 blue, 4 red,
// 15 white, 0 black, 70 reddish brown, 19 tan, 2 green, 272 dark blue).
export const FIGURES = [
  { id: 'resident', name: 'Resident', torso: 4, legs: 1, head: '3626bp01', hair: ['3901', 70] },
  { id: 'visitor', name: 'Visitor', torso: 15, legs: 272, head: '3626cp8a', hair: ['4530', 70] },
  { id: 'walker', name: 'Walker in a cap', torso: 2, legs: 19, head: '3626bp01', hair: ['4485b', 4] },
  { id: 'builder', name: 'Builder', torso: 14, legs: 1, head: '3626bp01', hair: ['3833', 14] },
  { id: 'officer', name: 'Officer', torso: 0, legs: 0, head: '3626bp01', hair: ['3624', 0] },
  { id: 'gent', name: 'Top hat', torso: 0, legs: 0, head: '3626bp01', hair: ['3878', 0] },
];

// The parts of figure `f` with its legs' origin at (x, z) (between the two
// studs its feet take), standing on studs whose top is plate y, facing `turn` degrees (a quarter turn at a time). `assembly`: its own
// sub-build, so the manual builds it on the side and then attaches it.
export function figure(f, { x, z, y, turn = 0, assembly = f.name }) {
  const t = ((turn % 360) + 360) % 360 * Math.PI / 180, c = Math.round(Math.cos(t)), s = Math.round(Math.sin(t));
  // A turn about y in this app's axes, applied to each part's offset and matrix.
  const R = [c, 0, s, 0, 1, 0, -s, 0, c];
  const mul = (A, B) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((k) => A[r * 3] * B[k] + A[r * 3 + 1] * B[3 + k] + A[r * 3 + 2] * B[6 + k]));
  const colour = { legs: f.legs, torso: f.torso, arms: f.arms ?? f.torso, skin: f.skin ?? 14, head: f.skin ?? 14, hair: f.hair?.[1] };
  const parts = [];
  for (const [role, design, [dx, dy, dz], m, [w, d, h]] of TEMPLATE) {
    const id = role === 'head' ? f.head : role === 'hair' ? f.hair?.[0] : design;
    if (!id) continue;
    parts.push({
      id, color: colour[role], x: x + c * dx + s * dz, z: z - s * dx + c * dz, y: y + STAND + dy,
      w, d, h, rotation: 0, origin: true, ldMatrix: mul(R, m), studs: false,
      section: assembly, assembly, edited: 'added',
    });
  }
  return parts;
}

export const figureName = (id) => NAMES[id] ?? null;

// A quarter turn of a placed figure about its legs (parts changed in place).
export function turnFigure(parts) {
  const legs = parts.find((p) => /^381[67]/.test(p.id)) ?? parts[0];
  const cx = legs.x, cz = legs.z, R = [0, 0, 1, 0, 1, 0, -1, 0, 0];
  const mul = (A, B) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((k) => A[r * 3] * B[k] + A[r * 3 + 1] * B[3 + k] + A[r * 3 + 2] * B[6 + k]));
  for (const p of parts) {
    const dx = p.x - cx, dz = p.z - cz;
    p.x = cx + dz; p.z = cz - dx;
    p.ldMatrix = mul(R, p.ldMatrix ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  }
  return parts;
}

// The parts of the figure a part belongs to (its own sub-build, all pinned
// figure pieces), or null when it is not part of one.
export function figureOf(model, part) {
  if (!part?.origin || !part.assembly) return null;
  const all = model.parts.filter((p) => p.assembly === part.assembly);
  return all.length <= 14 && all.every((p) => p.origin) ? all : null;
}


// ---- posing
// A placed figure's head turns about the neck (its hair or hat with it),
// each arm swings at the shoulder (its hand going with it), each hand turns
// at the wrist, and each leg swings at the hip (out in front: sitting).
// Parts are changed in place.
const STUD_MM = 8, PLATE_MM = 3.2;
const mul3 = (A, B) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((k) => A[r * 3] * B[k] + A[r * 3 + 1] * B[3 + k] + A[r * 3 + 2] * B[6 + k]));
const apply3 = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
const tr3 = (M) => [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];
const turnAbout = (axis, deg) => {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return axis === 'x' ? [1, 0, 0, 0, c, -s, 0, s, c] : axis === 'y' ? [c, 0, s, 0, 1, 0, -s, 0, c] : [c, -s, 0, s, c, 0, 0, 0, 1];
};
const mm = (p) => [p.x * STUD_MM, p.y * PLATE_MM, p.z * STUD_MM];
const setMm = (p, v) => { p.x = v[0] / STUD_MM; p.y = v[1] / PLATE_MM; p.z = v[2] / STUD_MM; };
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// The figure's pieces by what they are.
export function figurePieces(parts) {
  const find = (re) => parts.filter((p) => re.test(p.id));
  const head = find(/^3626/)[0], armR = find(/^3818/)[0], armL = find(/^3819/)[0], hands = find(/^3820/);
  const near = (arm) => arm && hands.slice().sort((a, b) => Math.hypot(...mm(a).map((v, i) => v - mm(arm)[i])) - Math.hypot(...mm(b).map((v, i) => v - mm(arm)[i])))[0];
  const handR = near(armR), handL = hands.find((h) => h !== handR) ?? null;
  const headgear = head ? parts.filter((p) => p !== head && Math.abs(p.y - head.y) < 0.01 && Math.hypot(p.x - head.x, p.z - head.z) < 0.01) : [];
  return { head, headgear, armR, armL, handR, handL, torso: find(/^973/)[0], hips: find(/^3815/)[0], legR: find(/^3816/)[0], legL: find(/^3817/)[0] };
}
// Turn `moving` parts by local rotation R of `pivot` (about its own origin):
// positions swing round the pivot's origin, matrices turn with it.
function swing(pivot, moving, R) {
  const M = pivot.ldMatrix ?? I3;
  const W = mul3(mul3(M, R), tr3(M));                 // the same turn, in the figure's (world) axes
  const o = mm(pivot);
  for (const p of moving) {
    // The pivot turns in place (no round trip through mm to drift it).
    if (p !== pivot) setMm(p, apply3(W, mm(p).map((v, i) => v - o[i])).map((v, i) => v + o[i]));
    p.ldMatrix = mul3(W, p.ldMatrix ?? I3);
  }
}

// The joints, how far each goes (degrees) and what it turns about. An arm or
// leg swings forward with a negative angle (an arm up at −180, legs out in
// front to sit at −90); a head or hand turns either way.
export const JOINTS = {
  head: { min: -90, max: 90, name: 'Head' },
  armL: { min: -180, max: 45, name: 'Left arm' },
  armR: { min: -180, max: 45, name: 'Right arm' },
  handL: { min: -180, max: 180, name: 'Left hand' },
  handR: { min: -180, max: 180, name: 'Right hand' },
  legL: { min: -90, max: 30, name: 'Left leg' },
  legR: { min: -90, max: 30, name: 'Right leg' },
};
// What each joint turns, about which of its own axes, and what it is
// measured against (the head against the torso, an arm against the torso,
// a hand against its arm, a leg against the hips).
function rig(f, joint) {
  return {
    head: f.head && { pivot: f.head, moving: [f.head, ...f.headgear], axis: 'y', from: f.torso },
    armR: f.armR && { pivot: f.armR, moving: [f.armR, f.handR].filter(Boolean), axis: 'x', from: f.torso },
    armL: f.armL && { pivot: f.armL, moving: [f.armL, f.handL].filter(Boolean), axis: 'x', from: f.torso },
    handR: f.handR && { pivot: f.handR, moving: [f.handR], axis: 'z', from: f.armR },
    handL: f.handL && { pivot: f.handL, moving: [f.handL], axis: 'z', from: f.armL },
    legR: f.legR && f.hips && { pivot: f.legR, moving: [f.legR], axis: 'x', from: f.hips },
    legL: f.legL && f.hips && { pivot: f.legL, moving: [f.legL], axis: 'x', from: f.hips },
  }[joint] ?? null;
}
// A joint's angle now (degrees), read off the parts: the turn about its axis
// relative to what it is measured against.
function angleOf(r) {
  const R = mul3(tr3(r.from?.ldMatrix ?? I3), r.pivot.ldMatrix ?? I3);
  const a = r.axis === 'x' ? Math.atan2(R[7], R[8]) : r.axis === 'y' ? Math.atan2(R[2], R[0]) : Math.atan2(-R[1], R[0]);
  return Math.round((a * 180) / Math.PI * 100) / 100 || 0;   // (never −0)
}
// The figure's pose: { joint: degrees } for the joints it has.
export function poseOf(parts) {
  const f = figurePieces(parts), out = {};
  for (const j of Object.keys(JOINTS)) { const r = rig(f, j); if (r) out[j] = angleOf(r); }
  return out;
}
// Turn a joint by `degrees`, either way.
export function poseFigure(parts, joint, degrees) {
  const r = rig(figurePieces(parts), joint);
  if (r) swing(r.pivot, r.moving, turnAbout(r.axis, degrees));
  return parts;
}
// Set joints to angles: `pose` { joint: degrees }, each kept to its range.
export function setPose(parts, pose) {
  const f = figurePieces(parts);
  for (const [j, deg] of Object.entries(pose)) {
    const r = rig(f, j), J = JOINTS[j];
    if (!r || !J) continue;
    const d = Math.max(J.min, Math.min(J.max, deg)) - angleOf(r);
    if (Math.abs(d) > 1e-6) swing(r.pivot, r.moving, turnAbout(r.axis, d));
  }
  return parts;
}
// Ready-made poses. Each sets only the joints it names.
export const POSES = [
  { id: 'stand', name: 'Stand', pose: { legL: 0, legR: 0 } },
  { id: 'sit', name: 'Sit', pose: { legL: -90, legR: -90 } },
  { id: 'wave', name: 'Wave', pose: { armR: -150, handR: 0 } },
  { id: 'point', name: 'Point', pose: { armR: -90 } },
  { id: 'cheer', name: 'Arms up', pose: { armL: -165, armR: -165 } },
  { id: 'rest', name: 'Arms down', pose: { armL: -5, armR: -5 } },
  { id: 'reset', name: 'Reset', pose: { head: 0, armL: -5, armR: -5, legL: 0, legR: 0 } },
];

// ---- where a figure meets the studs
// Each leg takes a stud in the hole under its foot (standing) and in the
// hole in the back of its thigh (seated). LDraw has them at (LDU from the
// leg's origin) x ±10 (the right leg −10), the foot's under y 28, the
// thigh's at y 18 with the back face 10 behind; the newer legs (c) sit 1.25
// forward of the stud grid.
const LDU_MM = 0.4;
function legHoles(id) {
  const x = /^3816/.test(id) ? -10 : 10, z0 = /c$/.test(id) ? -1.25 : 0;
  return [{ at: [x, 28, z0], open: [0, 1, 0] }, { at: [x, 18, z0 + 10], open: [0, 0, 1] }];
}
// Where a stud goes into figure legs `legs` as they are turned now: the hole
// that opens downward, as an offset from the legs' origin in studs and
// plates { x, y, z }, or null when none does (a figure lying down).
export function legSeat(legs) {
  const M = legs.ldMatrix ?? I3, S = (v) => [v[0], -v[1], -v[2]];   // LDraw to this app's axes: half a turn about x
  for (const h of legHoles(legs.id)) {
    if (apply3(M, S(h.open))[1] > -0.9) continue;
    const [x, y, z] = apply3(M, S(h.at)).map((v) => v * LDU_MM);
    return { x: x / STUD_MM, y: y / PLATE_MM, z: z / STUD_MM };
  }
  return null;
}
// The leg a figure is held by: the first with a hole facing down (one leg
// swung out while the other stands is still held), else its first leg.
export function holdingLeg(parts) {
  const legs = parts.filter((q) => q.origin && /^381[67]/.test(q.id));
  return legs.find((q) => legSeat(q)) ?? legs[0] ?? null;
}
// The stud a figure is on: { x, y, z } (its centre, the top it stands on),
// or null when no hole faces down.
export function studUnder(parts) {
  const legs = holdingLeg(parts), s = legs && legSeat(legs);
  return s ? { x: legs.x + s.x, y: legs.y + s.y, z: legs.z + s.z } : null;
}
