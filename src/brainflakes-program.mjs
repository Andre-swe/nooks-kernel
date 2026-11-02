// Brain Flakes build programs and checker. A program is plain JSON data that
// names discs, gives their catalogue colours and joins slot to slot with a
// pose choice. It is checked and run as data; nothing in it is executed.
//
//   { system: 'brainflakes-standard', name: 'flower', set: 'jar-500', ops: [
//     { op: 'disc',    name: 'centre', color: 'yellow' },
//     { op: 'attach',  name: 'petal1', color: 'pink', to: 'centre.slot[0]', by: 0, pose: 0 },
//     { op: 'ring',    prefix: 'p', color: 'pink', to: 'centre', slots: [1,2,3], by: 0, pose: 1 },
//     { op: 'connect', a: 'petal1.slot[2]', b: 'p1.slot[6]' },
//     { op: 'close' },
//   ] }
//
// Ops:
//   disc    { name, color?, at?: [x,y,z] mm, spin?: [[axis, degrees], ...] }  a free disc
//   attach  { name, color?, to: 'disc.slot[i]', by?: slot of the new disc (0), pose?: 0|1 }
//           pose picks one of the legal mating poses (MATING_ROLLS: both flips)
//   ring    { prefix, color?, to: 'disc', slots: [i...], by?, pose? }  one attach per slot,
//           named prefix1, prefix2, ...
//   connect { a: 'disc.slot[i]', b: 'disc.slot[j]' }  a join whose slots already line up
//   close   {}  connect every pair of free slots that already line up (closes loops)
// Refs: 'name.slot[3]' or 'name:3'. Colours: catalogue ids (lib/brainflakes-colors.mjs).
// Units: millimetres in the disc's native axes.
import { ID, compose, spin, apply, inverse, mul3, rot } from './pose.mjs';
import { SYSTEM, MAX_DISCS, MATING_ROLLS, createAssembly, addDisc, attachDisc, attachmentPose, connectDiscs, closeLoops, removeDisc, recolorDisc, transformDisc, validateAssembly, slotFrame, isRigidPose } from './brainflakes.mjs';
import { DISC_COLORS, STANDARD_SETS } from './brainflakes-colors.mjs';
import { nearbyDiscPairs } from './brainflakes-spatial.mjs';

export const PROGRAM_LIMITS = Object.freeze({ ops: MAX_DISCS * 5, discs: MAX_DISCS });
const NAME = /^[A-Za-z][\w-]{0,39}$/;

const unitVector = (v, what) => {
  const l = Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? Math.hypot(...v) : 0;
  if (!(l > 0)) throw new Error(`${what} is a direction [x, y, z], e.g. [0, 0, 1] for up.`);
  return v.map(x => x / l);
};

// `toward` picks the free slot of `to` (a disc name) whose outward direction
// is nearest the given world direction, within 22.5° (slots are 45° apart).
function towardSlot(model, def, op) {
  if (typeof op.to !== 'string' || !NAME.test(op.to) || op.slot !== undefined) throw new Error('With toward, "to" is a disc name only, e.g. "body".');
  const want = unitVector(op.toward, 'toward'), d = model.discs.find(x => x.id === op.to);
  if (!d) throw new Error(`Unknown disc ${op.to}.`);
  const used = new Set(model.connections.flatMap(e => [e.a.id === op.to ? e.a.slot : null, e.b.id === op.to ? e.b.slot : null]).filter(x => x !== null));
  let best = null;
  for (let slot = 0; slot < 8; slot++) {
    const f = compose(d.pose, slotFrame(def, slot)), out = [f.r[0], f.r[3], f.r[6]];
    const score = out[0] * want[0] + out[1] * want[1] + out[2] * want[2];
    if (!best || score > best.score) best = { slot, score, free: !used.has(slot) };
  }
  if (best.score < Math.cos(Math.PI / 8)) throw new Error(`No slot of ${op.to} points within 22.5° of toward; its slots lie in its own plane.`);
  if (!best.free) throw new Error(`The slot of ${op.to} that points that way (slot ${best.slot}) is occupied.`);
  return { id: op.to, slot: best.slot };
}

// `facing` picks the mating pose whose new-disc normal is nearest that
// direction (either side counts: a disc looks the same from both faces).
function facingPose(model, def, op, to, by) {
  const want = unitVector(op.facing, 'facing'), parent = model.discs.find(x => x.id === to.id);
  const scores = [0, 1].map(mate => {
    const p = attachmentPose(def, parent.pose, to.slot, by, mate);
    return Math.abs(p.r[2] * want[0] + p.r[5] * want[1] + p.r[8] * want[2]);
  });
  if (Math.max(...scores) < 0.9) throw new Error('Neither pose of that disc faces that way; an attached disc always contains the joint direction.');
  return scores[1] > scores[0] + 1e-9 ? 1 : 0;
}

