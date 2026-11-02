// Build programs: how an agent sends a model it builds part by part. A program is plain JSON data, a list of ops
// that drive lib/assembly.mjs (BrickAgent's construction, ported), so what an agent sends can never run code, can be
// stored with the revision it made, replayed, diffed and extended. compile() turns one into the checks' verdict and
// LDraw, which the workbench reads like any model.
//
//   { name: 'bridge', ops: [
//     { op: 'add', name: 'left', part: 'brick 1x1', color: 'tan' },
//     { op: 'add', name: 'right', part: 'brick 1x1', pose: [{ at: [2, 0, 0] }], color: 'tan' },
//     { op: 'attach', name: 'span', part: 'plate 1x3', to: 'left.stud[0]', by: ['hole', 0], orient: [], color: 'red' },
//     { op: 'contact', a: 'span.hole[2]', b: 'right.stud[0]' },
//   ] }
//
// Ops:
//   add     { name?, part | use, pose?, color? }               a part (number or name) or a defined assembly
//   attach  { name?, part | use, to, by?, yaw?, flip?, slide?, seat?, align?, orient?, color? }
//           by: [type, index] for a part; for an assembly, the name of a connector it returns
//   define  { name } … end { returns?: { name: ref } }         a reusable assembly; its ops go between
//   mirror  { name?, of, axis?, about?, pose? }                a mirrored copy of a placement, added; or, when `of`
//           names a definition, its mirror image added (at `pose`, or where the definition stands)
//   contact { a, b }                                           a join check() must also find (a span's far end)
//   flex    { name?, kind, points, color? }                    switched off for now (lib/flex.mjs HOSES). A hose or string (lib/flex.mjs: ribbed, pneumatic, soft,
//           string) along a curve through its control points (LDU, 2 to 12, ends first and last), top level only.
//           Checked as the workbench checks one put in place: a stock length reaches along the curve, each end is on
//           a part, and it passes through no part or other hose (against the finished model, whatever the order)
//   base    { revision }                                       start from a saved revision's parts (a person's hand
//           edit, a script's model, an imported file), each placed where it is and named p0, p1, … in its order
//           (first in the program only; the caller resolves the revision to LDraw: runProgram's `bases`)
// Refs: 'name.stud[0]', 'name.socket[-1]', 'name.hole.near(x, y, z)', and for a copy of an assembly 'copy:returned'
// or 'copy/inner.stud[0]', a connector of the part named `inner` in its definition (in a mirrored copy, its twin's).
// Poses: a list composed left to right, as BrickAgent's at(x=1) @ spin(UP, 90):
//   { at: [x, y, z] } studs/plates/studs · { move: [x, y, z] } LDU · { spin: [axis | 'up', degrees, about?] }
//   · { ldraw: [x, y, z, a, b, c, d, e, f, g, h, i] } an exact pose, as an LDraw line gives it
// LDraw units and axes (-y up); a stud is 20, a plate 8.
import { Assembly, Connector, check, parts, connections, toLDraw, measure, partBox, colour as colourOf } from './assembly.mjs';
import { ID, UP, at, move, spin, compose, fromLDraw } from './pose.mjs';
import { readFiles } from './raster.mjs';
import { NoMate } from './bricknet.mjs';
import { overlaps } from './benchmark.mjs';
import { FLEX, HOSES, HOSES_OFF, flexPart, flexCheck, worldPoints } from './flex.mjs';
import { boxMM } from './studs.mjs';

export const LIMITS = { ops: 20001, parts: 20000, depth: 8 };

function poseOf(spec) {
  if (spec === undefined || spec === null) return ID;
  if (!Array.isArray(spec)) throw new Error('A pose is a list of steps: { at }, { move } or { spin }.');
  return spec.reduce((p, step) => {
    if (step?.at) return compose(p, at(...step.at));
    if (step?.move) return compose(p, move(...step.move));
    if (step?.spin) { const [axis, deg, about] = step.spin; return compose(p, spin(axis === 'up' ? UP : axis, deg, about)); }
    if (step?.ldraw) {
      const n = step.ldraw;
      if (!Array.isArray(n) || n.length !== 12 || !n.every(Number.isFinite)) throw new Error('{ ldraw } is twelve numbers: x y z a b c d e f g h i.');
      return compose(p, fromLDraw(n));
    }
    throw new Error('A pose step is { at: [x, y, z] }, { move: [x, y, z] }, { spin: [axis, degrees] } or { ldraw: [12 numbers] }.');
  }, ID);
}

