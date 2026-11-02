// Desktop-builder tools for the workbench: reading LDraw files (.ldr and
// .mpd, submodels and steps included), mirroring and replacing parts, colour
// families for the colour picker, and a model's numbers. Pure: no DOM, no
// network; the caller hands in what it knows about parts.
import { newPart, recompute } from './edit.mjs';
import { figureName } from './figures.mjs';
import { customFromLDraw } from './custom.mjs';
import { flexPart } from './flex.mjs';

// A designed part's own geometry, as fromLDraw's geom gives it (mm, this
// app's axes): its origin on the middle of its top face, studs above.
export const customGeom = (d) => ({ cx: 0, cz: 0, minY: -d.h * 3.2, slopeTurn: 0, box: [-d.w * 4, -d.h * 3.2, -d.d * 4, d.w * 4, d.top === 'smooth' ? 0 : 1.7, d.d * 4] });

const STUD_LDU = 20, PLATE_LDU = 8, STUD_MM = 8, PLATE_MM = 3.2;
const footprint = (p) => (p.rotation === 90 || p.rotation === 270 ? [p.d, p.w] : [p.w, p.d]);
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

// ---------------------------------------------------------------- LDraw in
// The files of an LDraw text by name (lower case; `names` keeps each as
// written): an .ldr is one file, an .mpd several ("0 FILE name"); the first
// is the model.
function files(text) {
  const out = new Map(), names = new Map();
  let cur = null, first = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const f = /^0\s+FILE\s+(.+)$/i.exec(line);
    if (f) { cur = f[1].trim().toLowerCase(); names.set(cur, f[1].trim()); first ??= cur; out.set(cur, []); continue; }
    if (/^0\s+NOFILE\b/i.test(line)) { cur = null; continue; }
    if (cur === null) { if (first === null) { first = ''; out.set('', []); cur = ''; } else continue; }
    out.get(cur).push(line);
  }
  return { first: first ?? '', files: out, names };
}
const mul = (A, B) => {
  // 3 × 3 row-major, then translation: [a..i, x, y, z].
  const r = Array(12).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  for (let i = 0; i < 3; i++) r[9 + i] = A[i * 3] * B[9] + A[i * 3 + 1] * B[10] + A[i * 3 + 2] * B[11] + A[9 + i];
  return r;
};
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