export function parseRef(ref, fallbackSlot = null) {
  if (typeof ref === 'string' && fallbackSlot !== null && NAME.test(ref)) {
    if (!Number.isInteger(fallbackSlot) || fallbackSlot < 0 || fallbackSlot > 7) throw new Error('slot must be 0 to 7.');
    return { id: ref, slot: fallbackSlot };
  }
  const m = typeof ref === 'string' && (ref.match(/^([A-Za-z][\w-]{0,39})\.slot\[(\d)\]$/) || ref.match(/^([A-Za-z][\w-]{0,39})[.:](\d)$/));
  if (!m || Number(m[2]) > 7) throw new Error(`"${ref}" is not a slot ref; write "name.slot[0]" to "name.slot[7]".`);
  return { id: m[1], slot: Number(m[2]) };
}
function freePose(op) {
  if (op.transform !== undefined) {
    if (!isRigidPose(op.transform) || op.transform.t.some(v => Math.abs(v) >= 1000000)) throw new Error('transform must be a rigid pose {"r":[9 numbers, row-major 3x3 rotation],"t":[x,y,z] mm} within 1000000 mm, e.g. {"r":[1,0,0,0,0,-1,0,1,0],"t":[0,0,20]}. For simple turns use at:[x,y,z] with spin:[["x",90]].');
    return { r: [...op.transform.r], t: [...op.transform.t] };
  }
  let p = ID;
  if (op.spin !== undefined) {
    if (!Array.isArray(op.spin) || op.spin.length > 4) throw new Error('spin is a list of [axis, degrees] steps.');
    for (const s of op.spin) {
      const [axis, deg] = s || [];
      const ax = axis === 'x' ? [1,0,0] : axis === 'y' ? [0,1,0] : axis === 'z' ? [0,0,1] : axis;
      if (!Array.isArray(ax) || ax.length !== 3 || !ax.every(Number.isFinite) || !Number.isFinite(deg)) throw new Error('spin steps are [axis, degrees], axis "x", "y", "z" or [x,y,z].');
      p = compose(p, spin(ax, deg));
    }
  }
  if (op.at !== undefined) {
    if (!Array.isArray(op.at) || op.at.length !== 3 || !op.at.every(v => Number.isFinite(v) && Math.abs(v) < 1000000)) throw new Error('at is [x, y, z] in millimetres within 1000000 mm.');
    p = { r: p.r, t: [...op.at] };
  }
  return p;
}

