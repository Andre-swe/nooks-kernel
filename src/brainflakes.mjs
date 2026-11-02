// Experimental standard-disc assembly graph. Poses use pose.mjs's row-major
// convention, but translations here are millimetres in the STL's native axes.
// A connector pose is a geometric hypothesis, not evidence of snap-fit.
import { ID, compose, inverse, near, spin } from './pose.mjs';
import { measureDisc, radialProfile } from './brainflakes-mesh.mjs';
import { DISC_COLORS } from './brainflakes-colors.mjs';

export const SYSTEM = 'brainflakes-standard';
export const MAX_DISCS = 5000;
// Mesh collision statuses with no unintended contact: designed press-fits,
// discs resting on or touching one another, or nothing touching at all.
export const ACCEPTED_COLLISION = Object.freeze(['press-fit-only', 'surface-contact-only', 'no-intersection-detected']);
export const MAX_CONNECTIONS = MAX_DISCS * 4; // eight slots per disc, two ends per connection
export const STANDARD_STL_SHA256 = '58e1372038646b630fc1c4530720cc44a8c5b0f468353464d7f6dc51ee74055e';
// Display-only simplification derived from the attributed canonical STL.
export const DISPLAY_STL_SHA256 = '7875c6a95417e0898aef28132c52212fa0efe337462946e2e2c18e4ee1f0c1b9';
export const DISPLAY_LOD_THRESHOLD = 100;
export { DISC_COLORS, DISC_COLOR_LIST, STANDARD_SETS, COLOR_SOURCE, COLOUR_SOURCE, colorName, colorHex } from './brainflakes-colors.mjs';
// Colours are catalogue ids (lib/brainflakes-colors.mjs): only real disc colours.
const colorOK=c=>typeof c==='string'&&Object.hasOwn(DISC_COLORS,c);
const clone = (x) => JSON.parse(JSON.stringify(x));
const slotOK = (s) => Number.isInteger(s) && s >= 0 && s < 8;
const determinant = (r) => r[0]*(r[4]*r[8]-r[5]*r[7])-r[1]*(r[3]*r[8]-r[5]*r[6])+r[2]*(r[3]*r[7]-r[4]*r[6]);
function rigid(p) {
  if (!p || !Array.isArray(p.r) || p.r.length !== 9 || !Array.isArray(p.t) || p.t.length !== 3 || ![...p.r, ...p.t].every(Number.isFinite)) return false;
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    let dot = 0; for (let k = 0; k < 3; k++) dot += p.r[k*3+a]*p.r[k*3+b];
    if (Math.abs(dot - (a === b ? 1 : 0)) > 1e-6) return false;
  }
  return Math.abs(determinant(p.r) - 1) < 1e-6;
}
export { rigid as isRigidPose };

// Sample the eight known CAD slot directions; reject inconsistent geometry.
// The outer envelope's root is a provisional reference, not a measured catch.
export function discDefinition(mesh) {
  const m = measureDisc(mesh), profile = radialProfile(mesh, 16), roots = profile.filter((_, i) => i % 2 === 0).map(p => p.radius);
  const root = roots.reduce((a,b) => a+b, 0) / 8;
  if (!(root > 0) || roots.some(r => Math.abs(r-root) > 0.05) || profile.some((p,i) => i % 2 === 1 && p.radius < root + 1) || m.thickness <= 0) throw new Error('Mesh does not match eight expected slot axes.');
  return { system: SYSTEM, slotRadius: root, midplane: (m.bounds.min[2]+m.bounds.max[2])/2, roots, measurements: m };
}

export function slotFrame(def, poseOrSlot, maybeSlot) {
  const hasPose = typeof poseOrSlot === 'object' && poseOrSlot !== null;
  const index = hasPose ? maybeSlot : poseOrSlot;
  if (def?.system !== SYSTEM || !slotOK(index) || !Number.isFinite(def.slotRadius) || !Number.isFinite(def.midplane)) throw new Error('Invalid disc definition or slot.');
  const a = spin([0,0,1], 45*index);
  const local = compose(a, { r: ID.r, t: [def.slotRadius, 0, def.midplane] });
  const frame = hasPose ? compose(poseOrSlot, local) : local;
  return { ...frame, origin: frame.t };
}

