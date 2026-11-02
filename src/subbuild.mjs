// Sub-builds and mirroring in the workbench (docs/BUILD_BY_CONNECTOR.md, piece 2).
//
// A sub-build is a named definition, model.subBuilds[id] = { name, parts }: workbench parts as its first copy stood
// when it was made. Its copies are parts in the build carrying `sub` { s: id, c: copy, k: index in the definition },
// grouped (`group` 'sub:<copy>') so they are picked and moved as one. A copy stands where one rigid move puts the
// definition's parts; changing one copy changes the definition, and every other copy is made again from it. The
// record (lib/record.mjs) keeps the definition once (`define … end`) and each copy as `add { use }` or `attach`.
//
// Mirroring goes by BrickNet's verified counterparts (lib/assembly.mjs mirrorOf: the twin part and the correction
// that makes the mirror image a real placement of it), the parts' own name-swap twin ("Left" for "Right") where
// BrickNet has none, and is refused, naming the parts, where neither exists.
//
// Pure: the caller passes each part's geometry (geom(id), as lib/studio.mjs freeForm takes it) and, for mirroring,
// BrickNet's tables (lib/bricknet.mjs load) with the twins' connectors in them.
import { compose, inverse } from './pose.mjs';
import { freeForm, fromFree, mirrorParts, mirrorSum } from './studio.mjs';
import { poseOf, partFromPose } from './bridge.mjs';

const STUD_MM = 8, PLATE_MM = 3.2, LDU_PER_STUD = 20;
// What a definition doesn't keep: where a part is in this build's bookkeeping, not what it is.
const LOCAL = ['key', 'sub', 'group', 'edited', 'pose', 'section', 'assembly'];
export const strip = (p) => { const q = { ...p, ldMatrix: p.ldMatrix && [...p.ldMatrix], extent: p.extent && [...p.extent] }; for (const f of LOCAL) delete q[f]; return q; };
export const groupOf = (copy) => `sub:${copy}`;

// A part's frame: its LDraw origin and rotation in millimetres, this app's axes (lib/studio.mjs freeForm), or null
// when its geometry isn't known yet.
const NO_GEOM = { cx: 0, cz: 0, minY: 0 };
function frameOf(p, geom) {
  if (p.origin && p.ldMatrix) { const { O, M } = freeForm(p, null); return { r: M, t: O }; }
  const g = geom(p.id);
  if (!g) return null;
  const { O, M } = freeForm(p, g);
  return { r: M, t: O };
}
// A part (a copy of `p`) at frame `f`: on the grid again when the frame is upright and a quarter turn, and otherwise
// at its exact origin (fromFree rounds to 1e-4 of a stud, which suits the grid).
function atFrame(p, f, geom) {
  const out = fromFree(p, f.t, f.r, geom(p.id) ?? NO_GEOM);
  if (out.origin) Object.assign(out, { x: f.t[0] / STUD_MM, y: f.t[1] / PLATE_MM, z: f.t[2] / STUD_MM });
  return out;
}
const close = (a, b, mm) => a.t.every((v, i) => Math.abs(v - b.t[i]) < mm) && a.r.every((v, i) => Math.abs(v - b.r[i]) < 1e-6);

// A new sub-build of `parts` (in the order they're given, which becomes the definition's): the definition, and the
// `sub` each part gets as the first copy.
export function defineSubBuild(parts, { id, name }) {
  const copy = `${id}.1`;
  return { def: { name: String(name).slice(0, 60) || 'Sub-build', parts: parts.map(strip), copies: 1 }, tags: parts.map((_, k) => ({ s: id, c: copy, k })), copy };
}

// Where a copy stands: the rigid move (a pose in millimetres) that puts the definition's parts where `copy` has them
// (copy[k] for the definition's part k), or null when it doesn't (a part of it moved, turned, recoloured or swapped on
// its own, or one is missing). `mm`: how far a part may be off (fromFree's rounding is under 0.001 mm).
export function copyTransform(copy, def, geom, { mm = 0.01 } = {}) {
  if (copy.length !== def.parts.length) return null;
  let X = null;
  for (let k = 0; k < def.parts.length; k++) {
    const p = copy[k], d = def.parts[k];
    if (!p || p.id !== d.id || p.color !== d.color) return null;
    const W = frameOf(p, geom), D = frameOf(d, geom);
    if (!W || !D) return null;
    if (!X) { X = compose(W, inverse(D)); continue; }
    if (!close(compose(X, D), W, mm)) return null;
  }
  return X;
}