// Run a program. Returns { model, errors, log }: ops that fail are reported
// with their index and skipped, so an agent sees every problem in one pass.
export function runBrainflakesProgram(program, defOrOpts, maybeOpts = {}) {
  const def = defOrOpts?.system === SYSTEM ? defOrOpts : defOrOpts?.def;
  const opts = defOrOpts?.system === SYSTEM ? maybeOpts : (defOrOpts ?? {});
  const maxDiscs = Math.min(opts.maxDiscs ?? PROGRAM_LIMITS.discs, PROGRAM_LIMITS.discs);
  const depth = opts.definitionDepth ?? 0;
  const budget = opts.budget ?? { remaining:80000 };
  if (depth > 3) throw new Error('At most three levels of nested definitions.');
  const ops = program?.ops ?? program?.steps;
  if (!program || typeof program !== 'object' || !Array.isArray(ops)) throw new Error('A Brain Flakes program is { name, ops: [...] }.');
  if (program.system !== undefined && program.system !== SYSTEM) throw new Error(`This program is for "${program.system}", not Brain Flakes.`);
  if (ops.length > PROGRAM_LIMITS.ops) throw new Error(`At most ${PROGRAM_LIMITS.ops} ops.`);
  budget.remaining -= ops.length;
  if (budget.remaining < 0) throw new Error('Nested program operation limit exceeded.');
  const model = createAssembly(typeof program.name === 'string' && program.name.trim() ? program.name.trim().slice(0, 80) : 'Brain Flakes design');
  if (program.set && Object.hasOwn(STANDARD_SETS, program.set)) model.set = program.set;
  if (program.inventory !== undefined) {
    if (!program.inventory || typeof program.inventory !== 'object' || Array.isArray(program.inventory) || Object.entries(program.inventory).some(([c,n])=>!Object.hasOwn(DISC_COLORS,c)||!Number.isInteger(n)||n<0)) throw new Error('Brain Flakes inventory must map catalogue colors to non-negative counts.');
    model.inventory={...program.inventory};
  }
  const errors = [], log = [], definitions = new Map(), occurrences = Object.create(null), notCreated = new Map();
  const color = (c) => { if (c === undefined) return 'yellow'; if (!Object.hasOwn(DISC_COLORS, c)) throw new Error(`"${c}" is not a Brain Flakes colour; use one of ${Object.keys(DISC_COLORS).join(', ')}.`); return c; };
  const poseIdx = (p) => { const i = p ?? 0; if (!Number.isInteger(i) || i < 0 || i >= MATING_ROLLS.length) throw new Error(`pose is 0 to ${MATING_ROLLS.length - 1} (the legal flips).`); return i; };
  const room = () => { if (model.discs.length >= maxDiscs) throw new Error(`Over the ${maxDiscs}-disc limit.`); };
  const name = (n) => { if (typeof n !== 'string' || !NAME.test(n)) throw new Error(`"${n}" is not a disc name (letter first, up to 40 letters, digits, - or _).`); return n; };
  ops.forEach((op, i) => {
    // Append-only operations can roll back by truncation. Avoid copying the
    // entire growing assembly for each part in a large program.
    const appendOnly = ['disc','attach','ring','connect','close','define','instance'].includes(op?.op);
    const before = appendOnly
      ? { discs:model.discs.length, connections:model.connections.length, validation:model.validation }
      : { discs:structuredClone(model.discs), connections:structuredClone(model.connections), validation:structuredClone(model.validation) };
    try {
      const discName = op?.name ?? op?.id;
      switch (op?.op) {
        case 'disc': {
          room(); const d=addDisc(model, { id: name(discName), color: color(op.color), pose: freePose(op) });
          if(op.group!==undefined) { if(typeof op.group!=='string'||!op.group||op.group.length>80) throw new Error('group must be a non-empty string up to 80 characters.'); d.group=op.group; }
          break;
        }
        case 'attach': {
          room(); const by = op.by ?? 0;
          if (!Number.isInteger(by) || by < 0 || by > 7) throw new Error('by is the new disc\'s slot, 0 to 7.');
          const to = op.toward !== undefined ? towardSlot(model, def, op) : parseRef(op.to, op.slot ?? null);
          let mate = poseIdx(op.pose ?? op.mate);
          if (op.facing !== undefined) mate = facingPose(model, def, op, to, by);
          attachDisc(model, def, { id: name(discName), color: color(op.color), to: to.id, slot: to.slot, by, mate }); break;
        }
        case 'ring': {
          if (!Array.isArray(op.slots) || !op.slots.length || op.slots.length > 8) throw new Error('slots is a list of up to eight target slots.');
          const prefix = name(op.prefix ?? discName ?? 'p'), by = op.by ?? 0;
          op.slots.forEach((s, k) => { room(); attachDisc(model, def, { id: `${prefix}${k + 1}`, color: color(Array.isArray(op.colors) ? op.colors[k % op.colors.length] : op.color), to: name(op.to), slot: s, by, mate: poseIdx(op.pose ?? op.mate) }); });
          break;
        }
        case 'connect': connectDiscs(model, def, parseRef(op.a ?? op.from), parseRef(op.b ?? op.to)); break;
        case 'close': {
          const start=model.connections.length;
          const closed=closeLoops(model,def,model.discs.map(d=>d.id));
          log.push({op:i,closed,...(opts.captureClosures?{connections:structuredClone(model.connections.slice(start))}:{})});
          break;
        }
        case 'remove': {
          const id=name(discName);
          removeDisc(model,id);
          // An occurrence tracks identities, not name prefixes. A later disc
          // with the same ID is a replacement and must not become a member.
          for(const occurrence of Object.values(occurrences))
            occurrence.parts=occurrence.parts.filter(part=>part!==id);
          break;
        }
        case 'recolor': recolorDisc(model, name(discName), color(op.color)); break;
        case 'set_group': {
          const d=model.discs.find(d=>d.id===name(discName));
          if(!d) throw new Error('Unknown disc.');
          if(op.group===null) delete d.group;
          else { if(typeof op.group!=='string'||!op.group||op.group.length>80) throw new Error('group must be a non-empty string up to 80 characters or null.'); d.group=op.group; }
          break;
        }
        case 'disconnect': {
          const a=parseRef(op.a ?? op.from),b=parseRef(op.b ?? op.to), same=(x,y)=>x.id===y.id&&x.slot===y.slot;
          const index=model.connections.findIndex(e=>(same(e.a,a)&&same(e.b,b))||(same(e.a,b)&&same(e.b,a)));
          if(index<0) throw new Error('No such connection.');
          model.connections.splice(index,1);
          break;
        }
        case 'transform': {
          const id=name(discName), disc=model.discs.find(d=>d.id===id);
          if(!disc) throw new Error(`Unknown disc ${id}.`);
          transformDisc(model,id,freePose(op));
          if(!validateAssembly(model,def).geometry.constraintsConsistent) throw new Error('Transform would break a connection; disconnect it first.');
          break;
        }
        case 'transform_instance': {
          const key=name(discName), occurrence=occurrences[key];
          if(!occurrence) throw new Error(`Unknown instance ${key}.`);
          if(!occurrence.parts.length) throw new Error(`Instance ${key} has no remaining discs.`);
          const delta=freePose(op);
          for(const id of occurrence.parts) {
            const disc=model.discs.find(d=>d.id===id);
            if(!disc) throw new Error(`Instance ${key} has a removed disc.`);
            transformDisc(model,id,compose(delta,disc.pose));
          }
          if(!validateAssembly(model,def).geometry.constraintsConsistent) throw new Error('Transform would break an external connection; disconnect it first.');
          occurrence.frame=compose(delta,occurrence.frame);
          break;
        }
        case 'define': {
          const key = name(discName);
          if (definitions.has(key)) throw new Error(`Definition ${key} already exists.`);
          const run = runBrainflakesProgram({ops:op.ops}, def, {maxDiscs, definitionDepth:depth+1, budget});
          if (run.errors.length || !run.model.discs.length || !run.model.validation.graph.valid || !run.model.validation.geometry.constraintsConsistent) throw new Error(`Invalid definition ${key}: ${run.errors.map(e=>e.error).join('; ') || 'must be one consistent connected assembly'}`);
          definitions.set(key, run.model);
          break;
        }
        case 'instance': {
          const key = name(discName); let template = definitions.get(name(op.of));
          if (!template) throw new Error(`Unknown definition ${op.of}.`);
          const remapSlot = s => op.mirror ? (4-s+8)%8 : s;
          if (op.mirror) {
            const axis=['x','y','z'].indexOf(op.mirror);
            if(axis<0) throw new Error('mirror must be x, y or z.');
            const world=[1,0,0,0,1,0,0,0,1], local=[-1,0,0,0,1,0,0,0,1]; world[axis*3+axis]=-1;
            template={...template,discs:template.discs.map(d=>({...d,pose:{r:mul3(world,mul3(d.pose.r,local)),t:rot(world,d.pose.t)}})),connections:template.connections.map(e=>({a:{id:e.a.id,slot:remapSlot(e.a.slot)},b:{id:e.b.id,slot:remapSlot(e.b.slot)}}))};
          }
          if (model.discs.length + template.discs.length > maxDiscs) throw new Error(`Over the ${maxDiscs}-disc limit.`);
          const ids = new Map(template.discs.map(d=>[d.id, name(`${key}-${d.id}`)]));
          if ([...ids.values()].some(id=>model.discs.some(d=>d.id===id))) throw new Error(`Instance ${key} overlaps an existing name.`);
          let frame = freePose(op), target = null, source = null;
          if (op.to !== undefined) {
            if (op.at !== undefined || op.spin !== undefined || op.transform !== undefined) throw new Error('An attached instance cannot also have a free transform.');
            target = parseRef(op.to); source = parseRef(op.by); source.slot = remapSlot(source.slot);
            const parent = model.discs.find(d=>d.id===target.id), child = template.discs.find(d=>d.id===source.id);
            if (!parent || !child) throw new Error('Unknown target or definition connector.');
            frame = compose(attachmentPose(def,parent.pose,target.slot,source.slot,poseIdx(op.pose)),inverse(child.pose));
          }
          // Build in isolation: an occupied slot or invalid contact cannot partially mutate the model.
          const candidate = structuredClone(model);
          for (const d of template.discs) {
            const part = addDisc(candidate,{id:ids.get(d.id),color:d.color,pose:compose(frame,d.pose)});
            if (d.group !== undefined) part.group = d.group;
          }
          for (const e of template.connections) connectDiscs(candidate,def,{id:ids.get(e.a.id),slot:e.a.slot},{id:ids.get(e.b.id),slot:e.b.slot});
          if (target) connectDiscs(candidate,def,target,{id:ids.get(source.id),slot:source.slot});
          model.discs = candidate.discs; model.connections = candidate.connections;
          occurrences[key] = { definition:op.of, parts:[...ids.values()], frame, ...(op.mirror ? {mirror:op.mirror,assumption:'disc mesh reflection symmetry; verify mesh collisions'} : {}) };
          break;
        }
        default: throw new Error(`Unknown op "${op?.op}"; use disc, attach, ring, connect or close.`);
      }
    } catch (e) { if(appendOnly) { model.discs.length=before.discs; model.connections.length=before.connections; } else { model.discs=before.discs; model.connections=before.connections; } model.validation=before.validation; // A disc a failed op would have created is missing for every later op
      // that names it. Point those back to the first failure instead of
      // repeating an unexplained "unknown disc" for each of them.
      const missing=/^Unknown disc:? ([^.s]+).?$/.exec(e.message)?.[1], cause=missing && notCreated.get(missing);
      const message=cause!==undefined ? `Skipped: ${missing} does not exist because op ${cause} failed.` : e.message;
      for(const id of [op?.name, ...(op?.op==='ring' && Array.isArray(op.slots) ? op.slots.map((_,k)=>`${op.prefix ?? op.name ?? 'p'}${k+1}`) : [])]) if(typeof id==='string' && !notCreated.has(id)) notCreated.set(id,cause ?? i);
      errors.push({ op: i, error: message, message, ...(cause!==undefined ? {dependsOnOp:cause} : {}) }); }
  });
  model.provenance = { ...model.provenance, source: 'build-program', program: { ops: ops.length, evidence: 'ai-inference' }, agent: { evidence: 'ai-inference', tool: 'nooks-brainflakes', version: 1 } };
  model.validation = validateAssembly(model, def, { set: model.set ?? null });
  return { ok: errors.length === 0, model, errors, log, occurrences };
}