// Opposing radial axes and perpendicular disc planes, with notch roots aligned.
// This is a candidate, not a calibrated or collision-accepted connection.
const mate = (roll) => compose(spin([1,0,0], roll), spin([0,0,1], 180));
// Any roll of the source disc about the shared slot axis; only MATING_ROLLS seat.
export function rolledAttachmentPose(def, targetPose, targetSlot, sourceSlot, roll = 90) {
  if (!rigid(targetPose) || !Number.isFinite(roll)) throw new Error('Invalid target pose.');
  return compose(compose(compose(targetPose, slotFrame(def, targetSlot)), mate(roll)), inverse(slotFrame(def, sourceSlot)));
}
// Rolls that seat cleanly, derived from the mesh by
// scripts/derive-brainflakes-poses.mjs (every 15 degrees, press-fit check).
// Pose index i means roll MATING_ROLLS[i]. A geometric finding only.
export const MATING_ROLLS = Object.freeze([90, 270]);
export function attachmentPose(def, targetPose, targetSlot, sourceSlot, poseIndex = 0) {
  if (!Number.isInteger(poseIndex) || poseIndex < 0 || poseIndex >= MATING_ROLLS.length) throw new Error('Unknown mating pose.');
  return rolledAttachmentPose(def, targetPose, targetSlot, sourceSlot, MATING_ROLLS[poseIndex]);
}
// Every legal pose for a disc mated by its sourceSlot to targetSlot (pure).
export function matingPoses(def, targetPose, targetSlot, sourceSlot) {
  return MATING_ROLLS.map((roll, pose) => ({ pose, roll, targetSlot, sourceSlot, value: rolledAttachmentPose(def, targetPose, targetSlot, sourceSlot, roll) }));
}
// Which legal pose (if any) relates two placed discs through these slots.
export function matingPoseIndex(def, aPose, aSlot, bPose, bSlot, tol = 1e-4) {
  for (let i = 0; i < MATING_ROLLS.length; i++) if (near(attachmentPose(def, aPose, aSlot, bSlot, i), bPose, tol)) return i;
  return -1;
}

export function createAssembly(name = 'Brain Flakes design') {
  return { system: SYSTEM, version: 1, name, units: 'mm', discs: [], connections: [], provenance: { source: 'constructed', geometry: 'community CAD reconstruction', physicalVerification: 'not verified' }, validation: { status: 'not-run' } };
}
function part(model, id) { const p = model.discs.find(x => x.id === id); if (!p) throw new Error(`Unknown disc: ${id}`); return p; }
function free(model, id, slot) {
  if (!slotOK(slot)) throw new Error('Slot must be an integer from 0 to 7.');
  if (model.connections.some(e => (e.a.id === id && e.a.slot === slot) || (e.b.id === id && e.b.slot === slot))) throw new Error(`Slot ${id}:${slot} is occupied.`);
}
function changed(model) { model.validation = { status: 'not-run' }; }
export function addDisc(model, { id, color = 'yellow', pose = ID, position } = {}) {
  const actualPose = position ? { r: pose?.r ?? ID.r, t: [...position] } : pose;
  if (model.system !== SYSTEM || model.discs.length>=MAX_DISCS || typeof id !== 'string' || !id || id.length>80 || model.discs.some(x => x.id === id) || !colorOK(color) || !rigid(actualPose)) throw new Error(`Invalid or duplicate disc, colour not in the catalogue, or over the ${MAX_DISCS}-disc limit.`);
  model.discs.push({ id, color, pose: clone(actualPose) }); changed(model); return model.discs.at(-1);
}
export { addDisc as addRootDisc };
const LOOP_TOL = 1e-4; // mm and rotation entries; drift around closed loops
export function connectDiscs(model, def, a, b) {
  if (a.id === b.id) throw new Error('A disc cannot connect to itself.');
  const pa = part(model, a.id), pb = part(model, b.id);
  free(model, a.id, a.slot); free(model, b.id, b.slot);
  const mate = matingPoseIndex(def, pa.pose, a.slot, pb.pose, b.slot, LOOP_TOL);
  if (mate < 0) throw new Error('Those slots do not line up in a legal mating pose.');
  model.connections.push({ a: { id: a.id, slot: a.slot }, b: { id: b.id, slot: b.slot }, mate }); changed(model);
}
export function attachDisc(model, def, { id, color, to, slot, by = 0, mate = 0 }) {
  const target = part(model, to); free(model, to, slot);
  const p = addDisc(model, { id, color, pose: attachmentPose(def, target.pose, slot, by, mate) });
  try { connectDiscs(model, def, { id: to, slot }, { id, slot: by }); }
  catch (e) { model.discs.pop(); throw e; }
  return p;
}
export function occupiedSlots(model, id) {
  const s = new Set(); for (const e of model.connections) { if (e.a.id === id) s.add(e.a.slot); if (e.b.id === id) s.add(e.b.slot); } return s;
}
export function freeSlots(model, id) { const o = occupiedSlots(model, id); return [0,1,2,3,4,5,6,7].filter(s => !o.has(s)); }
// Free slot pairs that already line up in a legal pose between `id` and any
// other disc: the connections that close a loop. Pure; nothing is changed.
export function loopClosures(model, def, id, { tol = LOOP_TOL } = {}) {
  const d = part(model, id), mine = freeSlots(model, id), out = [];
  for (const o of model.discs) {
    if (o.id === id || Math.hypot(...o.pose.t.map((v, i) => v - d.pose.t[i])) > 2 * def.slotRadius + 8) continue;
    if (model.connections.some(e => (e.a.id === id && e.b.id === o.id) || (e.b.id === id && e.a.id === o.id))) continue;
    for (const s of mine) for (const t of freeSlots(model, o.id)) {
      const mate = matingPoseIndex(def, d.pose, s, o.pose, t, tol);
      if (mate >= 0) out.push({ a: { id, slot: s }, b: { id: o.id, slot: t }, mate });
    }
  }
  return out;
}
// Connect every loop closure for these discs; returns how many were added.
export function closeLoops(model, def, ids) {
  if (!def) return 0;
  const list = ids ?? model.discs.map((d) => d.id);
  let n = 0; for (const id of list) for (const c of loopClosures(model, def, id)) { try { connectDiscs(model, def, c.a, c.b); n++; } catch { /* slot taken by an earlier closure */ } } return n;
}
export function removeDisc(model, id) {
  part(model, id); model.discs = model.discs.filter(p => p.id !== id); model.connections = model.connections.filter(e => e.a.id !== id && e.b.id !== id); changed(model);
}
export function recolorDisc(model, id, color) { if (!colorOK(color)) throw new Error('Invalid color.'); part(model, id).color = color; changed(model); }
export function transformDisc(model, id, p) { if (!rigid(p)) throw new Error('Invalid pose.'); part(model, id).pose = clone(p); changed(model); }