// An LDraw model as parts in this app's frame.
//   dims(id) → { w, d, h, name } from the parts catalogue, or null (the part
//     is left out: no geometry to draw it with).
//   geom(id) → { cx, cz, minY, slopeTurn } of the part's own LDraw geometry
//     in millimetres in this app's axes (null: unknown, so the part keeps its
//     exact LDraw transform).
// A part turned only about the vertical, by quarter turns, becomes an
// ordinary part on the stud grid (moved, turned and checked like any other);
// anything else (a brick on its side, a hinge at an angle, a figure piece)
// keeps its exact LDraw transform. Submodels become sub-builds (named after
// their file); each file's STEPs become the manual's steps.
// Returns { name, parts, steps: [{ parts: [index], assembly }], missing: Map id → count, exact }.
export function fromLDraw(text, { dims, geom = () => null, fallbackColour = 71 } = {}) {
  const { first, files: all, names } = files(text);
  const parts = [], steps = [], missing = new Map(), customs = new Map(), named = new Map();
  let flexNext = null;                  // a flexible part's curve, for the part line after it
  let name = null, exact = 0;
  const title = (all.get(first) ?? []).find((l) => /^0\s+(?!STEP|ROTSTEP|!|FILE|Name:|Author:|BFC)/i.test(l));
  name = (title ? title.replace(/^0\s+/, '') : first.replace(/\.(ldr|mpd|dat)$/i, '')).trim() || 'Imported model';
  let open = null;
  const flush = () => { if (open?.parts.length) steps.push(open); open = null; };
  const walk = (file, M, colour, assembly, depth) => {
    const rows = all.get(file);
    if (!rows || depth > 16) return;
    for (const line of rows) {
      const fm = /^0\s+!NOOKS\s+FLEX\s+(\{.*\})\s*$/i.exec(line);
      if (fm) { try { flexNext = JSON.parse(fm[1]); } catch { flexNext = null; } continue; }
      if (/^0\s+(ROT)?STEP\b/i.test(line)) { if (open?.assembly === assembly) flush(); continue; }
      const t = line.split(/\s+/);
      if (t[0] !== '1' || t.length < 15) continue;
      let code = Number(t[1]);
      if (code === 16 || code === 24 || !Number.isFinite(code)) code = colour;
      const [x, y, z, a, b, c, d, e, f, g, h, i] = t.slice(2, 14).map(Number);
      const W = mul(M, [a, b, c, d, e, f, g, h, i, x, y, z]);
      const ref = t.slice(14).join(' ').toLowerCase().replace(/\\/g, '/');
      // A flexible part written by Nooks: its curve from the meta line, from where its part line puts it.
      if (flexNext) {
        const o = [W[9] * 0.4, -W[10] * 0.4, -W[11] * 0.4], f = flexNext;
        flexNext = null;
        const part = flexPart(f.kind, code, f.points.map((q) => q.map((v, k) => v + o[k])));
        if (part) {
          named.set(part.id, part.name); delete part.name;
          part.assembly = assembly; part.section = assembly;
          if (!open || open.assembly !== assembly) { flush(); open = { parts: [], assembly }; }
          open.parts.push(parts.length);
          parts.push(part);
          exact++;
          continue;
        }
      }
      // A part designed in Nooks, carried in the file as a part of its own.
      const own = all.has(ref) ? customFromLDraw(all.get(ref)) : null;
      if (own) {
        customs.set(own.id, own);
        const part = place(own.id, code, W, own, customGeom(own));
        if (part.origin) exact++;
        part.assembly = assembly; part.section = assembly;
        if (!open || open.assembly !== assembly) { flush(); open = { parts: [], assembly }; }
        open.parts.push(parts.length);
        parts.push(part);
        continue;
      }
      if (all.has(ref)) {
        // A submodel: its own sub-build, its own steps, then on with this file's step.
        const keep = open;
        open = null;
        walk(ref, W, code, (names.get(ref) ?? ref).replace(/\.(ldr|mpd|dat)$/i, '').replace(/_+/g, ' ').trim() || assembly, depth + 1);
        flush();
        open = keep;
        continue;
      }
      const id = ref.replace(/^.*\//, '').replace(/\.dat$/i, '');
      const size = dims(id);
      if (!size) { missing.set(id, (missing.get(id) ?? 0) + 1); continue; }
      const part = place(id, code, W, size, geom(id));
      if (part.origin) exact++;
      part.assembly = assembly; part.section = assembly;
      if (!open || open.assembly !== assembly) { flush(); open = { parts: [], assembly }; }
      open.parts.push(parts.length);
      parts.push(part);
    }
    flush();
  };
  // The main build's sub-build name, when a Nooks file says it (lib/export.mjs toMPD).
  const mainName = (all.get(first) ?? []).map((l) => /^0\s+!NOOKS\s+ASSEMBLY\s+(.+)$/i.exec(l)?.[1]).find(Boolean)?.trim() || 'Model';
  walk(first, IDENT, fallbackColour, mainName, 0);
  flush();
  return { name, parts, steps, missing, exact, customs, named };
}

// One part at LDraw transform W ([a..i, X, Y, Z], LDraw axes).
function place(id, colour, W, size, g) {
  // This app's axes are LDraw's turned half a turn about x: S·R·S with
  // S = diag(1, −1, −1); positions in studs and plates.
  const [a, b, c, d, e, f, gg, h, k, X, Y, Z] = W;
  const R = [a, -b, -c, -d, e, f, -gg, h, k];
  const px = X / STUD_LDU, py = -Y / PLATE_LDU, pz = -Z / STUD_LDU;
  const upright = near(R[4], 1) && near(R[1], 0) && near(R[3], 0) && near(R[5], 0) && near(R[7], 0);
  // Figure pieces keep their transform (they are posed and held by pins), as
  // does a part whose geometry is not known (its seat could not be found).
  const quarter = upright && !!g && !isFigurePiece(id) && [R[0], R[2]].every((v) => near(v, 0) || near(Math.abs(v), 1));
  const part = newPart(id, colour, 0, 0, 0, 'Model', size);
  if (quarter) {
    // A turn of θ about +y (three's makeRotationY: a = cos θ, c = sin θ).
    const theta = Math.round((Math.atan2(R[2], R[0]) * 180) / Math.PI);
    const { cx, cz, minY } = g;
    // The footprint's middle: the geometry's middle, turned and moved.
    const wx = px * STUD_MM + R[0] * cx + R[2] * cz, wz = pz * STUD_MM + R[6] * cx + R[8] * cz;
    const turn = part.shape === 'slope' ? g.slopeTurn ?? 0 : 0;
    part.rotation = (((theta - turn) % 360) + 360) % 360;
    part.x = snapHalf(wx / STUD_MM); part.z = snapHalf(wz / STUD_MM);
    // Heights to a quarter plate (a part on its own LDraw origin may sit between plates).
    part.y = Math.round(((py * PLATE_MM + minY) / PLATE_MM) * 4) / 4;
    return part;
  }
  return { ...part, x: px, y: py, z: pz, rotation: 0, origin: true, ldMatrix: R, studs: false };
}
const snapHalf = (v) => Math.round(v * 2) / 2;
// Minifigure pieces by design number (heads and their prints, torsos, hips,
// legs, arms, hands, hair and headgear), and any the figures module names.
const FIGURE_PIECE = /^(3626|3815|3816|3817|3818|3819|3820|970|971|972|973|976|977|981|982|983|3901|4530|4485|3624|3833|3878|3844|6132|62810|85974|92081|40233|40240|40251|87991|30608)/;
export const isFigurePiece = (id) => !!figureName(id) || FIGURE_PIECE.test(String(id));

// A model from an LDraw text: parts, sub-builds and the file's steps,
// re-checked by the step planner (a step that breaks the build order is
// repaired, the rest are kept). `dims`, `geom`: as fromLDraw. `keepSteps`:
// the file's steps exactly, unplanned (a set drawn up from a designer's
// booklet: the planner's stud columns do not see clips, bars or parts on
// their sides, and its repairs would put parts on before what holds them).
export function modelFromLDraw(text, opts = {}, fileName = 'model.ldr') {
  const r = fromLDraw(text, opts);
  const parts = r.parts.map((p, i) => ({ ...p, key: i }));
  // On the desk: the lowest part stands at plate 0 (LDraw files sit anywhere).
  const low = Math.min(...parts.map((p) => (p.origin ? Infinity : p.y)));
  if (Number.isFinite(low) && low !== 0) for (const p of parts) p.y -= low;
  const model = {
    name: r.name, parts, catalog: {}, colors: {}, sections: [], inventory: [], steps: [],
    validation: { valid: true, components: 1, floating: [] },
    provenance: { source: { kind: 'ldraw', file: fileName }, evidence: { design: `read from the LDraw file ${fileName}` } },
  };
  for (const [id, def] of r.customs) model.catalog[id] = def;
  for (const [id, nm] of r.named) model.catalog[id] ??= { name: nm };
  for (const p of parts) { const s = opts.dims(p.id); model.catalog[p.id] ??= { name: s?.name ?? p.id, w: p.w, d: p.d, h: p.h }; }
  const steps = r.steps.map((s) => ({ parts: s.parts.map((i) => parts[i].key), assembly: s.assembly }));
  recompute(model, steps);
  if (opts.keepSteps) model.steps = steps;
  return { model, missing: r.missing, exact: r.exact, skipped: [...r.missing.values()].reduce((s, n) => s + n, 0) };
}

// ---------------------------------------------------------------- mirror
// Parts mirrored left to right (`axis` 'x') or front to back ('z') about
// their own middle, as copies; the stud grid kept (edges map onto edges).
// `counterpart(id)`: the part's mirror twin (a left wing for a right one),
// or null when it is its own. `sum`: twice the mirror's place in studs
// (mirrorSum: the parts' own middle), so some of a selection can be mirrored
// this way and the rest another (lib/subbuild.mjs mirrorBy).
export function mirrorSum(parts, axis = 'x') {
  let lo = Infinity, hi = -Infinity;
  for (const p of parts) {
    const [fx, fz] = p.origin ? [0, 0] : footprint(p), v = p[axis], half = (axis === 'x' ? fx : fz) / 2;
    lo = Math.min(lo, v - half); hi = Math.max(hi, v + half);
  }
  return Math.round((lo + hi) * 2) / 2;
}
export function mirrorParts(parts, axis = 'x', counterpart = () => null, { sum = mirrorSum(parts, axis) } = {}) {
  if (!parts.length) return [];
  return parts.map((p) => {
    const q = { ...p, ldMatrix: p.ldMatrix && [...p.ldMatrix] };
    q[axis] = sum - p[axis];
    if (p.origin && p.ldMatrix) {
      // F·M·F with F flipping the axis: the same rotation, seen in the mirror.
      const F = axis === 'x' ? [-1, 1, 1] : [1, 1, -1], M = p.ldMatrix;
      q.ldMatrix = M.map((v, i) => v * F[Math.floor(i / 3)] * F[i % 3]);
    } else {
      // A quarter turn mirrors to the other way round (front to back: and half a turn).
      const r = p.rotation || 0;
      q.rotation = axis === 'x' ? (360 - r) % 360 : (540 - r) % 360;
      const twin = counterpart(p.id);
      if (twin) q.id = twin;
    }
    return q;
  });
}

// ---------------------------------------------------------------- replace
// Part `p` as design `id` (size `size` { w, d, h }) in `colour`: the same
// corner, height and turn. A copy; the caller checks it fits.
export function replacePart(p, id, size, colour = p.color) {
  const [fx, fz] = footprint(p);
  const q = { ...newPart(id, colour, 0, 0, p.y, p.section, size), key: p.key, rotation: p.rotation || 0, assembly: p.assembly, section: p.section, group: p.group };
  const [gx, gz] = footprint(q);
  q.x = p.x - fx / 2 + gx / 2; q.z = p.z - fz / 2 + gz / 2;
  return q;
}

// ---------------------------------------------------------------- colours
// The families a colour picker groups colours in, by name.
export const FAMILIES = ['Solid', 'Transparent', 'Metallic and pearl', 'Special'];
export function familyOf(c) {
  const n = String(c?.name ?? '');
  if (c?.trans || /^trans/i.test(n)) return 'Transparent';
  if (/chrome|metallic|pearl|metal|gold|silver|copper|bronze/i.test(n)) return 'Metallic and pearl';
  if (/glitter|speckle|glow|satin|opal|milky|rubber|modulex|fabuland|electric|reflective|magnet/i.test(n)) return 'Special';
  return 'Solid';
}

// ---------------------------------------------------------------- numbers
// A model's numbers, for the model's info: pieces, kinds, colours, size in
// studs and centimetres, steps, sub-builds and figures.
export function modelStats(model) {
  const ps = model.parts;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = 0;
  for (const p of ps) { const [fx, fz] = footprint(p); x0 = Math.min(x0, p.x - fx / 2); x1 = Math.max(x1, p.x + fx / 2); z0 = Math.min(z0, p.z - fz / 2); z1 = Math.max(z1, p.z + fz / 2); y1 = Math.max(y1, p.y + p.h); }
  const studs = ps.length ? [Math.round(x1 - x0), Math.round(z1 - z0)] : [0, 0];
  const figures = new Set(ps.filter((p) => p.origin && /^381[67]/.test(p.id)).map((p) => p.assembly)).size;
  return {
    pieces: ps.length,
    lots: new Set(ps.map((p) => `${p.id}|${p.color}`)).size,
    designs: new Set(ps.map((p) => p.id)).size,
    colours: new Set(ps.map((p) => p.color)).size,
    studs, plates: Math.ceil(y1),
    cm: [studs[0] * 0.8, studs[1] * 0.8, (y1 * PLATE_MM) / 10].map((v) => Math.round(v * 10) / 10),
    steps: model.steps?.length ?? 0,
    subBuilds: new Set((model.steps ?? []).map((s) => s.assembly).filter(Boolean)).size,
    figures,
    groups: new Set(ps.map((p) => p.group).filter(Boolean)).size,
  };
}

// ---------------------------------------------------------------- free turns
// Turning parts about any axis by any angle (a brick laid on its side, a
// hinge at 30°). A part is handled as its LDraw origin O (mm, this app's
// axes) and rotation M; after the turn it is an ordinary part on the stud
// grid again when it ends up upright and quarter-turned, or keeps its own
// matrix with `extent`, its box about its origin (studs and plates), so
// placing and the connection check know where it is. `geom(id)` as
// fromLDraw, plus `box` [minX, minY, minZ, maxX, maxY, maxZ] of its own
// geometry (mm).
const clean = (v) => (Math.abs(v) < 1e-9 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-9 ? Math.sign(v) : v);
const rot = (axis, deg) => {
  const t = (deg * Math.PI) / 180, c = clean(Math.cos(t)), s = clean(Math.sin(t));
  if (Array.isArray(axis)) {
    // About any axis (a hinge's pin): Rodrigues' formula.
    const n = Math.hypot(...axis) || 1, [x, y, z] = axis.map((v) => v / n), C = 1 - c;
    return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C].map(clean);
  }
  return axis === 'x' ? [1, 0, 0, 0, c, -s, 0, s, c] : axis === 'z' ? [c, -s, 0, s, c, 0, 0, 0, 1] : [c, 0, s, 0, 1, 0, -s, 0, c];
};
const mm3 = (A, B) => { const r = Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = clean(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]); return r; };
const app3 = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
const r4 = (v) => Math.round(v * 1e4) / 1e4;