// Run a program: { model: the root Assembly, contacts, names: Map name → occurrence (root scope), fixed, flexes: [{
// name, part (the workbench's flexible part), op }] }. Throws an Error naming the op that failed and why.
// `roomForFlex`: false skips the hoses' room check (replaying a construction record, which only compares parts).
// `hoses`: whether the flex op is allowed (lib/flex.mjs HOSES; a construction record replays its old hoses).
export function runProgram(program, T, { bases = {}, roomForFlex = true, hoses = HOSES } = {}) {
  if (!program || !Array.isArray(program.ops)) throw new Error('A program is { name, ops: [ … ] }.');
  if (program.ops.length > LIMITS.ops) throw new Error(`A program is at most ${LIMITS.ops} ops.`);
  const defs = new Map();                 // name → { asm, returns: Map }
  const mirrors = new Map();              // a definition's mirror image (an Assembly) → that definition
  const root = { asm: new Assembly(String(program.name ?? 'model').slice(0, 80), T), names: new Map(), returns: null };
  const stack = [root], contacts = [], fixed = [], flexes = [];
  let count = 0;
  const scope = () => stack.at(-1);
  const ref = (text) => {
    const s = String(text ?? '');
    let m = /^([^./:\s]+)\/([^./\s]+)\.([a-z]+)\[(-?\d+)\]$/.exec(s);
    if (m) {
      const occ = scope().names.get(m[1]);
      if (!occ) throw new NoMate(`No placement named ${m[1]} here.`);
      if (occ.isPart) throw new NoMate(`${m[1]} is a part; use ${m[1]}.type[index].`);
      const source = mirrors.get(occ.what), def = source ?? [...defs.values()].find((d) => d.asm === occ.what);
      let inner = def?.names.get(m[2]);
      if (!inner) throw new NoMate(`${m[1]} has no part named ${m[2]}.`);
      if (source) inner = occ.what.mirrored.get(inner.key);
      if (!inner?.isPart) throw new NoMate(`${m[1]}/${m[2]} is not a part.`);
      return occ.ref(inner.c(m[3], Number(m[4])));
    }
    m = /^([^.:\s]+):([^.\s]+)$/.exec(s);
    if (m) {
      const occ = scope().names.get(m[1]);
      if (!occ) throw new NoMate(`No placement named ${m[1]}.`);
      if (occ.isPart) throw new NoMate(`${m[1]} is a part; use ${m[1]}.type[index].`);
      const def = [...defs.values()].find((d) => d.asm === occ.what);
      const r = def?.returns?.get(m[2]);
      if (!r) throw new NoMate(`${m[1]} returns no connector named ${m[2]}${def?.returns?.size ? `; it returns ${[...def.returns.keys()].join(', ')}` : ''}.`);
      return occ.ref(r);
    }
    m = /^([^.\s]+)\.([a-z]+)(?:\[(-?\d+)\]|\.near\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\))$/.exec(s);
    if (!m) throw new NoMate(`Not a connector: "${s}". Write name.stud[0], name.hole.near(x, y, z) or copy:returned.`);
    const occ = scope().names.get(m[1]);
    if (!occ) throw new NoMate(`No placement named ${m[1]} here.`);
    return m[3] !== undefined ? occ.c(m[2], Number(m[3])) : occ.near(m[2], [Number(m[4]), Number(m[5]), Number(m[6])]);
  };
  const what = (o) => {
    if (o.use !== undefined) { const d = defs.get(o.use); if (!d) throw new NoMate(`No assembly defined as ${o.use}.`); return d; }
    if (typeof o.part !== 'string') throw new NoMate('Give a part (number or name) or use (a defined assembly).');
    return null;
  };
  program.ops.forEach((o, n) => {
    try {
      const here = scope();
      const keep = (occ) => { if (here === root) count += occ.isPart ? 1 : parts(occ).length; if (o.name !== undefined) { if (here.names.has(o.name)) throw new NoMate(`${o.name} is already a name here.`); here.names.set(String(o.name), occ); } };
      switch (o?.op) {
        case 'add': {
          const d = what(o);
          keep(here.asm.add(d ? d.asm : o.part, { pose: poseOf(o.pose), color: o.color ?? null }));
          break;
        }
        case 'attach': {
          const d = what(o), to = ref(o.to);
          let by = null;
          if (d) {
            const r = d.returns?.get(o.by);
            if (!r) throw new NoMate(`by for an assembly is the name of a connector it returns${d.returns?.size ? `: ${[...d.returns.keys()].join(', ')}` : ' (it returns none)'}.`);
            by = r;
          } else if (o.by !== undefined && o.by !== null) by = o.by;
          const opts = { yaw: o.yaw ?? 0, slide: o.slide ?? 0, flip: o.flip ?? null, seat: o.seat ?? 'auto', align: o.align ?? null, orient: o.orient !== undefined ? poseOf(o.orient) : null };
          keep(here.asm.attach(d ? d.asm : o.part, { to, by, color: o.color ?? null, ...opts }));
          break;
        }
        case 'define': {
          if (stack.length > LIMITS.depth) throw new Error(`Assemblies nest at most ${LIMITS.depth} deep.`);
          if (defs.has(o.name)) throw new NoMate(`${o.name} is already defined.`);
          stack.push({ asm: new Assembly(String(o.name), T), names: new Map(), returns: new Map(), name: String(o.name) });
          break;
        }
        case 'end': {
          if (stack.length < 2) throw new Error('end without define.');
          for (const [k, r] of Object.entries(o.returns ?? {})) here.returns.set(k, ref(r));
          stack.pop();
          defs.set(here.name, here);
          break;
        }
        case 'mirror': {
          const occ = here.names.get(o.of), def = !occ && defs.get(o.of);
          if (!occ && !def) throw new NoMate(`No placement or definition named ${o.of}.`);
          if (occ) { keep(here.asm.add(occ.mirror(o.axis ?? 'x', { about: o.about ?? [0, 0, 0] }))); break; }
          const image = def.asm.mirror(o.axis ?? 'x', { about: o.about ?? [0, 0, 0] });
          mirrors.set(image, def);
          keep(here.asm.add(image, { pose: poseOf(o.pose) }));
          break;
        }
        case 'contact': contacts.push([ref(o.a), ref(o.b)]); break;
        case 'flex': {
          if (!hoses) throw new NoMate(HOSES_OFF);
          if (here !== root) throw new Error('flex goes at the top level, not inside define.');
          const k = FLEX[o.kind];
          if (!k) throw new NoMate(`kind is one of ${Object.keys(FLEX).join(', ')}.`);
          if (!Array.isArray(o.points) || o.points.length < 2 || o.points.length > 12 || !o.points.every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) throw new NoMate('points is 2 to 12 points [x, y, z] in LDU, the ends first and last.');
          // (LDraw's axes to the workbench's millimetres: -y up becomes y up, and z turns round with it)
          const mm = o.points.map(([x, y, z]) => [x * 0.4, -y * 0.4, -z * 0.4]);
          const name = o.name === undefined ? `flex${flexes.length}` : String(o.name);
          if (here.names.has(name) || flexes.some((f) => f.name === name)) throw new NoMate(`${name} is already a name here.`);
          const part = flexPart(o.kind, colourOf(T, o.color ?? null) ?? k.colour, mm);
          if (!part) throw new NoMate(`Longer than any ${k.name.toLowerCase()} there is (the longest is ${k.stock.at(-1)[1]}L): bring its ends closer or the curve tighter.`);
          flexes.push({ name, part, op: n });
          count++;
          break;
        }
        case 'base': {
          if (n !== 0 || stack.length > 1) throw new Error('base comes first, at the top level.');
          if (Array.isArray(o.parts)) {
            if (o.parts.length > LIMITS.parts) throw new Error('Too many base parts.');
            const removed = new Set(o.removed ?? []);
            o.parts.forEach((p, k) => {
              if (removed.has(p.key)) return;
              count++;
              if (p.fixed) { fixed.push(p); return; }
              const pose = poseOf([{ ldraw: p.pose }]);
              here.names.set(`p${k}`, here.asm.add(p.stem, { pose, color: p.color }));
            });
            break;
          }
          const text = bases[o.revision];
          if (typeof text !== 'string') throw new NoMate(`No revision ${o.revision} to start from.`);
          baseParts(T, text, { strict: true }).forEach((p, k) => { count++; if (p.fixed) fixed.push(p); else here.names.set(`p${k}`, here.asm.add(p.stem, { pose: p.pose, color: p.color })); });
          break;
        }
        default: throw new Error(`Unknown op: add, attach, define, end, mirror, contact${HOSES ? ' or flex' : ' or base'}.`);
      }
      if (count > LIMITS.parts) throw new Error(`A model is at most ${LIMITS.parts} parts.`);
    } catch (e) {
      const err = new Error(`Op ${n} (${o?.op ?? '?'}${o?.name ? ` ${o.name}` : ''}): ${e.message}`);
      err.op = n;
      throw err;
    }
  });
  if (stack.length > 1) throw new Error(`define ${scope().name} has no end.`);
  if (flexes.length && roomForFlex) checkFlexes(flexes, root.asm, fixed, T);
  // A placement by its name at the top level ('beam'), or a part inside a copy of an assembly ('wing/beam'; in a
  // mirrored copy, its twin): { path: the occurrences from the model down to the part, part: its stem }.
  const inside = (occ) => { const source = mirrors.get(occ.what); return [source ?? [...defs.values()].find((d) => d.asm === occ.what), source]; };
  const placed = (name) => {
    const [outer, inner, more] = String(name).split('/');
    if (more !== undefined) throw new NoMate(`${name}: name a part one level into a copy, as copy/inner.`);
    const occ = root.names.get(outer);
    if (!occ) throw new NoMate(`No placement named ${outer} at the top level of the program.`);
    if (inner === undefined) {
      if (!occ.isPart) throw new NoMate(`${outer} is a copy of an assembly: name a part inside it, as ${outer}/<its name in the definition>.`);
      return { path: [occ], part: occ.what };
    }
    if (occ.isPart) throw new NoMate(`${outer} is a part, not a copy of an assembly.`);
    const [def, source] = inside(occ);
    let at = def?.names.get(inner);
    if (!at) throw new NoMate(`${outer} has no part named ${inner}${def?.names.size ? `; its names: ${[...def.names.keys()].slice(0, 30).join(', ')}` : ''}.`);
    if (source) at = occ.what.mirrored.get(at.key);
    if (!at?.isPart) throw new NoMate(`${outer}/${inner} is not a part.`);
    return { path: [occ, at], part: at.what };
  };
  // The program's name for each part ('beam', 'wing/beam'), by its place in parts(model) (`where`).
  const nameOf = new Map();
  for (const [n, occ] of root.names) {
    if (occ.isPart) { nameOf.set(occ.location, n); continue; }
    const [def, source] = inside(occ);
    for (const [inner, at] of def?.names ?? []) {
      const here = source ? occ.what.mirrored.get(at.key) : at;
      if (here?.isPart) nameOf.set(`${occ.location}/${here.location}`, `${n}/${inner}`);
    }
  }
  return { model: root.asm, contacts, names: root.names, fixed, flexes, placed, nameOf };
}