// The definition's parts moved by X (copyTransform's): a copy's new parts, in the definition's order (no keys).
export function placeCopy(def, X, geom) {
  return def.parts.map((d) => { const D = frameOf(d, geom); return D ? atFrame(d, compose(X, D), geom) : null; });
}

// The definition a copy's parts give, standing where X puts the definition: each moved back by X. `parts` in the
// order the definition keeps them (a part added while editing goes at the end).
export function redefine(def, parts, X, geom) {
  const back = inverse(X);
  return { ...def, parts: parts.map((p) => { const W = frameOf(p, geom); return strip(W ? atFrame(p, compose(back, W), geom) : p); }) };
}

// The build's copies: Map copy → { s, parts: [part by k] }.
export function copiesOf(model) {
  const out = new Map();
  for (const p of model.parts) {
    if (!p.sub) continue;
    if (!out.has(p.sub.c)) out.set(p.sub.c, { s: p.sub.s, parts: [] });
    out.get(p.sub.c).parts[p.sub.k] = p;
  }
  return out;
}

// ---- mirroring
// The mirror's plane in LDraw units for a workbench mirror left to right ('x') or front to back ('z') at `sum`
// (lib/studio.mjs mirrorSum, twice its place in studs): BrickAgent's mirror axis and `about` point.
export const mirrorPlane = (axis, sum) => ({ axis, about: axis === 'x' ? [(sum / 2) * LDU_PER_STUD, 0, 0] : [0, 0, (-sum / 2) * LDU_PER_STUD] });
const reflection = ({ axis, about }) => (axis === 'x' ? { r: [-1, 0, 0, 0, 1, 0, 0, 0, 1], t: [2 * about[0], 0, 0] } : { r: [1, 0, 0, 0, 1, 0, 0, 0, -1], t: [0, 0, 2 * about[2]] });
const fromRows = (m) => ({ r: [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]], t: [m[0][3], m[1][3], m[2][3]] });

// A part's verified counterpart: { id (ours), stem } or null when BrickNet has none for it.
export function counterpartOf(p, T, geom) {
  const at = T && !p.flex && poseOf(p, T, geom), m = at && T.mirror?.[at.stem];
  const id = m && T.reverse.get(m[0])?.id;
  return id ? { id, stem: m[0], at, correction: fromRows(m[1]) } : null;
}

// `parts` mirrored about their own middle: { parts (each the mirrored copy of the one given, in order), how: per part
// 'verified' | 'name', plane, refused: [part ids] }. With anything refused, `parts` is null. `size(id)`: the catalogue's
// { w, d, h } for a twin; `twinOf(id)`: the name-swap twin or null; a twin's connectors and geometry must be loaded.
export function mirrorBy(parts, axis, { T = null, geom, twinOf = () => null, size = () => null }) {
  const sum = mirrorSum(parts, axis), plane = mirrorPlane(axis, sum), F = reflection(plane);
  const out = [], how = [], refused = [];
  for (const p of parts) {
    const c = counterpartOf(p, T, geom);
    if (c && T.stems.has(c.stem) && (p.origin || geom(c.id))) {
      const q = partFromPose({ ...p, id: c.id, ...(c.id !== p.id ? size(c.id) ?? {} : {}) }, compose(compose(F, c.at.pose), c.correction), T, geom);
      out.push(q); how.push('verified');
      continue;
    }
    const twin = !p.flex && twinOf(p.id);
    if (twin) { out.push(mirrorParts([p], axis, () => twin, { sum })[0]); how.push('name'); continue; }
    refused.push(p.id);
  }
  return { parts: refused.length ? null : out, how, plane, refused: [...new Set(refused)] };
}