// Validates the graph and the hypothesis; no rigid or deformable collision
// checking is implied by this result. Works on parsed, untrusted JSON too.
export function validateAssembly(model, def, { maxParts = Infinity, colors = null, inventory = null } = {}) {
  const errors = [], geometry = [], ids = new Map(), occupied = new Set();
  if (!model || model.system !== SYSTEM || model.version !== 1 || model.units !== 'mm' || !Array.isArray(model.discs) || !Array.isArray(model.connections) || model.discs.length>MAX_DISCS || model.connections.length>MAX_CONNECTIONS) throw new Error('Not a supported Brain Flakes assembly.');
  if (model.discs.length > maxParts) errors.push({ code: 'part-limit' });
  const counts = new Map();
  for (const p of model.discs) {
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length>80 || ids.has(p.id)) { errors.push({ code: 'duplicate-or-invalid-id' }); continue; }
    ids.set(p.id, p);
    if (!rigid(p.pose)) geometry.push({ code: 'invalid-pose', id: p.id });
    if (!colorOK(p.color) || (colors && !colors.includes(p.color))) errors.push({ code: 'color', id: p.id });
    counts.set(p.color, (counts.get(p.color) || 0) + 1);
  }
  if (inventory) for (const [color, count] of counts) if (count > (inventory[color] ?? 0)) errors.push({ code: 'inventory', color, count });
  const adjacency = new Map([...ids.keys()].map(id => [id, []]));
  for (const e of model.connections) {
    if (!e?.a || !e?.b || e.a.id === e.b.id || !ids.has(e.a.id) || !ids.has(e.b.id) || !slotOK(e.a.slot) || !slotOK(e.b.slot)) { errors.push({ code: 'invalid-edge' }); continue; }
    for (const end of [e.a, e.b]) { const k = JSON.stringify([end.id, end.slot]); if (occupied.has(k)) errors.push({ code: 'occupied-slot', id: end.id, slot: end.slot }); occupied.add(k); }
    adjacency.get(e.a.id).push(e.b.id); adjacency.get(e.b.id).push(e.a.id);
    const a = ids.get(e.a.id), b = ids.get(e.b.id);
    if (rigid(a.pose) && rigid(b.pose) && matingPoseIndex(def, a.pose, e.a.slot, b.pose, e.b.slot, LOOP_TOL) < 0) geometry.push({ code: 'inconsistent-connection', a: e.a, b: e.b });
  }
  let components = 0; const seen = new Set();
  for (const id of ids.keys()) if (!seen.has(id)) { components++; const todo = [id]; seen.add(id); while (todo.length) for (const n of adjacency.get(todo.pop())) if (!seen.has(n)) { seen.add(n); todo.push(n); } }
  if (components > 1) errors.push({ code: 'disconnected', components });
  return { graph: { valid: errors.length === 0, errors, components }, geometry: { constraintsConsistent: geometry.length === 0, valid: geometry.length ? false : null, errors: geometry, connectorModel: 'provisional' }, collision: { status: 'not-checked' }, stability: { status: 'not-checked' }, physical: { status: 'unverified', reason: 'Mating pose and snap-fit deformation are not calibrated.' } };
}
export function loadAssembly(json, def) {
  const model = typeof json === 'string' ? JSON.parse(json) : clone(json);
  model.validation = validateAssembly(model, def); return model;
}