// Each hose against the finished model (lib/flex.mjs flexCheck, as the workbench checks one put in place): the
// parts' boxes in millimetres (LDraw's axes turned to the workbench's), parts kept as they are from a base (a
// person's hose among them), and the other hoses. Throws naming the op.
function checkFlexes(flexes, asm, fixed, T) {
  const boxes = parts(asm).map((p) => { const [lo, hi] = partBox(p, T); return { box: [lo[0] * 0.4, -hi[1] * 0.4, -hi[2] * 0.4, hi[0] * 0.4, -lo[1] * 0.4, -lo[2] * 0.4], label: `${p.stem} at ${p.where}` }; });
  const tubes = flexes.map((f) => ({ points: worldPoints(f.part), radius: FLEX[f.part.flex.kind].radius, label: `flex ${f.name}`, f }));
  for (const q of fixed) {
    if (!q.part) continue;
    const label = `base part ${q.key ?? q.id}`;
    if (q.part.flex) tubes.push({ points: worldPoints(q.part), radius: FLEX[q.part.flex.kind]?.radius ?? 1, label });
    else if (!q.part.origin || q.part.extent) boxes.push({ box: boxMM(q.part), label });
  }
  for (const f of flexes) {
    const r = flexCheck(f.part, boxes, tubes.filter((t) => t.f !== f), { ends: true });
    if (r.ok) continue;
    const why = r.why === 'end'
      ? `its ${r.loose[0] === 1 ? 'last' : 'first'} point is on no part: an end goes on a part's face, within ${FLEX[f.part.flex.kind].radius + 2.5} mm of it (the hose's radius and a stud)`
      : `it passes through ${r.through.slice(0, 3).map((t) => t.label).join(', ')}: move a control point so it runs clear`;
    const err = new Error(`Op ${f.op} (flex ${f.name}): ${why}.`);
    err.op = f.op;
    throw err;
  }
}