// ---- Checker ---------------------------------------------------------------
// An approximate solid for unconnected pairs: the disc's slab, inside its
// outer envelope, minus its centre hole and its eight slots. Used where the
// mesh check is not available (agents, the server). Geometric only.
function envelope(def) {
  const m = def.measurements;
  return { half: (m?.thickness ?? 2.5) / 2, rim: 15.6, hole: 3.9, slotHalf: 1.2, root: def.slotRadius };
}
function insideSolid(local, env, def) {
  const [x, y, z] = local, r = Math.hypot(x, y);
  if (Math.abs(z - (def.midplane ?? 0)) > env.half - 0.05 || r > env.rim || r < env.hole) return false;
  const k = Math.round(Math.atan2(y, x) / (Math.PI / 4)), a = k * Math.PI / 4;
  const along = x * Math.cos(a) + y * Math.sin(a), across = -x * Math.sin(a) + y * Math.cos(a);
  return !(along > env.root - 0.05 && Math.abs(across) < env.slotHalf);
}
let SAMPLES = null;
function samples(def, env) {
  if (SAMPLES?.def === def) return SAMPLES.pts;
  const pts = [];
  for (let r = env.hole + 0.6; r <= env.rim - 0.3; r += 1.4) for (let k = 0; k < 40; k++) for (const dz of [-env.half + 0.25, 0, env.half - 0.25]) {
    const a = k * Math.PI / 20, p = [r * Math.cos(a), r * Math.sin(a), (def.midplane ?? 0) + dz];
    if (insideSolid(p, env, def)) pts.push(p);
  }
  SAMPLES = { def, pts }; return pts;
}
// Unconnected discs whose approximate solids overlap. Pure.
export function approximateCollisions(model, def, { only = null, limit = 200 } = {}) {
  const env = envelope(def), pts = samples(def, env), out = [], connected = new Set(model.connections.map(e => [e.a.id, e.b.id].sort().join('\u0000')));
  const list = model.discs;
  for (const [i,j] of nearbyDiscPairs(list, 2 * env.rim + 0.5)) {
    if (out.length >= limit) break;
    const A = list[i], B = list[j];
    if (only && !only.has(A.id) && !only.has(B.id)) continue;
    if (connected.has([A.id, B.id].sort().join('\u0000'))) continue;
    const toA = compose(inverse(A.pose), B.pose);
    let hits = 0; for (const p of pts) if (insideSolid(apply(toA, p), env, def) && ++hits >= 3) break;
    if (hits >= 3) out.push({ a: A.id, b: B.id, kind: 'overlap', method: 'approximate-envelope' });
  }
  return out;
}

