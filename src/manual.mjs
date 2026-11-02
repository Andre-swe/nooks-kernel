// Editing the manual by hand: rename a section, split or merge steps, move
// parts between steps, pin a step. Pure: no DOM. Every operation keeps the
// planner's rule (no part before what is under it) or refuses, with a
// reason; a pinned step is kept exactly as it is when the model is edited.
import { violations } from './planner.mjs';

const copy = (steps) => steps.map((s) => ({ ...s, parts: [...s.parts] }));
// Apply `steps` if the rules still hold: { ok, steps } or { ok: false, reason }.
function checked(model, steps, reason) {
  const bad = violations({ ...model, steps });
  return bad.length ? { ok: false, reason: `${reason} (${bad.length} part${bad.length > 1 ? 's' : ''} would come before what holds ${bad.length > 1 ? 'them' : 'it'})` } : { ok: true, steps };
}

// A section's new name, on its parts and its steps.
export function renameAssembly(model, from, to) {
  to = String(to ?? '').trim();
  if (!to || to === from) return { ok: false, reason: 'Give it a new name.' };
  if (model.steps.some((s) => s.assembly === to)) return { ok: false, reason: `There is already a section called ${to}.` };
  for (const p of model.parts) if (p.assembly === from) p.assembly = to;
  return { ok: true, steps: model.steps.map((s) => (s.assembly === from ? { ...s, assembly: to } : s)) };
}

// Step n (from 1) in two: its lower parts first, then the rest.
export function splitStep(model, n) {
  const steps = copy(model.steps), s = steps[n - 1];
  if (!s || s.attach || s.parts.length < 2) return { ok: false, reason: 'A step needs two parts or more to split.' };
  const byKey = new Map(model.parts.map((p) => [p.key, p]));
  const sorted = [...s.parts].sort((a, b) => byKey.get(a).y - byKey.get(b).y);
  const half = Math.ceil(sorted.length / 2);
  steps.splice(n - 1, 1, { ...s, parts: sorted.slice(0, half), edited: true }, { ...s, parts: sorted.slice(half), edited: true, pinned: false });
  return checked(model, steps, 'That split breaks the build order');
}

// Step n and the step after it as one.
export function mergeSteps(model, n) {
  const steps = copy(model.steps), a = steps[n - 1], b = steps[n];
  if (!a || !b) return { ok: false, reason: 'There is no next step to merge with.' };
  if (a.attach || b.attach) return { ok: false, reason: 'An attach step stays on its own.' };
  steps.splice(n - 1, 2, { ...a, parts: [...a.parts, ...b.parts], edited: true });
  return checked(model, steps, 'Those steps cannot be merged');
}

// Parts (by key) into step n.
export function moveParts(model, keys, n) {
  const steps = copy(model.steps), to = steps[n - 1];
  if (!to || to.attach) return { ok: false, reason: 'Pick a step with parts.' };
  const set = new Set(keys);
  for (const s of steps) s.parts = s.parts.filter((k) => !set.has(k));
  to.parts.push(...keys); to.edited = true;
  return checked(model, steps.filter((s) => s.parts.length || s.attach), `Step ${n} is too early for that part`);
}

// How step n sits in the printed booklet: `pageBreak` starts a new page at
// it, `big` gives it a page of its own (as a manual does for a big moment).
export function setStepLayout(model, n, layout = {}) {
  const steps = copy(model.steps);
  if (!steps[n - 1]) return { ok: false, reason: 'No such step.' };
  for (const k of ['pageBreak', 'big']) if (k in layout) steps[n - 1][k] = !!layout[k] || undefined;
  return { ok: true, steps };
}

// Pin or unpin step n: a pinned step keeps its parts through later edits.
export function pinStep(model, n, on = true) {
  const steps = copy(model.steps);
  if (!steps[n - 1]) return { ok: false, reason: 'No such step.' };
  steps[n - 1].pinned = on;
  return { ok: true, steps };
}