// A placed part (LDraw pose) as the workbench's exact part, as lib/studio.mjs fromLDraw places one off the grid:
// this app's axes are LDraw's turned half a turn about x; positions in studs and plates.
// One placement's connectors in the model's frame (LDU), each free or joined and to what, as BrickAgent's
// attachments() and connections() tell an agent where it can build next. A join counts wherever two connectors meet
// by BrickNet's pairing (lib/assembly.mjs connections()), not only where the program attached them. `run`:
// runProgram's result; `name`: 'beam' or 'wing/beam'. → { part, free, joined, connectors: [{ address, kind, at,
// axis, joinedTo? }] }
export function placementConnectors(run, T, name, { type = null, onlyFree = false } = {}) {
  const { path, part } = run.placed(name);
  const flat = parts(run.model), where = path.map((o) => o.location).join('/');
  const k = flat.findIndex((p) => p.where === where);
  const used = new Map();
  for (const [a, ca, b, cb] of connections(run.model, T, flat).edges) {
    if (a === k && !used.has(ca)) used.set(ca, [b, cb]);
    if (b === k && !used.has(cb)) used.set(cb, [a, ca]);
  }
  const label = ([j, i]) => { const c = T.stems.get(flat[j].stem).conns[i]; return `${run.nameOf.get(flat[j].where) ?? flat[j].where}.${c.type}[${c.index}]`; };
  const r1 = (v) => +v.toFixed(2) + 0;
  const all = T.stems.get(part).conns.filter((c) => !type || c.type === type).map((c) => {
    const at = new Connector(path, c.i, T), to = used.get(c.i);
    return { address: `${c.type}[${c.index}]`, kind: c.kind, at: at.at.map(r1), axis: at.axis.map(r1), ...(to ? { joinedTo: label(to) } : {}) };
  });
  const joined = all.filter((c) => c.joinedTo).length;
  return { part, free: all.length - joined, joined, connectors: onlyFree ? all.filter((c) => !c.joinedTo) : all };
}