// Lowest world z of each disc, treating it as a cylinder of the mesh's
// radius and thickness. Within GROUND_TOL of the lowest disc counts as resting
// on the ground (edge-on discs sit on flats, not on the circumscribed circle).
const GROUND_TOL = 1.5;
function lowestPoints(model, def) {
  const b = def?.measurements?.bounds, out = new Map();
  const radius = b ? Math.max(...[0, 1].map(i => Math.max(Math.abs(b.min[i]), Math.abs(b.max[i])))) : 0, z0 = b?.min[2] ?? 0, z1 = b?.max[2] ?? 0;
  for (const d of model.discs) { const r = d.pose.r; out.set(d.id, d.pose.t[2] + Math.min(r[8] * z0, r[8] * z1) - radius * Math.hypot(r[6], r[7])); }
  return out;
}

// Findings in the brick checker's shape (lib/check.mjs liveCheck):
// { inexact, collisions, floating, over, absent, count }. `collisions` may be
// supplied from the mesh check (brainflakes-validation.mjs); otherwise the
// approximate envelope is used and the result says so.
export function checkBrainflakes(model, defOrOpts, maybeOpts = {}) {
  const hasDef = defOrOpts?.system === SYSTEM;
  const def = hasDef ? defOrOpts : defOrOpts?.def;
  const opts = hasDef ? maybeOpts : (defOrOpts ?? {});
  const set = opts.set ?? opts.setId ?? null, inventory = opts.inventory ?? null, maxParts = opts.maxParts ?? Infinity, collisions = opts.collisions ?? null;
  const v = validateAssembly(model, def, { maxParts });
  const inexact = v.geometry.errors.filter(e => e.code === 'inconsistent-connection').map(e => ({ a: e.a, b: e.b, keys: [e.a.id, e.b.id], kind: 'slots-do-not-line-up' }));
  const col = (collisions ?? approximateCollisions(model, def)).map(c => ({ ...c, keys: c.keys ?? [c.a, c.b].filter(Boolean) }));
  // Floating: discs held by nothing. Loose parts are allowed when they rest on
  // the ground or on other discs (`contacts`, from the mesh check); without
  // contacts, only the largest group and groups on the ground count as held.
  const contacts = opts.contacts ?? [];
  const adj = new Map(model.discs.map(d => [d.id, []]));
  for (const e of [...model.connections.map(e => [e.a.id, e.b.id]), ...contacts.map(c => [c.a, c.b])]) if (adj.has(e[0]) && adj.has(e[1])) { adj.get(e[0]).push(e[1]); adj.get(e[1]).push(e[0]); }
  const seen = new Set(), groups = [];
  for (const id of adj.keys()) if (!seen.has(id)) { const g = [id]; seen.add(id); for (let k = 0; k < g.length; k++) for (const n of adj.get(g[k])) if (!seen.has(n)) { seen.add(n); g.push(n); } groups.push(g); }
  groups.sort((a, b) => b.length - a.length);
  const low = lowestPoints(model, def), ground = Math.min(...low.values());
  const floating = groups.slice(1).filter(g => !g.some(id => low.get(id) <= ground + GROUND_TOL)).flat();
  const graphHolds = v.graph.errors.every(e => e.code === 'disconnected') && floating.length === 0;
  const inv = inventory ?? (set ? STANDARD_SETS[set]?.inventory : null);
  if(inv !== null && (!inv || typeof inv !== 'object' || Array.isArray(inv) || Object.entries(inv).some(([c,n])=>!Object.hasOwn(DISC_COLORS,c)||!Number.isInteger(n)||n<0))) throw new Error('Brain Flakes inventory must map catalogue colors to non-negative counts.');
  const counts = {}; for (const d of model.discs) counts[d.color] = (counts[d.color] || 0) + 1;
  const over = inv ? Object.entries(counts).filter(([c, n]) => n > (inv[c] ?? 0)).map(([color, n]) => ({ color, need: n, have: inv[color] ?? 0, used: n, limit: inv[color] ?? 0, keys: model.discs.filter(d => d.color === color).map(d => d.id) })) : [];
  const absent = inv ? Object.keys(counts).filter(c => !(c in inv)).map(color => ({ color, keys: model.discs.filter(d => d.color === color).map(d => d.id) })) : [];
  const partLimit = model.discs.length > maxParts ? [{ code: 'part-limit', discs: model.discs.length, max: maxParts }] : [];
  return {
    system: SYSTEM, inexact, collisions: col, floating, over: [...over, ...partLimit], absent,
    count: inexact.length + col.length + floating.length + over.length + absent.length + partLimit.length,
    discs: model.discs.length, connections: model.connections.length, colors: counts,
    collisionMethod: collisions ? 'mesh' : 'approximate-envelope',
    inventoryEvidence: inventory ? 'caller-supplied' : set ? STANDARD_SETS[set]?.inventoryBasis ?? 'unknown' : 'not-specified',
    physical: 'unverified: press-fit is a geometric finding; retention is not simulated',
    validation: { ...v, valid: graphHolds && v.geometry.constraintsConsistent && col.length === 0, graphHolds, components: v.graph.components, floating },
  };
}