// A part as its LDraw origin and rotation.
export function freeForm(p, g) {
  if (p.origin && p.ldMatrix) return { O: [p.x * STUD_MM, p.y * PLATE_MM, p.z * STUD_MM], M: [...p.ldMatrix] };
  const M = rot('y', (p.rotation || 0) + (p.shape === 'slope' ? g.slopeTurn ?? 0 : 0));
  return { O: [p.x * STUD_MM - (M[0] * g.cx + M[2] * g.cz), p.y * PLATE_MM - g.minY, p.z * STUD_MM - (M[6] * g.cx + M[8] * g.cz)], M };
}
// Back from an origin and rotation to a part (a copy of `p`).
export function fromFree(p, O, M, g) {
  const R = M.map(clean);
  const upright = near(R[4], 1) && near(R[1], 0) && near(R[3], 0) && near(R[5], 0) && near(R[7], 0);
  const quarter = upright && !p.figure && !isFigurePiece(p.id) && [R[0], R[2]].every((v) => near(v, 0) || near(Math.abs(v), 1));
  // The part as a fresh one says it: its shape and studs on the grid.
  const fresh = newPart(p.id, p.color, 0, 0, 0, p.section, { w: p.w, d: p.d, h: p.h });
  const out = { ...p, ldMatrix: undefined, origin: undefined, extent: undefined, shape: fresh.shape ?? (p.origin ? undefined : p.shape), studs: fresh.studs };
  if (quarter) {
    const theta = Math.round((Math.atan2(R[2], R[0]) * 180) / Math.PI), turn = out.shape === 'slope' ? g.slopeTurn ?? 0 : 0;
    out.rotation = (((theta - turn) % 360) + 360) % 360;
    out.x = r4((O[0] + R[0] * g.cx + R[2] * g.cz) / STUD_MM);
    out.z = r4((O[2] + R[6] * g.cx + R[8] * g.cz) / STUD_MM);
    out.y = r4((O[1] + g.minY) / PLATE_MM);
    return out;
  }
  Object.assign(out, { x: r4(O[0] / STUD_MM), y: r4(O[1] / PLATE_MM), z: r4(O[2] / STUD_MM), rotation: 0, ldMatrix: R, origin: true, studs: false, shape: p.shape });
  if (g?.box && !isFigurePiece(p.id)) {
    const [x0, y0, z0, x1, y1, z1] = g.box, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) { const v = app3(R, [x, y, z]); for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); } }
    out.extent = [lo[0] / STUD_MM, lo[1] / PLATE_MM, lo[2] / STUD_MM, hi[0] / STUD_MM, hi[1] / PLATE_MM, hi[2] / STUD_MM].map(r4);
  }
  return out;
}
// A part's box in the world (mm): [minX, minY, minZ, maxX, maxY, maxZ].
export function worldBox(p) {
  if (p.origin && p.extent) { const e = p.extent; return [(p.x + e[0]) * STUD_MM, (p.y + e[1]) * PLATE_MM, (p.z + e[2]) * STUD_MM, (p.x + e[3]) * STUD_MM, (p.y + e[4]) * PLATE_MM, (p.z + e[5]) * STUD_MM]; }
  if (p.origin) return [(p.x - 0.5) * STUD_MM, (p.y - 4) * PLATE_MM, (p.z - 0.5) * STUD_MM, (p.x + 0.5) * STUD_MM, p.y * PLATE_MM, (p.z + 0.5) * STUD_MM];
  const [fx, fz] = footprint(p);
  return [(p.x - fx / 2) * STUD_MM, p.y * PLATE_MM, (p.z - fz / 2) * STUD_MM, (p.x + fx / 2) * STUD_MM, (p.y + p.h) * PLATE_MM, (p.z + fz / 2) * STUD_MM];
}
// Where a part's hinge pin is in the world (mm): { at, axis } or null.
// `joints`: the part's own (ldraw/joints.json: middles and axes about its
// LDraw origin, mm, this app's axes); `g` as freeForm. A finger row, clip,
// pin or bar is a pin; with several, the one nearest `near` (mm), the part
// it turns.
const PIN_KINDS = { fgr: 0, clp: 1, cyl: 2, gen: 3 };
export function pinOf(p, joints, g, near = null) {
  const pins = (joints ?? []).filter((j) => j.k in PIN_KINDS && j.a);
  if (!pins.length || (!g && !p.origin)) return null;
  const { O, M } = freeForm(p, g ?? { cx: 0, cz: 0, minY: 0 });
  const world = pins.map((j) => ({ j, at: app3(M, j.p).map((v, i) => r4(v + O[i])), axis: app3(M, j.a).map(clean) }));
  const d = (w) => (near ? Math.hypot(...w.at.map((v, i) => v - near[i])) : 0);
  world.sort((a, b) => PIN_KINDS[a.j.k] - PIN_KINDS[b.j.k] || d(a) - d(b));
  // The best kind first; among those, the nearest.
  const best = world.filter((w) => w.j.k === world[0].j.k).sort((a, b) => d(a) - d(b))[0];
  return { at: best.at, axis: best.axis, kind: best.j.k };
}
// Parts turned `degrees` about `axis` ('x' across the view, 'z' front to
// back, 'y' upright, or a direction [x, y, z]) about their middle, as copies; then set down where they
// were (their lowest point where it was) and, for quarter turns, back on the
// half-stud grid. `pivot` (mm): turned about that point instead (a hinge's
// pin), and left where the turn puts them. Null when a part's geometry is
// not known.
export function rotateParts(parts, axis, degrees, geom, { pivot = null } = {}) {
  const gs = parts.map((p) => geom(p.id));
  if (gs.some((g, i) => !g && !parts[i].origin)) return null;
  const before = parts.map(worldBox), lowY = Math.min(...before.map((b) => b[1]));
  const C = pivot ?? [0, 1, 2].map((k) => (Math.min(...before.map((b) => b[k])) + Math.max(...before.map((b) => b[k + 3]))) / 2);
  const Q = rot(axis, degrees);
  const turned = parts.map((p, i) => {
    const { O, M } = freeForm(p, gs[i] ?? { cx: 0, cz: 0, minY: 0 });
    const v = app3(Q, [O[0] - C[0], O[1] - C[1], O[2] - C[2]]);
    return { O: [C[0] + v[0], C[1] + v[1], C[2] + v[2]], M: mm3(Q, M) };
  });
  let out = turned.map((t, i) => fromFree(parts[i], t.O, t.M, gs[i] ?? { cx: 0, cz: 0, minY: 0 }));
  if (pivot) return out;
  // Down (or up) to where it stood, and onto the grid it was on.
  const quarter = Math.abs(degrees % 90) < 1e-9;
  const after = out.map(worldBox), dy = lowY - Math.min(...after.map((b) => b[1]));
  const snap = (now, was) => (quarter ? Math.round((now - was) / 4) * 4 - (now - was) : 0);
  const dx = snap(Math.min(...after.map((b) => b[0])), Math.min(...before.map((b) => b[0])));
  const dz = snap(Math.min(...after.map((b) => b[2])), Math.min(...before.map((b) => b[2])));
  out = out.map((q) => ({ ...q, x: r4(q.x + dx / STUD_MM), y: r4(q.y + dy / PLATE_MM), z: r4(q.z + dz / STUD_MM) }));
  return out;
}