export function exactPart(T, p, key) {
  const back = T.reverse.get(p.stem);
  const [a, b, c, d, e, f, g, h, k] = p.pose.r, [X, Y, Z] = p.pose.t;
  return { key, id: back?.id ?? p.stem, color: p.color, x: X / 20, y: -Y / 8, z: -Z / 20, w: 1, d: 1, h: 1, rotation: 0, origin: true, ldMatrix: [a, -b, -c, -d, e, f, -g, h, k], studs: false };
}

// Collisions by our parts' collision shapes (lib/hulls.mjs through lib/benchmark.mjs overlaps), as check() wants
// them: [[i, j], …] over parts(shape). `tables`: { hulls, frames, joints }.
export const clashBy = (T, tables) => (flat) => overlaps({ parts: flat.map((p, i) => exactPart(T, p, i)) }, 1000, tables);

// A program run and checked: { ok, issues, parts, components, ldraw, bounds } or, when it does not run, { ok: false,
// error }. `inventory`: lib/benchmark.mjs normaliseInventory's shape. `stability`: false for a work in progress.
export function compile(program, T, { tables = null, inventory = null, stability = true, bases = {}, hoses = HOSES } = {}) {
  let run;
  try { run = runProgram(program, T, { bases, hoses }); } catch (e) { return { ok: false, error: e.message, op: e.op ?? null }; }
  if (run.fixed.length) return { ok: false, error: 'Program check incomplete: base parts lack connector data. Keep the original revision; no subset was saved.' };
  const { model, contacts } = run;
  let issues = [], result = null;
  try { result = check(model, { contacts, clash: tables?.hulls ? clashBy(T, tables) : null, inventory, stability }); }
  catch (e) { if (!e.issues) throw e; issues = e.issues; }
  const flat = result?.parts ?? parts(model);
  return { ok: !issues.length, issues, pieces: flat.length + run.flexes.length, components: result?.components ?? null, ldraw: withFlexes(toLDraw(model), run.flexes), bounds: flat.length ? measure(model) : null, model, flexes: run.flexes };
}