// A short text summary for agents, mirroring the brick tools' wording.
export function describeCheck(c) {
  if (!c.count) return `${c.discs} discs, ${c.connections} connections. No findings (${c.collisionMethod} collision check). Fit is geometric; holding strength is not simulated.`;
  const parts = [];
  if (c.collisions.length) parts.push(`${c.collisions.length} collision${c.collisions.length > 1 ? 's' : ''}: ${c.collisions.slice(0, 6).map(x => `${x.a}/${x.b}`).join(', ')}`);
  if (c.inexact.length) parts.push(`${c.inexact.length} join${c.inexact.length > 1 ? 's' : ''} whose slots do not line up`);
  if (c.floating.length) parts.push(`${c.floating.length} disc${c.floating.length > 1 ? 's' : ''} not connected to the main build: ${c.floating.slice(0, 8).join(', ')}`);
  for (const o of c.over) parts.push(o.code ? `${o.discs} discs over the ${o.max} limit` : `needs ${o.need} ${o.color}, the set has ${o.have}`);
  for (const a of c.absent) parts.push(`${a.color} is not in the set`);
  return `${c.discs} discs, ${c.connections} connections. ${parts.join('; ')}.`;
}

//Slot positions in world space, for agents planning joins.
export function slotWorld(model, def, id, slot) {
  const d = model.discs.find(x => x.id === id); if (!d) throw new Error(`Unknown disc ${id}`);
  const f = compose(d.pose, slotFrame(def, slot)); return { at: f.t, outward: [f.r[0], f.r[3], f.r[6]] };
}