// ---------------------------------------------------------------- wanted list
// The parts list as a wanted list in the XML that parts marketplaces import
// (item, colour, quantity). Colours by the numbers that format uses, for the
// colours with a known match; any other colour is reported, not guessed.
export const MARKET_COLOUR = {
  0: 11, 1: 7, 2: 6, 3: 39, 4: 5, 5: 47, 6: 8, 7: 9, 8: 10, 9: 62, 10: 36, 11: 40, 12: 25, 13: 23, 14: 3, 15: 1, 17: 38, 18: 33, 19: 2, 20: 44, 22: 24, 25: 4, 26: 71, 27: 34, 28: 69, 29: 104, 30: 157, 31: 154,
  70: 88, 71: 86, 72: 85, 73: 42, 74: 37, 77: 56, 78: 90, 84: 150, 85: 89, 92: 28, 100: 26, 110: 43, 115: 76, 118: 41, 120: 35, 125: 32, 151: 99, 191: 110, 212: 105, 226: 103, 232: 87, 272: 63, 288: 80, 308: 120,
  313: 72, 320: 59, 321: 153, 322: 156, 323: 152, 326: 158, 330: 155, 335: 58, 351: 94, 366: 29, 373: 54, 378: 48, 379: 55, 462: 31, 484: 68, 503: 49,
  33: 14, 34: 20, 35: 108, 36: 17, 37: 50, 38: 18, 40: 13, 41: 74, 42: 16, 43: 15, 45: 107, 46: 19, 47: 12, 52: 51, 54: 121, 57: 98,
  80: 67, 82: 65, 135: 66, 142: 61, 148: 77, 179: 95, 297: 115, 334: 21, 383: 22,
};
// `marketId(id)`: the item number marketplaces know a part by, where it is not
// the LDraw one (a printed part: 98138p07 is 98138pb007 there).
export function toWantedList(model, marketId = (id) => id) {
  const rows = [], skipped = [];
  for (const i of model.inventory ?? []) {
    // A part designed here is no marketplace item.
    if (String(i.id).startsWith('nk-')) { skipped.push({ ...i, colorName: `${i.name} (designed here)` }); continue; }
    const c = MARKET_COLOUR[i.color];
    if (c === undefined) { skipped.push(i); continue; }
    rows.push(`  <ITEM>\n    <ITEMTYPE>P</ITEMTYPE>\n    <ITEMID>${String(marketId(i.id) ?? i.id).replace(/[<&>]/g, '')}</ITEMID>\n    <COLOR>${c}</COLOR>\n    <MINQTY>${i.quantity}</MINQTY>\n  </ITEM>`);
  }
  return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n<INVENTORY>\n${rows.join('\n')}\n</INVENTORY>\n`, lots: rows.length, skipped };
}