// The hoses in the main file of a program's LDraw, each as the workbench writes one (lib/export.mjs ldrawLine): its
// curve on a meta line, then the stock part at its first point, so reading the file (lib/studio.mjs) gives it back.
function withFlexes(text, flexes) {
  if (!flexes.length) return text;
  const fmt = (v) => String(+v.toFixed(4));
  const lines = flexes.map(({ part: p }) => `0 !NOOKS FLEX ${JSON.stringify({ kind: p.flex.kind, points: p.flex.points })}\n1 ${p.color} ${fmt(p.x * 20)} ${fmt(-p.y * 8)} ${fmt(-p.z * 20)} 1 0 0 0 1 0 0 0 1 ${p.id}.dat`).join('\n');
  const end = text.indexOf('0 NOFILE');
  return end < 0 ? `${text}${lines}\n` : `${text.slice(0, end)}${lines}\n${text.slice(end)}`;
}

// A saved model's parts from its LDraw (submodels followed): [{ stem, color, pose }] in file order, skipping parts the
// runtime has no connector data for. Our part numbers map to BrickNet's stems (an alias's transform applied).
export function baseParts(T, text, { strict = false } = {}) {
  const { files, first } = readFiles(text), out = [];
  const walk = (name, M, inherit, depth) => {
    if (strict && depth > 16) throw new Error('Submodel recursion exceeds 16 levels; no parts were imported.');
    for (const t of files.get(name) ?? []) {
      if (t[0] !== '1' || t.length < 15 || depth > 16) continue;
      const code = Number(t[1]), colour = code === 16 ? inherit : code;
      const [x, y, z, a, b, c, d, e, f, g, h, i] = t.slice(2, 14).map(Number);
      if (strict && ![x,y,z,a,b,c,d,e,f,g,h,i].every(Number.isFinite)) throw new Error('Nonfinite part transform; no parts were imported.');
      const pose = compose(M, { r: [a, b, c, d, e, f, g, h, i], t: [x, y, z] });
      const ref = t.slice(14).join(' ').toLowerCase().replace(/\\/g, '/');
      if (files.has(ref)) { walk(ref, pose, colour, depth + 1); continue; }
      const id = ref.replace(/^.*\//, '').replace(/\.dat$/, ''), mapped = T.ours[id];
      const [stem, m] = !mapped ? [null, null] : Array.isArray(mapped) ? mapped : [mapped, null];
      // (a part BrickNet lacks, or one held back, stays where it is as a fixed part)
      if (!mapped || T.withheld?.has(stem)) { out.push({ id, fixed: true, color: colour, pose }); continue; }
      out.push({ stem, color: colour, pose: m ? compose(pose, { r: m.slice(3, 12), t: m.slice(0, 3) }) : pose });
    }
  };
  walk(first, ID, 16, 0);
  return out;
}