// Convert any existing Brain Flakes model into a declarative build program.
export function modelToBrainflakesProgram(model) {
  const ops = [];
  if (!model?.discs?.length) return { system: SYSTEM, name: model?.name ?? 'Brain Flakes design', ops };
  // Exact transforms preserve rotated roots, disconnected components and either
  // traversal direction through a cycle. Connections are reconstructed after placement.
  for (const d of model.discs) ops.push({ op: 'disc', name: d.id, color: d.color, transform: { r: [...d.pose.r], t: [...d.pose.t] }, ...(d.group ? {group:d.group} : {}) });
  for (const e of model.connections) {
    ops.push({ op: 'connect', a: `${e.a.id}.slot[${e.a.slot}]`, b: `${e.b.id}.slot[${e.b.slot}]` });
  }
  return { system: SYSTEM, name: model.name || 'Brain Flakes design', ...(model.set ? { set: model.set } : {}), ...(model.inventory ? {inventory:{...model.inventory}} : {}), ops };
}

// Declarative joins encode only endpoint IDs/slots and the inferred mate.
// Do not claim an exact program replay for extra saved edge metadata.
export function hasUnsupportedBrainflakesConnectionMetadata(model) {
  return (model?.connections ?? []).some(e=>
    Object.keys(e).some(k=>!['a','b','mate'].includes(k)) ||
    ['a','b'].some(k=>!e[k] || Object.keys(e[k]).some(field=>!['id','slot'].includes(field))));
}

