// Building sideways: studs that do not point up (a headlight brick's, a
// bracket's, a brick with studs on its side, or any stud of a part laid on
// its side), and a part set onto them the way it really goes: turned so its
// underside faces them, and moved so a hollow of its underside takes a stud.
// Pure: no DOM.
//
// Positions are millimetres in the model (studs × 8, plates × 3.2). A part's
// geometry `g` is as lib/studio.mjs freeForm takes it ({ cx, cz, minY,
// slopeTurn }: its LDraw origin against its seated shape); `side` is its row
// of ldraw/sidestuds.json ([x, y, z, dx, dy, dz] about its LDraw origin).
import { freeForm, rotateParts } from './studio.mjs';
import { studPoints, boxMM } from './studs.mjs';
import { newPart } from './edit.mjs';

const STUD = 8, PLATE = 3.2;
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const clean = (v) => (Math.abs(v) < 1e-6 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-6 ? Math.sign(v) : v);
const NONE = { cx: 0, cz: 0, minY: 0, slopeTurn: 0 };

// A point and a direction of the part's own (about its LDraw origin) in the model.
function placer(p, g) {
  const { O, M } = freeForm(p, g ?? NONE);
  const turn = (v) => [0, 1, 2].map((i) => M[i * 3] * v[0] + M[i * 3 + 1] * v[1] + M[i * 3 + 2] * v[2]);
  return { at: (v) => turn(v).map((x, i) => x + O[i]), dir: (v) => turn(v).map(clean) };
}
// The app's quarter-turn convention against the geometry's own (a slope's
// high side): (x, z) in the part's own frame.
const unturn = ([x, z], st) => { const t = (-(st || 0) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return [x * c + z * s, -x * s + z * c]; };

// Which way a part's top faces: up, unless it is on its own matrix.
export const upOf = (p) => (p.origin && p.ldMatrix ? [p.ldMatrix[1], p.ldMatrix[4], p.ldMatrix[7]].map(clean) : [0, 1, 0]);

// The studs of part `p` that do not point up, in the model: [{ at, dir }]
// (`at`: the middle of the stud's base). Its side studs, and, laid on its
// side, the studs of its top too.
export function sideStudsOf(p, g, side = [], catalog = {}) {
  if (!g && !p.origin) return [];
  const pl = placer(p, g), out = [];
  for (const s of side ?? []) { const dir = pl.dir(s.slice(3)); if (dir[1] < 0.9) out.push({ at: pl.at(s.slice(0, 3)), dir }); }
  if (p.origin && p.extent && g) {
    // Its top as it was made: the stud grid's studs, turned with it.
    const up = { ...newPart(p.id, p.color, 0, 0, 0, '', { w: p.w, d: p.d, h: p.h }), x: 0, z: 0 };
    const dir = pl.dir([0, 1, 0]);
    if (dir[1] < 0.9) for (const pt of studPoints(up, catalog)) { const [x, z] = unturn(pt, g.slopeTurn); out.push({ at: pl.at([x * STUD + g.cx, p.h * PLATE + g.minY, z * STUD + g.cz]), dir }); }
  }
  return out;
}

// The middles of the hollows under part `p` (one a stud cell), in the model.
export function hollowsOf(p, g) {
  const pl = placer(p, g ?? NONE), [w, d] = [p.w, p.d], out = [];
  const gg = g ?? NONE;
  for (let i = 0; i < Math.round(w); i++) for (let k = 0; k < Math.round(d); k++) {
    const [x, z] = unturn([i + 0.5 - w / 2, k + 0.5 - d / 2], gg.slopeTurn);
    out.push(pl.at([x * STUD + gg.cx, gg.minY, z * STUD + gg.cz]));
  }
  return out;
}

// The turn that takes direction u to direction n: { axis, deg } (axis a
// direction), or null when they are the same.
export function turnBetween(u, n) {
  const c = Math.max(-1, Math.min(1, dot(u, n)));
  if (c > 1 - 1e-6) return null;
  let axis = [u[1] * n[2] - u[2] * n[1], u[2] * n[0] - u[0] * n[2], u[0] * n[1] - u[1] * n[0]];
  if (Math.hypot(...axis) < 1e-6) axis = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];   // opposite: any axis across
  return { axis, deg: (Math.acos(c) * 180) / Math.PI };
}

// Where a held group could go on `studs` (a face's studs, all pointing the
// same way), nearest `point` first: the group turned so the held part's
// underside faces them, moved so one of its hollows takes one of the studs:
// with several parts held, a hollow of any of them that is open (not on the
// studs of another part held: a stack goes on by its lowest part, wherever
// it is held). `held`: { parts, anchor }; `geom(id)`: a part's geometry. Each try:
// { parts, studs } (studs: the ones it takes, [{ at, dir }]). [] when a
// shape is not known.
export function sideTries(held, studs, point, geom, { reach = 20 } = {}) {
  if (!studs.length) return [];
  const n = studs[0].dir, a0 = held.parts[held.anchor];
  const t = turnBetween(upOf(a0), n);
  const parts = t ? rotateParts(held.parts, t.axis, t.deg, geom) : held.parts;
  if (!parts) return [];
  const a = parts[held.anchor], g = geom(a.id);
  if (!g && !a.origin) return [];
  const own = hollowsOf(a, g), mid = own.reduce((s, h) => s.map((v, i) => v + h[i] / own.length), [0, 0, 0]);
  // Every held part's hollows (a part whose shape is not known yet: only the
  // anchor's), less those another held part covers, just under them.
  const solid = parts.filter((q) => q !== a && (!q.origin || q.extent));
  const covered = (h) => { const u = sub(h, n.map((v) => v * 0.8)); return solid.some((q) => { const b = boxMM(q); return [0, 1, 2].every((i) => u[i] > b[i] + 0.05 && u[i] < b[i + 3] - 0.05); }); };
  const holes = [...own, ...parts.filter((q) => q !== a && (geom(q.id) || q.origin)).flatMap((q) => hollowsOf(q, geom(q.id)))].filter((h) => !covered(h));
  // Measured across the face only (how far out from it does not count).
  const across = (v) => { const d = sub(v, point), k = dot(d, n); return Math.hypot(...d.map((x, i) => x - k * n[i])); };
  const tries = [];
  for (const s of studs) {
    if (across(s.at) > reach) continue;
    for (const h of holes) {
      const T = sub(s.at, h), at = mid.map((v, i) => v + T[i]);
      tries.push({ T, score: across(at) });
    }
  }
  tries.sort((u, v) => u.score - v.score);
  const seen = new Set(), out = [];
  for (const { T } of tries) {
    const sig = T.map((v) => Math.round(v * 10)).join();
    if (seen.has(sig)) continue;
    seen.add(sig);
    const placed = parts.map((q) => ({ ...q, x: r4(q.x + T[0] / STUD), y: r4(q.y + T[1] / PLATE), z: r4(q.z + T[2] / STUD) }));
    const moved = holes.map((h) => h.map((v, i) => v + T[i]));
    out.push({ parts: placed, studs: studs.filter((s) => moved.some((h) => Math.hypot(...sub(h, s.at)) < 1)) });
  }
  return out;
}

// The ways a part's side studs point (its row of ldraw/sidestuds.json), each
// once: what its catalogue entry keeps as `side` (lib/studs.mjs faces).
export function sideDirs(rows) {
  const out = new Map();
  for (const s of rows ?? []) { const d = s.slice(3).map((v) => Math.round(v * 100) / 100); if (d[1] < 0.9) out.set(d.join(), d); }
  return [...out.values()];
}