// Preserve authored program history and definitions while recording a human's
// workbench edit as minimal override operations. Return null when the edited
// assembly cannot be replayed exactly.
export function preserveBrainflakesProgram(program, previous, edited, def) {
  const sourceOps=program?.ops ?? program?.steps;
  if (!sourceOps?.length || !previous?.discs || !edited?.discs) return null;
  // The program format cannot represent arbitrary per-disc metadata. Do not
  // claim an exact replay when an editor added unsupported properties.
  if(edited.discs.some(d=>Object.keys(d).some(k=>!['id','color','pose','key','group'].includes(k)) || (d.key!==undefined && d.key!==d.id))) return null;
  if(hasUnsupportedBrainflakesConnectionMetadata(edited)) return null;
  const oldById=new Map(previous.discs.map(d=>[d.id,d])), newById=new Map(edited.discs.map(d=>[d.id,d]));
  const poseSame=(a,b)=>a&&b&&a.r.every((v,i)=>Math.abs(v-b.r[i])<=1e-6)&&a.t.every((v,i)=>Math.abs(v-b.t[i])<=1e-6);
  const poseExact=(a,b)=>a&&b&&a.r.every((v,i)=>v===b.r[i])&&a.t.every((v,i)=>v===b.t[i]);
  const edgeKey=e=>[`${e.a.id}:${e.a.slot}`,`${e.b.id}:${e.b.slot}`].sort().join('|');
  const oldEdges=new Map(previous.connections.map(e=>[edgeKey(e),e]));
  const newEdges=new Map(edited.connections.map(e=>[edgeKey(e),e]));

  // See whether any whole instances were rigidly transformed as a unit.
  let baseRun=null;
  try { baseRun=runBrainflakesProgram(program,def); } catch { return null; }
  if(baseRun.errors.length) return null;

  const movedDiscs=new Set();
  for(const d of edited.discs) {
    const old=oldById.get(d.id);
    if(old && !poseExact(old.pose,d.pose)) movedDiscs.add(d.id);
  }

  const instanceMoves=[];
  const instanceMovedDiscs=new Set();
  const instanceMoveByPart=new Map();
  for(const [instName,occ] of Object.entries(baseRun.occurrences ?? {})) {
    // Removals are emitted before the occurrence transform below. Detect a
    // rigid move among the surviving members so the occurrence's local frame
    // follows them instead of remaining at its old position.
    const parts=(occ.parts ?? []).filter(id=>newById.has(id));
    if(!parts.length || parts.some(id=>!oldById.has(id)||!movedDiscs.has(id))) continue;
    const firstOld=oldById.get(parts[0]).pose, firstNew=newById.get(parts[0]).pose;
    const delta=compose(firstNew,inverse(firstOld));
    if(parts.every(id=>poseSame(compose(delta,oldById.get(id).pose),newById.get(id).pose))) {
      const move={name:instName,transform:delta,parts:new Set(parts)};
      instanceMoves.push(move);
      parts.forEach(id=>{instanceMovedDiscs.add(id);instanceMoveByPart.set(id,move);});
    }
  }

  // Connections to disconnect before transforms/removals:
  // 1) Any connection removed by the human edit.
  // 2) Any connection touching a moved disc (unless both endpoints belong to the same rigidly moved instance and the connection still exists).
  const toDisconnect=new Map();
  const sameMovedInstance=(a,b)=>instanceMoveByPart.has(a) && instanceMoveByPart.get(a)===instanceMoveByPart.get(b);
  for(const [k,e] of oldEdges) {
    if(!newById.has(e.a.id) || !newById.has(e.b.id)) continue; // removeDisc already drops incident connections
    const kept=newEdges.has(k);
    const touchesMove=(movedDiscs.has(e.a.id)||movedDiscs.has(e.b.id)) && !(kept && sameMovedInstance(e.a.id,e.b.id));
    if(!kept || touchesMove) toDisconnect.set(k,e);
  }

  const ops=[...sourceOps];
  for(const e of toDisconnect.values()) ops.push({op:'disconnect',a:`${e.a.id}.slot[${e.a.slot}]`,b:`${e.b.id}.slot[${e.b.slot}]`});
  for(const d of previous.discs) if(!newById.has(d.id)) ops.push({op:'remove',name:d.id});
  for(const m of instanceMoves) ops.push({op:'transform_instance',name:m.name,transform:m.transform});
  for(const d of edited.discs) {
    const old=oldById.get(d.id);
    if(!old) ops.push({op:'disc',name:d.id,color:d.color,transform:d.pose,...(d.group?{group:d.group}:{})});
    else {
      const instanceMove=instanceMoveByPart.get(d.id);
      // Matrix inversion and composition can introduce tiny rounding changes.
      // Preserve the shared occurrence move, then write the exact intended
      // pose only for members whose reconstructed coordinates differ.
      if(movedDiscs.has(d.id) && (!instanceMovedDiscs.has(d.id) ||
          (instanceMove && !poseExact(compose(instanceMove.transform,old.pose),d.pose))))
        ops.push({op:'transform',name:d.id,transform:d.pose});
      if(old.color!==d.color) ops.push({op:'recolor',name:d.id,color:d.color});
      if((old.group??null)!==(d.group??null)) ops.push({op:'set_group',name:d.id,group:d.group??null});
    }
  }
  for(const [k,e] of newEdges) {
    if(!oldEdges.has(k) || toDisconnect.has(k)) ops.push({op:'connect',a:`${e.a.id}.slot[${e.a.slot}]`,b:`${e.b.id}.slot[${e.b.slot}]`});
  }
  const next={...program,name:edited.name, ...(edited.inventory ? {inventory:edited.inventory} : {}), ops};
  delete next.steps;
  if(!edited.inventory) delete next.inventory;
  if(edited.set) next.set=edited.set; else delete next.set;
  try {
    const run=runBrainflakesProgram(next,def);
    if(run.errors.length || run.model.discs.length!==edited.discs.length || run.model.connections.length!==edited.connections.length) return null;
    const runById=new Map(run.model.discs.map(d=>[d.id,d]));
    for(const d of edited.discs) {
      const r=runById.get(d.id);
      if(!r || r.color!==d.color || (r.group??null)!==(d.group??null) || !poseExact(r.pose,d.pose)) return null;
    }
    const edges=a=>a.map(e=>`${[`${e.a.id}:${e.a.slot}`,`${e.b.id}:${e.b.slot}`].sort().join('|')}:${e.mate ?? ''}`).sort();
    if(JSON.stringify(edges(run.model.connections))!==JSON.stringify(edges(edited.connections))) return null;
    return next;
  } catch { return null; }
}
